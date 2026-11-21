/**
 * File requests on this device (spec 5.7, ARCHITECTURE 8g): words for the
 * deadline in both time zones, and the owner's list row shape.
 */
import type { FileRequest, RequestState } from "@mizuhiki/core";

const cityOf = (tz: string): string => (tz.split("/").pop() ?? tz).replace(/_/g, " ");

function fmt(d: Date, timeZone: string, withDate: boolean): string {
  return d.toLocaleString("en-GB", {
    timeZone,
    ...(withDate ? { day: "numeric", month: "long", year: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * "Due 20 November 2026, 17:00 Tokyo time (09:00 your time)". Dropbox states the
 * deadline in the requester's time zone; the uploader's own time is added when it differs.
 */
/** A zone this browser knows, or UTC: the record's zone is the owner's word, so never trust it to be valid. */
function knownZone(tz: string | undefined): string {
  if (!tz) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

export function deadlineText(r: Pick<FileRequest, "deadline" | "timeZone">, viewerZone?: string): string | null {
  if (!r.deadline) return null;
  const d = new Date(r.deadline);
  if (Number.isNaN(d.getTime())) return null;
  const owner = knownZone(r.timeZone);
  const mine = knownZone(viewerZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
  // The place stays on one line ("Los Angeles time", not "Los / Angeles time").
  const place = owner === "UTC" ? "UTC" : `${cityOf(owner)} time`.replace(/ /g, "\u00a0");
  const main = `Due ${fmt(d, owner, true)} ${place}`;
  if (mine === owner) return main;
  const dayIn = (tz: string) =>
    d.toLocaleDateString("en-GB", { timeZone: tz, day: "numeric", month: "long", year: "numeric" });
  const sameDay = dayIn(owner) === dayIn(mine);
  return `${main} (${fmt(d, mine, !sameDay)} your time)`;
}

export const STATE_LABEL: Record<RequestState, string> = {
  open: "Open",
  late: "Taking late uploads",
  ended: "Deadline passed",
  closed: "Closed",
};

export interface RequestRow {
  record: { kind: "filerequest"; signer: string; body: FileRequest; signature: unknown };
  createdAt: string;
  uploads: number;
  bytes: number;
  late: number;
  unread: number;
  lastUploadAt: string | null;
}

export interface UploadRow {
  hash: string;
  at: string;
  size: number;
  late: boolean;
  read: boolean;
  expiresAt: string | null;
  senderSig: unknown;
}

/** "27 Nov 2026": the deadline's day in the owner's zone, for the list. */
export function deadlineDay(r: Pick<FileRequest, "deadline" | "timeZone">): string | null {
  if (!r.deadline) return null;
  const d = new Date(r.deadline);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", {
    timeZone: knownZone(r.timeZone),
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
