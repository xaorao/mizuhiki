/**
 * Blob holds (THREAT_MODEL A2, "Deleting someone else's stored copy"). A blob
 * lives while it is new (an upload not yet referenced has UNCLAIMED_HOURS) or
 * while any hold on it is live. Routes add and release only their own caller's
 * holds, so knowing a hash never lets anyone shorten another account's copy.
 */
import { and, eq, gt, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm";
import { blobHolds, blobs, type Db } from "@mizuhiki/db";

export const UNCLAIMED_HOURS = 24;

type Tx = Pick<Db, "insert" | "delete" | "update" | "select" | "execute">;

/** Keep `hashes` for `holder` and `purpose` until `expiresAt` (null: until released). Replaces that hold's expiry. */
export async function hold(
  db: Tx,
  hashes: Iterable<string>,
  holder: string,
  purpose: string,
  expiresAt: Date | null = null,
): Promise<void> {
  const list = [...new Set(hashes)];
  if (!list.length) return;
  await db
    .insert(blobHolds)
    .values(list.map((hash) => ({ hash, holder, purpose, expiresAt })))
    .onConflictDoUpdate({ target: [blobHolds.hash, blobHolds.holder, blobHolds.purpose], set: { expiresAt } });
}

/** Drop this holder's holds for `purpose` (only those hashes, when given). Other holders are untouched. */
export async function release(db: Tx, holder: string, purpose: string, hashes?: Iterable<string>): Promise<void> {
  const list = hashes ? [...new Set(hashes)] : undefined;
  if (list && !list.length) return;
  await db
    .delete(blobHolds)
    .where(
      and(
        eq(blobHolds.holder, holder),
        eq(blobHolds.purpose, purpose),
        ...(list ? [inArray(blobHolds.hash, list)] : []),
      ),
    );
}

/** Drop every hold this holder has whose purpose starts with `prefix` (all of them without one). */
export async function releaseAll(db: Tx, holder: string, prefix = ""): Promise<void> {
  await db
    .delete(blobHolds)
    .where(and(eq(blobHolds.holder, holder), prefix ? sql`${blobHolds.purpose} like ${`${prefix}%`}` : sql`true`));
}

/** Change the expiry of this holder's existing holds for `purpose` (room auto-delete, capsule delete-after). */
export async function setHoldExpiry(
  db: Tx,
  holder: string,
  purpose: string,
  expiresAt: Date | null,
  hashes?: Iterable<string>,
): Promise<void> {
  const list = hashes ? [...new Set(hashes)] : undefined;
  if (list && !list.length) return;
  await db
    .update(blobHolds)
    .set({ expiresAt })
    .where(
      and(
        eq(blobHolds.holder, holder),
        eq(blobHolds.purpose, purpose),
        ...(list ? [inArray(blobHolds.hash, list)] : []),
      ),
    );
}

/** Blobs that are past their unclaimed grace and have no live hold. */
export async function sweepable(db: Db, limit = 500): Promise<string[]> {
  const now = new Date();
  const rows = await db
    .select({ hash: blobs.hash })
    .from(blobs)
    .where(
      and(
        lt(blobs.createdAt, new Date(now.getTime() - UNCLAIMED_HOURS * 3600_000)),
        notExists(
          db
            .select({ one: sql`1` })
            .from(blobHolds)
            .where(and(eq(blobHolds.hash, blobs.hash), or(isNull(blobHolds.expiresAt), gt(blobHolds.expiresAt, now)))),
        ),
      ),
    )
    .limit(limit);
  return rows.map((r) => r.hash);
}

/** When a blob will be swept if nothing changes: null while any hold keeps it. */
export async function liveUntil(db: Db, hash: string): Promise<Date | null> {
  const hs = await db.select({ e: blobHolds.expiresAt }).from(blobHolds).where(eq(blobHolds.hash, hash));
  if (hs.some((h) => h.e === null)) return null;
  const last = hs.reduce((m, h) => Math.max(m, h.e?.getTime() ?? 0), 0);
  return last ? new Date(last) : null;
}
