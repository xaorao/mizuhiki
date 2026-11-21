/** Words and states for Passes (spec 5.12). Pure, so they are unit tested. */
import { isOpenEnded, quarterPeriod, toHex, type Manifest, type PassScope, type PeriodKind } from "@mizuhiki/core";
import { deriveSealKeys } from "@qorechain/qoreseal";
import type { Status } from "@mizuhiki/ui";
import type { PassStatus, PassView } from "./engine";

type WithPhrase = { keys: { phrase: string } };

/** Status chips, from both sides of the pass (QuickBooks "Invited/Active", Bitwarden "Needs confirmation"). */
export function chipOf(p: Pick<PassView, "status">, side: "owner" | "holder"): { status: Status; label: string } {
  const map: Record<PassStatus, { status: Status; label: string }> = {
    invited: { status: "wait", label: side === "owner" ? "Invited" : "Waiting for you" },
    accepted: { status: "info", label: side === "owner" ? "Needs confirmation" : "Waiting for the owner" },
    active: { status: "ok", label: "Active" },
    expired: { status: "neutral", label: "Expired" },
    revoked: { status: "danger", label: "Revoked" },
    declined: { status: "neutral", label: "Declined" },
  };
  return map[p.status];
}

/** Short scope line for lists: "Invoices and payment notes · Q3 2026". */
export function scopeLine(s: PassScope): string {
  if (s.kind === "room") return `Room · ${s.label}`;
  if (s.kind === "form") return `Form answers · ${s.label}`;
  if (s.kind === "product") return `Product · ${s.label}`;
  const words: Record<PeriodKind, string> = {
    messages: "Messages",
    payments: "Payment notes",
    forms: "Form answers",
    invoices: "Invoices",
  };
  const list = s.kinds.map((k, i) => (i === 0 ? words[k] : words[k].toLowerCase()));
  const kinds = list.length > 1 ? `${list.slice(0, -1).join(", ")} and ${list.at(-1) ?? ""}` : (list[0] ?? "");
  return `${kinds} · ${periodLabel(s.from, s.until)}`;
}

/** "Q3 2026" when the window is exactly a quarter, else "1 Jul 2026 – 30 Sep 2026". */
export function periodLabel(from: string, until: string): string {
  const f = new Date(from);
  if (isOpenEnded(until))
    return `from ${f.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} on`;
  const y = f.getUTCFullYear();
  for (const q of [1, 2, 3, 4] as const) {
    const p = quarterPeriod(y, q);
    if (p.from === new Date(from).toISOString() && p.until === new Date(until).toISOString()) return `Q${q} ${y}`;
  }
  const d = (x: Date) =>
    x.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${d(f)} – ${d(new Date(Date.parse(until) - 1))}`;
}

/** The quarters to offer: this one and the seven before it, newest first. */
export function recentQuarters(now = new Date()): { year: number; q: 1 | 2 | 3 | 4; label: string }[] {
  let year = now.getUTCFullYear();
  let q = (Math.floor(now.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  const out: { year: number; q: 1 | 2 | 3 | 4; label: string }[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ year, q, label: `Q${q} ${year}` });
    if (q === 1) {
      q = 4;
      year--;
    } else q = (q - 1) as 1 | 2 | 3 | 4;
  }
  return out;
}

export type Lasts = "period" | "30d" | "90d" | "1y" | "revoke";
export const LASTS: { value: Lasts; label: string }[] = [
  { value: "period", label: "Until the period ends" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "1y", label: "1 year" },
  { value: "revoke", label: "Until I revoke it" },
];

/**
 * When the pass stops covering new items. A period pass "until the period ends"
 * expires at the period's end; a past period has nothing new, so it lasts until
 * revoked. Other scopes have no period end and use the fallback.
 */
export function expiryOf(lasts: Lasts, scope: { kind: string; until?: string }, now = Date.now()): string | null {
  const day = 86_400_000;
  if (lasts === "30d") return new Date(now + 30 * day).toISOString();
  if (lasts === "90d") return new Date(now + 90 * day).toISOString();
  if (lasts === "1y") return new Date(now + 365 * day).toISOString();
  if (lasts === "period" && scope.kind === "period" && scope.until && Date.parse(scope.until) > now) return scope.until;
  return null;
}

/** Validate an @name or a QoreChain address before looking it up. */
export function personProblem(input: string): string | null {
  const raw = input.trim();
  if (!raw) return "Say who the pass is for.";
  if (/^qor1/.test(raw))
    return /^qor1[02-9ac-hj-np-z]{38}$/.test(raw) ? null : "That address is not complete. Check it and try again.";
  return /^@?[a-z0-9._-]{3,30}$/i.test(raw) ? null : "Use their @name or their qor1… address.";
}

/** Live passes give the page its period keys; called by every page publish. */
/** The offline reader key from the spare-key settings (spec 5.13), listed beside pass keys. */
export interface OfflineKey {
  mlkem: string;
  x25519: string;
  since: string;
}

export function periodKeysOf(
  account: WithPhrase,
  passes: PassView[],
  now = Date.now(),
  offline: OfflineKey | null = null,
): Manifest["periodKeys"] {
  const out: Manifest["periodKeys"] = [];
  for (const p of passes) {
    const scope = p.invite.body.scope;
    if (p.status !== "active" || scope.kind !== "period") continue;
    const until = Math.min(Date.parse(scope.until), p.expiresAt ? Date.parse(p.expiresAt) : Infinity);
    if (until <= now) continue;
    const k = deriveSealKeys({ mnemonic: account.keys.phrase, index: scope.keyIndex });
    out.push({
      label: `Pass ${p.id.slice(5, 11)}`,
      index: scope.keyIndex,
      mlkem: toHex(k.mlkemPublicKey),
      x25519: toHex(k.x25519PublicKey),
      passId: p.id,
      from: scope.from,
      until: new Date(until).toISOString(),
      kinds: scope.kinds,
    });
  }
  const passKeys = out.slice(0, 16);
  if (offline)
    passKeys.push({
      label: "Offline reader",
      // Not from the phrase: a separate random key printed on its own sheet.
      index: -1,
      mlkem: offline.mlkem,
      x25519: offline.x25519,
      from: offline.since,
      until: "2999-12-31T00:00:00.000Z",
      kinds: ["messages", "payments", "forms"],
    });
  return passKeys;
}

const KIND_OF: Record<string, PeriodKind> = {
  message: "messages",
  reply: "messages",
  paynote: "payments",
  form: "forms",
};

/** Does this active pass cover this kind of item? */
export function covers(p: PassView, row: { kind: string; ref: string | null }): boolean {
  const sc = p.invite.body.scope;
  if (p.status !== "active") return false;
  if (sc.kind === "period") {
    const k = KIND_OF[row.kind];
    return k !== undefined && sc.kinds.includes(k);
  }
  return sc.kind === "form" && row.kind === "form" && row.ref === `form:${sc.formId}`;
}
