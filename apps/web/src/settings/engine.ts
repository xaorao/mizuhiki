/**
 * Settings on this device (spec 5.17, ARCHITECTURE 8f): names on
 * MizuhikiRegistry, this browser's Web Push subscription, the export of
 * everything opened here into one zip, and deleting the page.
 */
import { decryptFile, utf8, type FileFacts } from "@mizuhiki/core";
import {
  claimNameOnChain,
  releaseNameOnChain,
  setPrimaryNameOnChain,
  closeWindow,
  readWindow,
  type EvmWindow,
} from "@mizuhiki/chain";
import { zip, type Zippable } from "fflate";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { openRow, type InboxRow, type Opened } from "@/inbox/model";
import { openPrivate, type InvoiceRecord } from "@/invoices/model";
import { listRooms, loadLines, readSummaries, withToken } from "@/rooms/engine";

export type Tokened = Account & { token: string };
const T = (a: Tokened) => ({ token: a.token });

// ---- names ----------------------------------------------------------------------------------------

export interface NameRow {
  name: string;
  primary: boolean;
  claimedTx: string;
}
export const myNames = (a: Tokened) => api.get<{ names: NameRow[]; pageName: string | null }>("/owner/names", T(a));
export const claimSecondName = (a: Account, name: string, onStage?: (s: "commit" | "wait" | "claim") => void) =>
  claimNameOnChain(a.owner, name, false, onStage);
export const makePrimary = (a: Account, name: string) => setPrimaryNameOnChain(a.owner, name);
export const releaseName = (a: Account, name: string) => releaseNameOnChain(a.owner, name);
/** Wait until the indexer has the change (it reads the registry every few seconds). */
export async function waitForNames(a: Tokened, ok: (r: { names: NameRow[] }) => boolean): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (ok(await myNames(a))) return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error("QoreChain has the change, but this page has not caught up yet. Reload in a minute.");
}

// ---- the access window ----------------------------------------------------------------------------

export const myWindow = (a: Account): Promise<EvmWindow> => readWindow(a.owner.address);
export const closeMyWindow = (a: Account) => closeWindow(a.owner);

// ---- Web Push -------------------------------------------------------------------------------------

export type PushType = "items" | "payments" | "orders" | "rooms" | "access" | "recovery" | "checkin";
export interface NotifySettings {
  enabled: boolean;
  prefs: Record<PushType, boolean>;
  browsers: { endpoint: string; createdAt: string }[];
}
export const notifySettings = (a: Tokened) => api.get<NotifySettings>("/owner/notifications", T(a));
export const savePrefs = (a: Tokened, prefs: Partial<Record<PushType, boolean>>) =>
  api.put("/owner/notifications", { prefs }, T(a));

export type PushSupport = "ready" | "unsupported" | "denied";
export function pushSupport(): PushSupport {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  )
    return "unsupported";
  return Notification.permission === "denied" ? "denied" : "ready";
}

const b64uToBytes = (s: string) => {
  const b = atob(
    s
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(s.length / 4) * 4, "="),
  );
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** This browser's current subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() === "unsupported") return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** Ask for permission, subscribe this browser with the server's VAPID key, and register it. */
export async function enablePush(a: Tokened): Promise<void> {
  if (pushSupport() === "unsupported") throw new Error("This browser cannot show notifications.");
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.",
    );
  const { publicKey } = await api.get<{ publicKey: string }>("/push/key");
  const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(publicKey) }));
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  await api.put("/owner/push", { endpoint: json.endpoint, keys: json.keys }, T(a));
}

export async function disablePush(a: Tokened): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.del("/owner/push", T(a), { endpoint: sub.endpoint });
  await sub.unsubscribe();
}
export const testPush = (a: Tokened) => api.post<{ delivered: number }>("/owner/push/test", {}, T(a));

// ---- export everything ----------------------------------------------------------------------------

export type ExportStep = { label: string; done: number; total: number };

const safe = (s: string) => s.replace(/[^A-Za-z0-9._ -]+/g, "_").slice(0, 80) || "file";

async function fileBytes(f: FileFacts): Promise<Uint8Array> {
  const parts = await decryptFile({ facts: f, fetchChunk: (h) => api.bytes(`/blobs/${h}`) });
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/**
 * Open everything this account can open, on this device, and put it in one zip: the page, inbox items (with
 * their files), invoices, rooms' messages (with files), and the lists of passes, capsules and recovery
 * contacts. Nothing is sent anywhere; the zip is saved by the browser.
 */
export async function exportEverything(
  a: Tokened,
  manifest: unknown,
  onStep: (s: ExportStep) => void,
): Promise<{ bytes: Uint8Array; skipped: number }> {
  const files: Zippable = {};
  let skipped = 0;
  const put = (path: string, data: Uint8Array | string) => {
    files[path] = typeof data === "string" ? utf8(data) : data;
  };
  put("README.txt", "Exported from Mizuhiki on this device. Everything here was opened locally; keep it private.\n");
  put("page.json", JSON.stringify(manifest, null, 2));

  // Inbox (both boxes), opened with this account's key.
  const rows: InboxRow[] = [];
  for (const box of ["inbox", "archived"] as const) {
    let before: string | undefined;
    for (;;) {
      const page = (
        await api.get<{ rows: InboxRow[] }>(
          `/owner/inbox?box=${box}&limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`,
          T(a),
        )
      ).rows;
      rows.push(...page);
      if (page.length < 200) break;
      before = page[page.length - 1]?.at;
    }
  }
  const items = rows.filter((r) => r.type === "envelope" && r.envelope);
  for (const [i, r] of items.entries()) {
    onStep({ label: "Opening inbox items", done: i, total: items.length });
    try {
      const o: Opened = await openRow(a, r);
      const dir = `inbox/${r.at.slice(0, 10)}-${r.kind}-${(r.envelope ?? "").slice(0, 8)}`;
      put(`${dir}/item.json`, JSON.stringify({ type: r.kind, at: r.at, sender: r.sender, ...o }, null, 2));
      const list = o.kind === "message" ? o.files : o.kind === "form" ? Object.values(o.files).flat() : [];
      for (const f of list) {
        try {
          put(`${dir}/${safe(f.name)}`, await fileBytes(f));
        } catch {
          skipped++;
        }
      }
    } catch {
      skipped++;
    }
  }
  for (const p of rows.filter((r) => r.payment))
    put(
      `payments/${p.at.slice(0, 10)}-${(p.payment?.txHash ?? "").slice(0, 10)}.json`,
      JSON.stringify(p.payment, null, 2),
    );

  // Invoices (the owner's private copies).
  const { invoices } = await api.get<{ invoices: InvoiceRecord[] }>("/owner/invoices", T(a));
  for (const [i, rec] of invoices.entries()) {
    onStep({ label: "Opening invoices", done: i, total: invoices.length });
    try {
      const copy = openPrivate(a, rec.id, await api.bytes(`/blobs/${rec.privateEnvelope}`));
      put(`invoices/${safe(copy.doc.number)}-${rec.id}.json`, JSON.stringify({ state: rec.state, ...copy }, null, 2));
    } catch {
      skipped++;
    }
  }

  // Rooms: every message this device can open.
  const t = withToken(a, a.token);
  const { rooms } = await listRooms(t);
  const sums = await readSummaries(a);
  for (const [i, r] of rooms.entries()) {
    onStep({ label: "Opening rooms", done: i, total: rooms.length });
    try {
      const lines = await loadLines(t, r.id);
      const name = safe(sums[r.id]?.name ?? r.id);
      const opened = lines.flatMap((l) =>
        l.msg ? [{ at: l.msg.sentAt, author: l.msg.author, body: l.msg.body }] : [],
      );
      put(`rooms/${name}/messages.json`, JSON.stringify(opened, null, 2));
      for (const m of opened) {
        const f = (m.body as { file?: FileFacts }).file;
        if (!f) continue;
        try {
          put(`rooms/${name}/${safe(f.name)}`, await fileBytes(f));
        } catch {
          skipped++;
        }
      }
    } catch {
      skipped++;
    }
  }

  // Lists (metadata only).
  for (const [path, url] of [
    ["passes.json", "/owner/passes"],
    ["capsules.json", "/owner/capsules"],
    ["recovery.json", "/owner/recovery"],
  ] as const) {
    try {
      put(path, JSON.stringify(await api.get(url, T(a)), null, 2));
    } catch {
      skipped++;
    }
  }
  onStep({ label: "Packing the zip", done: 0, total: 1 });
  const bytes = await new Promise<Uint8Array>((res, rej) =>
    zip(files, { level: 6 }, (err, out) => (err ? rej(err) : res(out))),
  );
  return { bytes, skipped };
}

export const deletePage = (a: Tokened) =>
  api.del<{ ok: true; removed: number }>("/owner/page", T(a), { confirm: "delete my page" });
