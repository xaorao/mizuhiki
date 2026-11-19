import type { FastifyPluginCallback } from "fastify";
import { eq, lt, and, isNotNull } from "drizzle-orm";
import type { Ctx } from "../server";
import { blobs, media } from "@mizuhiki/db";
import { sessionAddress } from "../lib/auth";
import { fail, isHash } from "../lib/http";

const UNCLAIMED_HOURS = 24;

/** Image sniffing by magic bytes: the declared type must match the bytes. */
function imageType(b: Uint8Array): "image/png" | "image/jpeg" | "image/webp" | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return undefined;
}

export const blobRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    /**
     * Store sealed bytes. Content-blind: the server only checks size. A blob not
     * referenced by a drop, draft or other record within a day is swept.
     */
    app.put("/blobs", { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = req.body;
      if (!(body instanceof Buffer) || body.length === 0)
        return fail(reply, 400, "EMPTY", "Nothing to store.", "nothing-stored");
      if (body.length > ctx.cfg.MAX_BLOB_BYTES)
        return fail(
          reply,
          413,
          "TOO_LARGE",
          "This piece is larger than allowed. Nothing was stored.",
          "nothing-stored",
        );
      const r = await ctx.blobs.put(new Uint8Array(body));
      await ctx.db
        .insert(blobs)
        .values({ hash: r.hash, size: r.size, expiresAt: new Date(Date.now() + UNCLAIMED_HOURS * 3600_000) })
        .onConflictDoNothing();
      return { hash: r.hash, size: r.size };
    });

    app.get("/blobs/:hash", async (req, reply) => {
      const { hash } = req.params as { hash: string };
      if (!isHash(hash)) return fail(reply, 400, "BAD_HASH", "Not a blob id.");
      const b = await ctx.blobs.get(hash);
      if (!b) return fail(reply, 404, "GONE", "This sealed copy is no longer stored. It may have expired.");
      return reply
        .header("content-type", "application/octet-stream")
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .send(Buffer.from(b));
    });

    /** Public images for pages. Owner only; type checked by magic bytes; 3 MB cap. */
    app.put("/media", async (req, reply) => {
      const owner = await sessionAddress(ctx.db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was stored.", "nothing-stored");
      const body = req.body;
      if (!(body instanceof Buffer)) return fail(reply, 400, "EMPTY", "Nothing to store.", "nothing-stored");
      if (body.length > 3 * 1024 * 1024)
        return fail(reply, 413, "TOO_LARGE", "Images can be up to 3 MB. Nothing was stored.", "nothing-stored");
      const type = imageType(new Uint8Array(body));
      if (!type)
        return fail(reply, 415, "NOT_AN_IMAGE", "Use a PNG, JPEG or WebP image. Nothing was stored.", "nothing-stored");
      const r = await ctx.blobs.put(new Uint8Array(body));
      await ctx.db.insert(media).values({ hash: r.hash, owner, type, size: r.size }).onConflictDoNothing();
      await ctx.db
        .insert(blobs)
        .values({ hash: r.hash, size: r.size })
        .onConflictDoUpdate({ target: blobs.hash, set: { expiresAt: null } });
      return { hash: r.hash, type };
    });

    app.get("/media/:hash", async (req, reply) => {
      const { hash } = req.params as { hash: string };
      if (!isHash(hash)) return fail(reply, 400, "BAD_HASH", "Not an image id.");
      const [m] = await ctx.db.select().from(media).where(eq(media.hash, hash));
      const b = m ? await ctx.blobs.get(hash) : undefined;
      if (!m || !b) return fail(reply, 404, "GONE", "This image is not stored.");
      return reply
        .header("content-type", m.type)
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff")
        .header("content-security-policy", "default-src 'none'")
        .send(Buffer.from(b));
    });
    done();
  };

/** Delete blobs whose expiry passed (unclaimed uploads, expired drops). */
export async function sweepBlobs(ctx: Ctx): Promise<number> {
  const due = await ctx.db
    .select({ hash: blobs.hash })
    .from(blobs)
    .where(and(isNotNull(blobs.expiresAt), lt(blobs.expiresAt, new Date())))
    .limit(500);
  for (const d of due) {
    await ctx.blobs.delete(d.hash);
    await ctx.db.delete(blobs).where(eq(blobs.hash, d.hash));
  }
  return due.length;
}
