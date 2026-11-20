/**
 * Capsules (spec 5.14, ARCHITECTURE 8e): the signed plan whose hash is kept by
 * CapsuleVault, the guardian handshake, and the plain sentences the owner
 * confirms. Contents and pieces are sealed elsewhere; this module only says
 * what the plan is.
 */
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { canonicalJson } from "./canonical";
import { utf8 } from "./bytes";

const addr = z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
/** A capsule id is a bytes32 (the contract's key), written as 64 hex characters. */
export const CapsuleIdSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const CAPSULE_MODES = ["at-time", "after-wait", "if-quiet"] as const;
export type CapsuleMode = (typeof CAPSULE_MODES)[number];
/** The contract's Mode enum order. */
export const MODE_INDEX: Record<CapsuleMode, 0 | 1 | 2> = { "at-time": 0, "after-wait": 1, "if-quiet": 2 };

export const CapsuleInviteSchema = z.object({
  v: z.literal(1),
  type: z.literal("guardian-invite"),
  capsule: CapsuleIdSchema,
  owner: addr,
  guardian: addr,
  label: z.string().min(1).max(80),
  at: z.iso.datetime(),
});
export type CapsuleInvite = z.infer<typeof CapsuleInviteSchema>;

export const CapsuleAcceptSchema = z.object({
  v: z.literal(1),
  type: z.literal("guardian-accept"),
  capsule: CapsuleIdSchema,
  owner: addr,
  guardian: addr,
  at: z.iso.datetime(),
});
export type CapsuleAccept = z.infer<typeof CapsuleAcceptSchema>;

export const CapsulePlanSchema = z.object({
  v: z.literal(1),
  id: CapsuleIdSchema,
  owner: addr,
  /** Shown to guardians and recipients before release, so they know what they are holding. */
  label: z.string().min(1).max(80),
  mode: z.enum(CAPSULE_MODES),
  /** Seconds since the epoch (at-time), and periods in seconds. */
  releaseAt: z.number().int().min(0),
  waitSeconds: z.number().int().min(0),
  quietSeconds: z.number().int().min(0),
  /** How long recipients may collect after release; guardians stop re-sealing after it. */
  accessSeconds: z
    .number()
    .int()
    .min(3600)
    .max(5 * 365 * 86400),
  guardians: z.array(addr).min(1).max(16),
  threshold: z.number().int().min(1).max(16),
  recipients: z
    .array(z.object({ address: addr, content: hash, files: z.number().int().min(0).max(100) }))
    .min(1)
    .max(10),
  /** Piece (guardian, recipient), sealed to the guardian. */
  pieces: z
    .array(z.object({ guardian: addr, recipient: addr, envelope: hash }))
    .min(1)
    .max(160),
  /** Delete the sealed copies when the access window ends (off by default). */
  deleteAfter: z.boolean(),
  version: z.number().int().min(1),
  at: z.iso.datetime(),
});
export type CapsulePlan = z.infer<typeof CapsulePlanSchema>;

/** The hash CapsuleVault keeps: SHA-256 of the plan body in canonical form, as 0x-prefixed bytes32. */
export function planHash(plan: CapsulePlan): `0x${string}` {
  return `0x${bytesToHex(sha256(utf8(canonicalJson(plan))))}`;
}

/** Every recipient has one piece from every guardian; nothing else is in the plan. */
export function planProblems(p: CapsulePlan): string[] {
  const out: string[] = [];
  if (p.threshold > p.guardians.length) out.push("More guardians are needed than there are.");
  if (new Set(p.guardians).size !== p.guardians.length) out.push("A guardian is listed twice.");
  if (p.guardians.includes(p.owner)) out.push("You cannot be your own guardian.");
  if (new Set(p.recipients.map((r) => r.address)).size !== p.recipients.length)
    out.push("A recipient is listed twice.");
  for (const r of p.recipients)
    for (const g of p.guardians)
      if (p.pieces.filter((x) => x.guardian === g && x.recipient === r.address).length !== 1)
        out.push("Each guardian needs exactly one piece for each recipient.");
  if (p.pieces.length !== p.guardians.length * p.recipients.length)
    out.push("The plan has pieces for people who are not in it.");
  if (p.mode === "at-time" && p.releaseAt === 0) out.push("Choose when it opens.");
  if (p.mode === "after-wait" && (p.waitSeconds < 3600 || p.waitSeconds > 365 * 86400))
    out.push("The wait must be between one hour and a year.");
  if (p.mode === "if-quiet" && (p.quietSeconds < 86400 || p.quietSeconds > 5 * 365 * 86400))
    out.push("The quiet period must be between a day and five years.");
  return [...new Set(out)];
}

const DAY = 86400;
export const WAIT_PRESETS = [7, 14, 30, 60].map((d) => ({ days: d, seconds: d * DAY, label: `${d} days` }));
export const QUIET_PRESETS = [3, 6, 12, 18].map((m) => ({
  months: m,
  seconds: Math.round(m * 30.4375 * DAY),
  label: `${m} months`,
}));
export const ACCESS_PRESETS = [
  { seconds: 30 * DAY, label: "30 days" },
  { seconds: 90 * DAY, label: "90 days" },
  { seconds: 365 * DAY, label: "1 year" },
];

/** Google's lead time: a longer quiet period is warned about earlier. */
export function warnLeadSeconds(quietSeconds: number): number {
  if (quietSeconds <= 4 * 30 * DAY) return 30 * DAY;
  if (quietSeconds <= 7 * 30 * DAY) return 60 * DAY;
  return 90 * DAY;
}

function span(seconds: number): string {
  const days = seconds / DAY;
  // Whole years of 365 days (the access presets), then months of 30.4375 days (the quiet presets).
  if (seconds % (365 * DAY) === 0 && days >= 365) return days === 365 ? "1 year" : `${days / 365} years`;
  const months = Math.round(days / 30.4375);
  if (days >= 60 && Math.abs(months * 30.4375 - days) < 1) return `${months} months`;
  if (days >= 1) return Math.round(days) === 1 ? "1 day" : `${Math.round(days)} days`;
  const hours = Math.round(seconds / 3600);
  return hours === 1 ? "1 hour" : `${hours} hours`;
}
export const durationText = span;

function list(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}` : (names[0] ?? "");
}

/** The plan in plain sentences, for the Confirm step and every place the plan is shown. */
export function planSentences(
  p: Pick<
    CapsulePlan,
    "mode" | "releaseAt" | "waitSeconds" | "quietSeconds" | "accessSeconds" | "threshold" | "deleteAfter"
  > & { guardians: string[]; recipients: string[] },
): string[] {
  const who = list(p.recipients);
  const when =
    p.mode === "at-time"
      ? `On ${new Date(p.releaseAt * 1000).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}, ${who} will be able to open what you chose for them.`
      : p.mode === "after-wait"
        ? `If a guardian asks for it, ${who} will be able to open what you chose for them ${span(p.waitSeconds)} later, unless you say no first.`
        : `If you don't check in for ${span(p.quietSeconds)}, ${who} will be able to open what you chose for them.`;
  const guard =
    p.guardians.length === 1
      ? `${p.guardians[0] ?? ""} holds the key pieces and hands them over at that time.`
      : `${list(p.guardians)} each hold a key piece; any ${p.threshold} of them hand it over at that time.`;
  const access = `They can collect it for ${span(p.accessSeconds)} after it opens.${p.deleteAfter ? " Then the sealed copies are deleted." : ""}`;
  const out = [when, guard, access];
  if (p.mode === "if-quiet")
    out.push(
      `We remind you from ${span(warnLeadSeconds(p.quietSeconds))} before the time is up, every time you open Mizuhiki.`,
    );
  return out;
}
