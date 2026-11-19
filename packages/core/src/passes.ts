/**
 * Passes (spec 5.12, ARCHITECTURE 8c): scoped, read-only access for an
 * accountant or auditor. A pass names its holder and one scope (a period of
 * some kinds of items, one room, one form or one product); the owner signs the
 * invite, the holder signs the acceptance, and the owner confirms by comparing
 * safety words before any key is shared.
 */
import { z } from "zod";
import type { SealRecipient } from "@qorechain/qoreseal";
import { fromHex } from "./bytes";
import type { Manifest } from "./manifest";

export const PERIOD_KINDS = ["messages", "payments", "forms", "invoices"] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];
export const PERIOD_KIND_LABEL: Record<PeriodKind, string> = {
  messages: "messages and files",
  payments: "payment notes",
  forms: "form answers",
  invoices: "invoices",
};

const id = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/);
const addr = z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/);

export const PassScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("period"),
    /** Items dated in [from, until). */
    from: z.iso.datetime(),
    until: z.iso.datetime(),
    kinds: z.array(z.enum(PERIOD_KINDS)).min(1).max(4),
    /** The scoped key's index, from 2,000,000 up (one per pass). */
    keyIndex: z.number().int().min(2_000_000).max(2_999_999),
  }),
  z.object({ kind: z.literal("room"), roomId: id, label: z.string().max(80) }),
  z.object({ kind: z.literal("form"), formId: id, label: z.string().max(120) }),
  z.object({ kind: z.literal("product"), productId: id, label: z.string().max(120) }),
]);
export type PassScope = z.infer<typeof PassScopeSchema>;

export const PassInviteSchema = z.object({
  v: z.literal(1),
  type: z.literal("invite"),
  id,
  owner: addr,
  holder: addr,
  scope: PassScopeSchema,
  /** When the pass stops covering new items (null: until revoked). */
  expiresAt: z.iso.datetime().nullable(),
  /** The boundary in plain words, exactly as both people saw it. */
  boundary: z.string().min(1).max(600),
  note: z.string().max(500).default(""),
  createdAt: z.iso.datetime(),
});
export type PassInvite = z.infer<typeof PassInviteSchema>;

export const PassAcceptSchema = z.object({ v: z.literal(1), type: z.literal("accept"), id, holder: addr, at: z.iso.datetime() });
export type PassAccept = z.infer<typeof PassAcceptSchema>;

/** The scoped key index of a period pass: one per pass, never shared between holders. */
export const passKeyIndex = (n: number): number => {
  if (!Number.isInteger(n) || n < 0 || n > 999_999) throw new Error("pass number out of range");
  return 2_000_000 + n;
};

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The boundary, in plain words, for the invite and every place the pass is shown. */
export function boundaryText(scope: PassScope, expiresAt: string | null): string {
  // The last day covered, in UTC like the period (an expiry at midnight means the day before is the last one).
  const lasts = expiresAt ? ` New items are covered through ${fmtDate(new Date(Date.parse(expiresAt) - 1).toISOString())}.` : "";
  switch (scope.kind) {
    case "period": {
      const last = new Date(new Date(scope.until).getTime() - 1).toISOString();
      const kinds = scope.kinds.map((k) => PERIOD_KIND_LABEL[k]);
      const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1) ?? ""}` : (kinds[0] ?? "");
      return `Can read: ${list}, ${fmtDate(scope.from)} to ${fmtDate(last)}. Cannot read anything else. Cannot change anything.${lasts}`;
    }
    case "room":
      return `Can read: the room “${scope.label}”, including its past messages. Cannot send, add people or change anything. Cannot read anything else.${lasts}`;
    case "form":
      return `Can read: the answers to the form “${scope.label}”. Cannot change the form. Cannot read anything else.${lasts}`;
    case "product":
      return `Can read: the product “${scope.label}” (what buyers get). Cannot change it or see sales. Cannot read anything else.${lasts}`;
  }
}

/** A quarter as a period: [first day, first day of the next quarter), UTC. */
export function quarterPeriod(year: number, quarter: 1 | 2 | 3 | 4): { from: string; until: string } {
  const from = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  const until = new Date(Date.UTC(year, quarter * 3, 1));
  return { from: from.toISOString(), until: until.toISOString() };
}

/**
 * The pass keys a sender must also seal to, from the owner's signed manifest:
 * those covering this kind of item at this moment.
 */
export function passReaders(m: Pick<Manifest, "periodKeys">, kind: PeriodKind, at: Date = new Date()): SealRecipient[] {
  const t = at.getTime();
  return m.periodKeys
    .filter((k) => k.kinds?.includes(kind) && k.from && k.until && Date.parse(k.from) <= t && t < Date.parse(k.until))
    .map((k) => ({ mlkemPublicKey: fromHex(k.mlkem), x25519PublicKey: fromHex(k.x25519) }));
}
