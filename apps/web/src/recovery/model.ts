/** Spare key states (spec 5.13). Pure, so they are unit tested. */
import type { RecoveryAccept, RecoveryInvite, Signed } from "@mizuhiki/core";

export type ContactStatus = "invited" | "accepted" | "confirmed" | "declined" | "removed";
export interface ContactRow {
  contact: string;
  status: ContactStatus;
  invite: Signed<RecoveryInvite>;
  accept: Signed<RecoveryAccept> | null;
  piece: string | null;
  pieceVersion: number | null;
  createdAt: string;
  updatedAt: string;
}
export type RequestStatus = "open" | "waiting" | "ready" | "cancelled" | "done" | "expired";
export interface RequestRow {
  id: string;
  owner: string;
  recipient: { mlkem: string; x25519: string };
  test: boolean;
  version: number;
  threshold: number;
  status: RequestStatus;
  answered: string[];
  createdAt: string;
  releaseAt: string | null;
  cancelledAt: string | null;
  expiresAt: string;
}
export interface OfflineKeyRow {
  mlkem: string;
  x25519: string;
  since: string;
}
export interface Mine {
  settings: {
    threshold: number;
    version: number;
    sheetSavedAt: string | null;
    testedAt: string | null;
    offlineKey: OfflineKeyRow | null;
    offlineSheetSavedAt: string | null;
  };
  contacts: ContactRow[];
  requests: RequestRow[];
}

/** Contacts whose pieces are current, and whether a new set of pieces is needed. */
export function pieceState(m: Mine): { holders: ContactRow[]; confirmed: ContactRow[]; needsSeal: boolean } {
  const confirmed = m.contacts.filter((c) => c.status === "confirmed");
  const holders = confirmed.filter((c) => c.piece && c.pieceVersion === m.settings.version && m.settings.version > 0);
  const needsSeal =
    confirmed.length >= 2 &&
    (holders.length !== confirmed.length ||
      m.contacts.some((c) => c.status !== "confirmed" && c.pieceVersion === m.settings.version && c.piece));
  return { holders, confirmed, needsSeal };
}

/** Open recoveries of this account that the owner did not start as a test. */
export const strangerRequests = (m: Mine) =>
  m.requests.filter((r) => !r.test && (r.status === "open" || r.status === "waiting" || r.status === "ready"));
