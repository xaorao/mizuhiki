/**
 * Opening inbox items on this device, and the encrypted local cache of what
 * has been opened (so search runs locally and reopening is instant). The cache
 * key is derived from the owner's own sealing seed with HKDF, so the cached
 * plaintext is unreadable without the unlocked account.
 */
import { Purpose, ab, fromUtf8, openItem, randomBytes, utf8, type AnswerValue, type FileFacts } from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { idb } from "@/lib/idb";

export interface InboxRow {
  id: string;
  type: "envelope" | "payment" | "request";
  kind: string;
  envelope: string | null;
  size: number;
  readers: number;
  at: string;
  read: boolean;
  archived: boolean;
  ref: string | null;
  sender: { address: string; name: string | null; how: "signed" | "payment" | "request" } | null;
  /** The sender's signature record; checked again on this device against QoreChain. */
  senderSig: unknown;
  /** For sent items: who it went to. */
  to: { address: string; name: string | null } | null;
  payment: { txHash: string; denom: string; amount: string; memo: string } | null;
  expiresAt: string | null;
}

export interface OpenedMessage {
  kind: "message";
  text: string;
  contact: string;
  files: FileFacts[];
  sentAt: string;
  from?: string;
  inReplyTo?: string;
  quote?: string;
  forwardedBy?: string;
  originalFrom?: string;
  forwardNote?: string;
  link?: string;
}

export interface OpenedNote {
  kind: "paynote";
  note: string;
  from?: string;
}

export interface OpenedForm {
  kind: "form";
  formId: string;
  formVersion: number;
  answers: Record<string, AnswerValue>;
  files: Record<string, FileFacts[]>;
  ending: string;
  submittedAt: string;
}

export type Opened = OpenedMessage | OpenedNote | OpenedForm;

const PURPOSE_BY_KIND: Record<string, string> = {
  message: Purpose.message,
  reply: Purpose.message,
  invoice: Purpose.message,
  paynote: Purpose.payNote,
  payment: Purpose.payNote,
};

export function purposeFor(row: InboxRow): string | undefined {
  if (row.kind === "form") {
    const id = /^form:([A-Za-z0-9_-]{1,40})$/.exec(row.ref ?? "")?.[1];
    return id ? Purpose.form(id) : undefined;
  }
  return PURPOSE_BY_KIND[row.kind];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Fetch an envelope and open it here. Throws MizuhikiError with a plain message on failure. */
export async function openRow(account: Account, row: InboxRow): Promise<Opened> {
  if (!row.envelope) throw new Error("This item has no sealed part.");
  const purpose = purposeFor(row);
  if (!purpose) throw new Error("This kind of item opens in its own section.");
  const bytes = await api.bytes(`/blobs/${row.envelope}`);
  const plain = openItem({ purpose, envelope: bytes, keys: account.keys.seal });
  const json = JSON.parse(fromUtf8(plain)) as Record<string, unknown>;
  if (row.kind === "form") {
    const formId = /^form:([A-Za-z0-9_-]{1,40})$/.exec(row.ref ?? "")?.[1] ?? "";
    return {
      kind: "form",
      formId,
      formVersion: typeof json.formVersion === "number" ? json.formVersion : 0,
      answers: (json.answers ?? {}) as Record<string, AnswerValue>,
      files: (json.files ?? {}) as Record<string, FileFacts[]>,
      ending: str(json.ending),
      submittedAt: str(json.submittedAt) || row.at,
    };
  }
  if (purpose === Purpose.payNote)
    return {
      kind: "paynote",
      note: str(json.note),
      ...(typeof json.from === "string" ? { from: json.from } : {}),
    };
  return {
    kind: "message",
    text: str(json.text),
    contact: str(json.contact),
    files: Array.isArray(json.files) ? (json.files as FileFacts[]) : [],
    sentAt: str(json.sentAt) || row.at,
    ...(typeof json.from === "string" ? { from: json.from } : {}),
    ...(typeof json.inReplyTo === "string" ? { inReplyTo: json.inReplyTo } : {}),
    ...(typeof json.quote === "string" ? { quote: json.quote } : {}),
    ...(typeof json.forwardedBy === "string" ? { forwardedBy: json.forwardedBy } : {}),
    ...(typeof json.originalFrom === "string" ? { originalFrom: json.originalFrom } : {}),
    ...(typeof json.forwardNote === "string" ? { forwardNote: json.forwardNote } : {}),
    ...(typeof json.link === "string" ? { link: json.link } : {}),
  };
}

// ---- encrypted local cache --------------------------------------------------

async function cacheKey(account: Account): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", ab(account.keys.seal.seed), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ab(utf8("mzk:inbox-cache:v1")), info: ab(utf8(account.owner.address)) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const storeKey = (a: Account) => `inbox-cache:${a.owner.address}`;

export async function readCache(account: Account): Promise<Record<string, Opened>> {
  const blob = await idb.get<{ iv: Uint8Array; ct: Uint8Array }>(storeKey(account)).catch(() => undefined);
  if (!blob) return {};
  try {
    const key = await cacheKey(account);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(blob.iv) }, key, ab(blob.ct));
    return JSON.parse(new TextDecoder().decode(pt)) as Record<string, Opened>;
  } catch {
    return {};
  }
}

export async function writeCache(account: Account, data: Record<string, Opened>): Promise<void> {
  const key = await cacheKey(account);
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, key, ab(utf8(JSON.stringify(data)))),
  );
  await idb.set(storeKey(account), { iv, ct });
}

export function searchText(o: Opened): string {
  if (o.kind === "form") return Object.values(o.answers).flat().join(" ");
  return o.kind === "message" ? `${o.text} ${o.contact} ${o.files.map((f) => f.name).join(" ")}` : o.note;
}

export const TYPE_LABEL: Record<string, string> = {
  message: "Message",
  reply: "Reply",
  file: "File",
  payment: "Payment",
  "invoice-payment": "Invoice",
  invoice: "Invoice",
  form: "Form answer",
  order: "Order",
  request: "Room request",
  paynote: "Payment",
};
