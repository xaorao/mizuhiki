/**
 * Invite link rules worked out on this device: the time and use-limit
 * sliders of Telegram's New Link screen, a link's state as the server judges
 * it, the labels shown on each link row, and reading the key from a link's
 * fragment. Pure functions, so they are unit-tested.
 */
import type { InviteRow } from "../engine";

const HOUR = 3_600_000;

/** The time slider's stops, left to right (Telegram: 1 hour, 1 day, 1 week, No limit). */
export const TIME_STOPS = [
  { label: "1 hour", ms: HOUR },
  { label: "1 day", ms: 24 * HOUR },
  { label: "1 week", ms: 7 * 24 * HOUR },
  { label: "No limit", ms: null },
] as const;

/** The use slider's stops, left to right (Telegram: 1, 10, 100, No limit). */
export const USE_STOPS = [
  { label: "1", uses: 1 },
  { label: "10", uses: 10 },
  { label: "100", uses: 100 },
  { label: "No limit", uses: null },
] as const;

/** The server accepts 1 to 100,000 uses. */
export const MAX_USES = 100_000;

export type TimeChoice = { kind: "stop"; index: number } | { kind: "custom"; at: Date };
export type UseChoice = { kind: "stop"; index: number } | { kind: "custom"; uses: number };

/** When a link made now with this choice stops working; null means never. */
export function expiryOf(choice: TimeChoice, now: Date): Date | null {
  if (choice.kind === "custom") return choice.at;
  const stop = TIME_STOPS[choice.index];
  if (!stop) throw new RangeError(`No time stop ${choice.index}`);
  return stop.ms === null ? null : new Date(now.getTime() + stop.ms);
}

/** How many times a link with this choice can be used; null means no limit. */
export function usesOf(choice: UseChoice): number | null {
  if (choice.kind === "custom") return choice.uses;
  const stop = USE_STOPS[choice.index];
  if (!stop) throw new RangeError(`No use stop ${choice.index}`);
  return stop.uses;
}

/** Why a custom expiry cannot be used, or null when it is fine. At least five minutes ahead. */
export function customExpiryProblem(at: Date | null, now: Date): string | null {
  if (!at || Number.isNaN(at.getTime())) return "Pick a date and time.";
  if (at.getTime() < now.getTime() + 5 * 60_000) return "Pick a time at least five minutes from now.";
  return null;
}

/** Parse a typed custom use limit: a whole number from 1 to 100,000. */
export function parseUseLimit(text: string): { uses: number } | { problem: string } {
  const t = text.trim().replace(/[,\s_]/g, "");
  if (!t) return { problem: "Type how many people can use the link." };
  if (!/^\d+$/.test(t)) return { problem: "Use a whole number, like 25." };
  const n = Number(t);
  if (n < 1) return { problem: "A link needs at least one use." };
  if (n > MAX_USES) return { problem: `The most a link allows is ${MAX_USES.toLocaleString("en-US")}.` };
  return { uses: n };
}

export type LinkState = "active" | "expired" | "used-up" | "revoked";

/** The same order the server uses: revoked, then expired, then used up. */
export function linkState(row: Pick<InviteRow, "revoked" | "expiresAt" | "maxUses" | "uses">, now: Date): LinkState {
  if (row.revoked) return "revoked";
  if (row.expiresAt && new Date(row.expiresAt).getTime() < now.getTime()) return "expired";
  if (row.maxUses !== null && row.uses >= row.maxUses) return "used-up";
  return "active";
}

export const STATE_LABEL: Record<LinkState, string> = {
  active: "Active",
  expired: "Expired",
  "used-up": "Used up",
  revoked: "Revoked",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/** "Nov 24 at 21:34" (Telegram's form), with the year added when it is not this year. Device time zone. */
export function fmtWhen(at: Date, now: Date): string {
  const year = at.getFullYear() !== now.getFullYear() ? `, ${at.getFullYear()}` : "";
  return `${MONTHS[at.getMonth()] ?? ""} ${at.getDate()}${year} at ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** The expiry line of a link row. */
export function expiryLabel(expiresAt: string | null, now: Date): string {
  if (!expiresAt) return "Never expires";
  const at = new Date(expiresAt);
  return at.getTime() < now.getTime() ? `Expired ${fmtWhen(at, now)}` : `Expires ${fmtWhen(at, now)}`;
}

/** The use line of a link row: "3 of 10 used", "1 use", "Not used yet". */
export function usesLabel(uses: number, maxUses: number | null): string {
  if (maxUses !== null) return `${uses} of ${maxUses} used`;
  if (uses === 0) return "Not used yet";
  return uses === 1 ? "1 use" : `${uses} uses`;
}

/** What the use slider shows under it. */
export function usesHelp(uses: number | null): string {
  if (uses === null) return "Anyone with the link can ask to join, any number of times.";
  return uses === 1
    ? "Works for one person, then stops."
    : `Works for ${uses.toLocaleString("en-US")} people, then stops.`;
}

/**
 * The link's key from a URL fragment ("#k=…"): 32 bytes as unpadded
 * base64url, 43 characters. Anything else is a damaged link.
 */
export function keyFromFragment(hash: string): string | null {
  const m = /(?:^#?|&)k=([A-Za-z0-9_-]+)(?:&|$)/.exec(hash);
  const k = m?.[1];
  return k && k.length === 43 && /[AEIMQUYcgkosw048]$/.test(k) ? k : null;
}

/** An id the server accepts for an invite (the route is /join/<id>). */
export const isInviteId = (id: string): boolean => /^[a-z0-9]{12,32}$/.test(id);

/** ISO instant to the value a datetime-local input shows, in this device's time zone. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A datetime-local value (device time zone) to a Date, or null when empty or invalid. */
export function fromLocalInput(v: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** The text that goes with a shared link (WhatsApp: "Follow this link to join my … group"). */
export function shareText(roomName: string): string {
  return `Join “${roomName || "my room"}” on Mizuhiki. Messages there are sealed to the people in the room.`;
}
