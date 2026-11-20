/**
 * File requests (spec 5.7, ARCHITECTURE 8g, Dropbox's file requests): the
 * owner's signed request records (checked against the owner's key on chain
 * here and again in every uploader's browser), content-blind counts for the
 * owner's list, and the rule the drop service applies when an upload arrives
 * (the request exists, is open, and its deadline has not passed unless late
 * uploads are taken, in which case the upload is marked late).
 */
import type { FastifyPluginCallback } from "fastify";
import { and, count, desc, eq, gte, max, sql, sum } from "drizzle-orm";
import { z } from "zod";
import {
  FileRequestSchema,
  fileRequestRef,
  requestIdOfRef,
  requestState,
  stateRefusal,
  verifyRecord,
  type FileRequest,
  type Signed,
} from "@mizuhiki/core";
import { envelopes, fileRequests, names } from "@mizuhiki/db";
import type { Db } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { pqKeyOf } from "../lib/chainreads";
import { fail } from "../lib/http";

const ID = /^[A-Za-z0-9_-]{8,40}$/;

/**
 * Whether an upload to this request can be stored right now, and if it is late.
 * Used by the drop service for kind "filedrop".
 */
export async function fileDropCheck(
  db: Db,
  owner: string,
  ref: string | undefined,
): Promise<{ refusal: string } | { late: boolean }> {
  const reqId = requestIdOfRef(ref);
  if (!reqId) return { refusal: "This upload does not name its request. Nothing was stored." };
  const [row] = await db
    .select()
    .from(fileRequests)
    .where(and(eq(fileRequests.id, reqId), eq(fileRequests.owner, owner)));
  if (!row) return { refusal: "This request does not exist. Nothing was stored." };
  const state = requestState((row.record as Signed<FileRequest>).body);
  const why = stateRefusal(state);
  if (why) return { refusal: why.replace("Nothing was sent.", "Nothing was stored.") };
  // Content-blind flood guard per request: at most 60 uploads a minute.
  const [recent] = await db
    .select({ n: count() })
    .from(envelopes)
    .where(and(eq(envelopes.ref, fileRequestRef(reqId)), gte(envelopes.createdAt, new Date(Date.now() - 60_000))));
  if ((recent?.n ?? 0) >= 60)
    return {
      refusal: "This request is receiving too many uploads right now. Try again in a minute. Nothing was stored.",
    };
  return { late: state === "late" };
}

const Put = z.object({
  record: z.object({
    kind: z.literal("filerequest"),
    signer: z.string(),
    body: z.unknown(),
    signature: z.unknown(),
  }),
});

export const fileRequestRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    /** Create, edit, close or reopen: every change is a new signed version. */
    app.put("/owner/file-requests", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was saved.", "nothing-stored");
      const b = Put.safeParse(req.body);
      const parsed = b.success ? FileRequestSchema.safeParse(b.data.record.body) : null;
      if (!b.success || !parsed?.success)
        return fail(reply, 400, "BAD_REQUEST", "The request was incomplete. Nothing was saved.", "nothing-stored");
      const def = parsed.data;
      if (b.data.record.signer !== owner || def.owner !== owner)
        return fail(
          reply,
          400,
          "BAD_SIGNATURE",
          "This request is signed for another account. Nothing was saved.",
          "nothing-stored",
        );
      const [existing] = await db.select().from(fileRequests).where(eq(fileRequests.id, def.id));
      if (existing && existing.owner !== owner)
        return fail(
          reply,
          409,
          "TAKEN",
          "That request id belongs to someone else. Nothing was saved.",
          "nothing-stored",
        );
      if (def.version <= (existing?.version ?? 0))
        return fail(
          reply,
          409,
          "STALE",
          "A newer version of this request is already saved. Reload and try again.",
          "nothing-stored",
        );
      const key = await pqKeyOf(owner);
      try {
        if (!key.publicKey || !key.possessionProven) throw new Error("no key");
        verifyRecord(b.data.record as unknown as Signed<FileRequest>, {
          kind: "filerequest",
          signer: owner,
          pqPublicKey: key.publicKey,
        });
      } catch {
        return fail(
          reply,
          400,
          "BAD_SIGNATURE",
          "The signature does not match your key on chain. Nothing was saved.",
          "nothing-stored",
        );
      }
      const record = { ...(b.data.record as unknown as Signed<FileRequest>), body: def };
      await db
        .insert(fileRequests)
        .values({ id: def.id, owner, record, status: def.status, version: def.version })
        .onConflictDoUpdate({
          target: fileRequests.id,
          set: { record, status: def.status, version: def.version, updatedAt: new Date() },
        });
      await db.execute(sql`select pg_notify('mzk_events', ${`freq:${owner}`})`);
      return { ok: true, version: def.version };
    });

    /** The owner's list: what the server can see (counts, sizes, times), never names or contents. */
    app.get("/owner/file-requests", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db
        .select()
        .from(fileRequests)
        .where(eq(fileRequests.owner, owner))
        .orderBy(desc(fileRequests.createdAt));
      const stats = await db
        .select({
          ref: envelopes.ref,
          uploads: count(),
          bytes: sum(envelopes.size),
          late: sum(sql<number>`case when ${envelopes.late} then 1 else 0 end`),
          unread: sum(sql<number>`case when ${envelopes.readAt} is null then 1 else 0 end`),
          last: max(envelopes.createdAt),
        })
        .from(envelopes)
        .where(and(eq(envelopes.owner, owner), eq(envelopes.kind, "filedrop")))
        .groupBy(envelopes.ref);
      const byRef = new Map(stats.map((s) => [s.ref, s]));
      return {
        requests: rows.map((r) => {
          const s = byRef.get(fileRequestRef(r.id));
          return {
            record: r.record,
            createdAt: r.createdAt.toISOString(),
            uploads: s?.uploads ?? 0,
            bytes: Number(s?.bytes ?? 0),
            late: Number(s?.late ?? 0),
            unread: Number(s?.unread ?? 0),
            lastUploadAt: s?.last ? new Date(s.last).toISOString() : null,
          };
        }),
      };
    });

    /** One request with its uploads (envelope hashes the owner's device opens). */
    app.get("/owner/file-requests/:id", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return fail(reply, 404, "NOT_FOUND", "This request does not exist.");
      const [row] = await db
        .select()
        .from(fileRequests)
        .where(and(eq(fileRequests.id, id), eq(fileRequests.owner, owner)));
      if (!row) return fail(reply, 404, "NOT_FOUND", "This request does not exist.");
      const ups = await db
        .select()
        .from(envelopes)
        .where(and(eq(envelopes.owner, owner), eq(envelopes.ref, fileRequestRef(id)), eq(envelopes.kind, "filedrop")))
        .orderBy(desc(envelopes.createdAt));
      return {
        record: row.record,
        createdAt: row.createdAt.toISOString(),
        uploads: ups.map((e) => ({
          hash: e.hash,
          at: e.createdAt.toISOString(),
          size: e.size,
          late: e.late,
          read: e.readAt !== null,
          expiresAt: e.expiresAt?.toISOString() ?? null,
          senderSig: e.senderSig,
        })),
      };
    });

    /** Delete a closed request (Dropbox's order). Uploads stay in the inbox: they are the owner's items. */
    app.delete("/owner/file-requests/:id", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was deleted.", "nothing-changed");
      const { id } = req.params as { id: string };
      const [row] = await db
        .select()
        .from(fileRequests)
        .where(and(eq(fileRequests.id, id), eq(fileRequests.owner, owner)));
      if (!row) return fail(reply, 404, "NOT_FOUND", "This request does not exist.");
      if (row.status !== "closed")
        return fail(
          reply,
          409,
          "OPEN",
          "Close the request before deleting it. Nothing was deleted.",
          "nothing-changed",
        );
      await db.delete(fileRequests).where(eq(fileRequests.id, id));
      await db.execute(sql`select pg_notify('mzk_events', ${`freq:${owner}`})`);
      return { ok: true };
    });

    /** The public request: the signed record (checked again in the browser) and the page name. */
    app.get("/file-requests/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return fail(reply, 404, "NOT_FOUND", "This request does not exist.");
      const [row] = await db.select().from(fileRequests).where(eq(fileRequests.id, id));
      if (!row) return fail(reply, 404, "NOT_FOUND", "This request does not exist, or it was deleted.");
      const [primary] = await db
        .select({ name: names.name })
        .from(names)
        .where(and(eq(names.address, row.owner), eq(names.primary, true)));
      return { record: row.record, name: primary?.name ?? null };
    });

    done();
  };
