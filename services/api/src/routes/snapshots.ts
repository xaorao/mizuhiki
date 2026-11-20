/**
 * Shared results snapshots (spec 5.9). Content-blind: the owner's browser
 * seals the snapshot to a link key (whose seed stays in the link's fragment)
 * and to the owner, uploads it as a blob, and signs {formId, envelope}. This
 * route checks that signature against the owner's ML-DSA key on chain, keeps
 * the blob until the owner deletes the snapshot, and serves only the signed
 * metadata publicly so viewers can check who shared it. It never sees content.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { verifyRecord, type Signed } from "@mizuhiki/core";
import { blobs, forms, names, snapshots } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { pqKeyOf } from "../lib/chainreads";
import { fail, isHash } from "../lib/http";
import { hold, release } from "../lib/holds";

const HASH = /^[0-9a-f]{64}$/;
const FORM_ID = /^[A-Za-z0-9_-]{1,40}$/;

const SigSchema = z.object({
  kind: z.literal("snapshot"),
  signer: z.string(),
  body: z.object({ formId: z.string().regex(FORM_ID), envelope: z.string().regex(HASH) }),
  signature: z.unknown(),
});

const Save = z.object({
  hash: z.string().regex(HASH),
  formId: z.string().regex(FORM_ID),
  title: z.string().max(200),
  sig: SigSchema,
});

export const snapshotRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    /** Keep a sealed snapshot the owner signed. */
    app.put("/owner/snapshots", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was kept.", "nothing-stored");
      const b = Save.safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "The snapshot was incomplete. Nothing was kept.", "nothing-stored");
      const { hash, formId, title, sig } = b.data;
      const [form] = await db
        .select({ id: forms.id })
        .from(forms)
        .where(and(eq(forms.id, formId), eq(forms.owner, owner)));
      if (!form) return fail(reply, 404, "NOT_FOUND", "That form is not yours. Nothing was kept.", "nothing-stored");
      const [blob] = await db.select({ hash: blobs.hash }).from(blobs).where(eq(blobs.hash, hash));
      if (!blob)
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "The sealed snapshot did not arrive. Nothing was kept.",
          "nothing-stored",
        );
      const [existing] = await db.select({ owner: snapshots.owner }).from(snapshots).where(eq(snapshots.hash, hash));
      if (existing && existing.owner !== owner)
        return fail(reply, 409, "TAKEN", "That snapshot belongs to someone else. Nothing was kept.", "nothing-stored");
      if (sig.signer !== owner || sig.body.formId !== formId || sig.body.envelope !== hash)
        return fail(
          reply,
          400,
          "BAD_SIGNATURE",
          "The signature is for another snapshot or account. Nothing was kept.",
          "nothing-stored",
        );
      const key = await pqKeyOf(owner);
      try {
        if (!key.publicKey || !key.possessionProven) throw new Error("no key");
        verifyRecord(sig as unknown as Signed<{ formId: string; envelope: string }>, {
          kind: "snapshot",
          signer: owner,
          pqPublicKey: key.publicKey,
        });
      } catch {
        return fail(
          reply,
          400,
          "BAD_SIGNATURE",
          "The signature does not match your key on chain. Nothing was kept.",
          "nothing-stored",
        );
      }
      const [taken] = await db.select({ owner: snapshots.owner }).from(snapshots).where(eq(snapshots.hash, hash));
      if (taken && taken.owner !== owner)
        return fail(reply, 409, "TAKEN", "That snapshot belongs to someone else. Nothing was kept.", "nothing-stored");
      await db.transaction(async (tx) => {
        await hold(tx, [hash], owner, `snapshot:${formId}`);
        await tx
          .insert(snapshots)
          .values({ hash, owner, formId, title, sig })
          .onConflictDoUpdate({ target: snapshots.hash, set: { title, sig } });
      });
      return { ok: true, hash };
    });

    /** The owner's snapshots of one form (or all), newest first. Metadata only. */
    app.get("/owner/snapshots", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { formId } = req.query as { formId?: string };
      if (formId !== undefined && !FORM_ID.test(formId)) return fail(reply, 400, "BAD_REQUEST", "Not a form.");
      const rows = await db
        .select({ hash: snapshots.hash, formId: snapshots.formId, title: snapshots.title, at: snapshots.createdAt })
        .from(snapshots)
        .where(formId ? and(eq(snapshots.owner, owner), eq(snapshots.formId, formId)) : eq(snapshots.owner, owner))
        .orderBy(desc(snapshots.createdAt))
        .limit(500);
      return {
        snapshots: rows.map((r) => ({ hash: r.hash, formId: r.formId, title: r.title, createdAt: r.at.toISOString() })),
      };
    });

    /** Delete a snapshot: the row goes now, the sealed copy at the next sweep. */
    app.delete("/owner/snapshots/:hash", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { hash } = req.params as { hash: string };
      if (!isHash(hash)) return fail(reply, 400, "BAD_REQUEST", "Not a snapshot. Nothing changed.");
      const gone = await db.transaction(async (tx) => {
        const r = await tx
          .delete(snapshots)
          .where(and(eq(snapshots.hash, hash), eq(snapshots.owner, owner)))
          .returning({ hash: snapshots.hash, formId: snapshots.formId });
        if (r[0]) await release(tx, owner, `snapshot:${r[0].formId}`, [hash]);
        return r.length > 0;
      });
      if (!gone) return fail(reply, 404, "NOT_FOUND", "That snapshot is not yours, or it was already deleted.");
      return { ok: true };
    });

    /** What a viewer's browser needs to check who shared a snapshot. Never content. */
    app.get("/snapshots/:hash", async (req, reply) => {
      const { hash } = req.params as { hash: string };
      if (!isHash(hash)) return fail(reply, 400, "BAD_HASH", "Not a snapshot id.");
      const [r] = await db.select().from(snapshots).where(eq(snapshots.hash, hash));
      if (!r) return fail(reply, 404, "NOT_FOUND", "There is no snapshot here. Its owner may have deleted it.");
      const owned = await db
        .select({ name: names.name, primary: names.primary })
        .from(names)
        .where(eq(names.address, r.owner));
      return {
        owner: r.owner,
        ownerName: owned.find((o) => o.primary)?.name ?? owned[0]?.name ?? null,
        formId: r.formId,
        title: r.title,
        sig: r.sig,
        createdAt: r.createdAt.toISOString(),
      };
    });

    done();
  };
