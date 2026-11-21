/**
 * Room info rules worked out on this device: who may do what to whom (the
 * engine and the relay enforce the same rules; these decide what to show and
 * what to explain), auto-delete choices, member and file filters, and the
 * ownership-transfer gate. Pure functions, unit-tested.
 */
import { normalizeNameInput } from "@mizuhiki/core";
import { durationLabel, type SharedFile } from "../derive";
import type { MemberRow } from "../engine";

// ---- auto-delete -------------------------------------------------------------------------

export type AutoChoice = "off" | "day" | "week" | "month" | "custom";
export const AUTO_PRESETS: { value: Exclude<AutoChoice, "custom">; seconds: number; label: string }[] = [
  { value: "off", seconds: 0, label: "Off" },
  { value: "day", seconds: 86_400, label: "1 day" },
  { value: "week", seconds: 604_800, label: "1 week" },
  { value: "month", seconds: 2_592_000, label: "1 month" },
];
/** The relay's limit (one year). */
export const AUTO_MAX_SECONDS = 31_536_000;
export type CustomUnit = "hours" | "days" | "weeks";
export const UNIT_SECONDS: Record<CustomUnit, number> = { hours: 3600, days: 86_400, weeks: 604_800 };

export function autoDeleteChoice(seconds: number): AutoChoice {
  return AUTO_PRESETS.find((p) => p.seconds === seconds)?.value ?? "custom";
}

/** A custom value split back into the biggest whole unit, to prefill the custom field. */
export function splitCustom(seconds: number): { amount: string; unit: CustomUnit } {
  if (seconds > 0 && seconds % UNIT_SECONDS.weeks === 0)
    return { amount: String(seconds / UNIT_SECONDS.weeks), unit: "weeks" };
  if (seconds > 0 && seconds % UNIT_SECONDS.days === 0)
    return { amount: String(seconds / UNIT_SECONDS.days), unit: "days" };
  if (seconds > 0) return { amount: String(Math.max(1, Math.round(seconds / UNIT_SECONDS.hours))), unit: "hours" };
  return { amount: "2", unit: "days" };
}

export function customSeconds(amount: string, unit: CustomUnit): { seconds: number } | { error: string } {
  const t = amount.trim();
  if (!/^\d{1,4}$/.test(t) || Number(t) < 1) return { error: "Type a whole number, 1 or more." };
  const seconds = Number(t) * UNIT_SECONDS[unit];
  if (seconds > AUTO_MAX_SECONDS) return { error: "The longest is 365 days." };
  return { seconds };
}

export const autoDeleteText = (seconds: number): string => (seconds > 0 ? `After ${durationLabel(seconds)}` : "Off");

// ---- members -----------------------------------------------------------------------------

const RANK: Record<MemberRow["role"], number> = { owner: 0, admin: 1, member: 2 };

/** Owner first, then admins, then members; each group in the order they joined. */
export function sortMembers(rows: MemberRow[]): MemberRow[] {
  return [...rows].sort((a, b) => RANK[a.role] - RANK[b.role] || a.joinedAt.localeCompare(b.joinedAt));
}

/** Search by @name or any part of the address. */
export function matchesQuery(address: string, name: string | null | undefined, query: string): boolean {
  const q = query.trim().toLowerCase().replace(/^@/, "");
  if (!q) return true;
  return address.toLowerCase().includes(q) || (name ?? "").toLowerCase().includes(q);
}

export const isAdminRole = (m: MemberRow | undefined): boolean =>
  !!m && m.status === "active" && (m.role === "owner" || m.role === "admin");

export type Check = { allowed: true } | { allowed: false; reason: string };
const no = (reason: string): Check => ({ allowed: false, reason });
const yes: Check = { allowed: true };

/** Remove (or remove and block) someone: admins only; never the owner; admins only by the owner. */
export function removeCheck(me: MemberRow, target: MemberRow): Check {
  if (target.address === me.address) return no("To leave, use Leave room at the bottom.");
  if (!isAdminRole(me)) return no("Only admins can remove people.");
  if (target.status !== "active") return no("They are no longer in this room.");
  if (target.role === "owner") return no("The owner cannot be removed.");
  if (target.role === "admin" && me.role !== "owner") return no("Only the owner can remove an admin.");
  return yes;
}

/** Make or dismiss an admin: the owner only, recorded on QoreChain. */
export function adminCheck(me: MemberRow, target: MemberRow): Check {
  if (target.address === me.address) return no("You cannot change your own role.");
  if (target.role === "owner") return no("The owner's role changes only by transferring the room.");
  if (!(me.status === "active" && me.role === "owner")) return no("Only the owner can make or dismiss admins.");
  if (target.status !== "active") return no("They are no longer in this room.");
  return yes;
}

/** Change a member's rights: admins, for plain members (admins can do everything). */
export function permissionsCheck(me: MemberRow, target: MemberRow): Check {
  if (target.address === me.address) return no("You cannot change your own rights.");
  if (!isAdminRole(me)) return no("Only admins can change what members can do.");
  if (target.role !== "member") return no("Admins can do everything in the room.");
  if (target.status !== "active") return no("They are no longer in this room.");
  return yes;
}

/**
 * Ownership transfer gate: the person re-types the room name exactly, and the
 * new owner must already be an admin (an admin has already been trusted with
 * the room's keys and changes).
 */
export function transferGate(args: { typed: string; roomName: string; target: MemberRow | undefined }): Check {
  if (!args.target) return no("Pick the admin who becomes the owner.");
  if (args.target.status !== "active" || args.target.role !== "admin")
    return no("Only an admin of this room can become its owner.");
  const want = args.roomName.trim();
  if (!want) return no("This room has no name to type yet. Give it one first.");
  if (args.typed.trim() !== want) return no("Type the room name exactly as it is shown.");
  return yes;
}

/** Saved safety words against the words worked out now. */
export function verifyState(
  saved: string | undefined,
  current: string | null,
): "never" | "match" | "changed" | "saved" {
  if (!saved) return "never";
  if (current === null) return "saved";
  return saved === current ? "match" : "changed";
}

export type PersonInput =
  { kind: "address"; address: string } | { kind: "name"; name: string } | { kind: "bad"; error: string };
const ADDRESS = /^qor1[02-9ac-hj-np-z]{38}$/;

/** "@ana", "ana" or a qor1 address typed into the add-people field. */
export function parsePerson(raw: string): PersonInput {
  const t = raw.trim();
  if (!t) return { kind: "bad", error: "Type an @name or a qor1 address." };
  if (/^qor1/i.test(t))
    return ADDRESS.test(t.toLowerCase())
      ? { kind: "address", address: t.toLowerCase() }
      : {
          kind: "bad",
          error: "That address is not complete. A QoreChain address starts with qor1 and has 42 characters.",
        };
  const name = normalizeNameInput(t);
  if (name.length < 3) return { kind: "bad", error: "Names have at least 3 letters or numbers." };
  return { kind: "name", name };
}

/** Where a join request came from: an invite link, or a member's suggestion ("add:<address>"). */
export function requestOrigin(inviteId: string): { kind: "link" } | { kind: "suggested"; by: string } {
  const m = /^add:(qor1[02-9ac-hj-np-z]{38})$/.exec(inviteId);
  return m?.[1] ? { kind: "suggested", by: m[1] } : { kind: "link" };
}

// ---- files -------------------------------------------------------------------------------

export type FileFilter = "all" | SharedFile["kind"];
export const FILE_FILTERS: { value: FileFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "photo", label: "Photos" },
  { value: "video", label: "Videos" },
  { value: "doc", label: "Docs" },
  { value: "audio", label: "Audio" },
];
export const filterFiles = (files: SharedFile[], f: FileFilter): SharedFile[] =>
  f === "all" ? files : files.filter((x) => x.kind === f);

// ---- dates -------------------------------------------------------------------------------

export const dayLabel = (iso: string): string =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
export const whenLabel = (iso: string): string =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
