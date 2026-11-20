/**
 * Invoices (spec 5.6): content-blind storage of sealed invoices.
 * The owner saves a draft (sealed to the owner only) and, on Send, the sealed
 * invoice plus a signature over {id, envelope}; the signature is checked here
 * against the owner's ML-DSA key on chain, and again by the payer's browser.
 * Status (Due, Paid, Overdue) is worked out on devices from the sealed due
 * date and amount and from on-chain payments with memo `mzk:inv:<id>`.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { verifyRecord, type Signed } from "@mizuhiki/core";
import { blobs, invoices, names, payments } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { pqKeyOf } from "../lib/chainreads";
import { fail } from "../lib/http";
import { hold, release } from "../lib/holds";

const ID = /^[a-z0-9]{10,32}$/;
const HASH = /^[0-9a-f]{64}$/;

const SigSchema = z.object({
  kind: z.literal("invoice"),
  signer: z.string(),
  body: z.object({ id: z.string(), envelope: z.string().regex(HASH) }),
  signature: z.unknown(),
});

const Save = z.object({
  id: z.string().regex(ID),
  privateEnvelope: z.string().regex(HASH),
  /** Pieces of attachments and the sealed copies themselves must be kept (no expiry). */
  keep: z.array(z.string().regex(HASH)).max(600).default([]),
  send: z
    .object({
      envelope: z.string().regex(HASH),
      sig: SigSchema,
    })
    .optional(),
});

export const invoiceRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    app.put("/invoices", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was saved.", "nothing-stored");
      const b = Save.safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "The invoice was incomplete. Nothing was saved.", "nothing-stored");
      const [existing] = await db.select().from(invoices).where(eq(invoices.id, b.data.id));
      if (existing && existing.owner !== owner)
        return fail(
          reply,
          409,
          "TAKEN",
          "That invoice id belongs to someone else. Nothing was saved.",
          "nothing-stored",
        );
      if (existing?.state === "cancelled")
        return fail(
          reply,
          409,
          "CANCELLED",
          "This invoice was cancelled. Duplicate it to send a new one.",
          "nothing-stored",
        );
      if (existing && existing.state !== "draft" && !b.data.send)
        return fail(
          reply,
          409,
          "SENT",
          "A sent invoice can no longer be edited. Duplicate it instead.",
          "nothing-stored",
        );

      const must = [b.data.privateEnvelope, ...(b.data.send ? [b.data.send.envelope] : []), ...b.data.keep];
      const found = await db.select({ hash: blobs.hash }).from(blobs).where(inArray(blobs.hash, must));
      if (new Set(found.map((f) => f.hash)).size !== new Set(must).size)
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "Some sealed parts did not arrive. Nothing was saved.",
          "nothing-stored",
        );

      if (b.data.send) {
        const sig = b.data.send.sig;
        if (sig.signer !== owner || sig.body.id !== b.data.id || sig.body.envelope !== b.data.send.envelope)
          return fail(
            reply,
            400,
            "BAD_SIGNATURE",
            "The signature is for another invoice. Nothing was sent.",
            "nothing-stored",
          );
        const key = await pqKeyOf(owner);
        try {
          if (!key.publicKey || !key.possessionProven) throw new Error("no key");
          verifyRecord(sig as unknown as Signed<{ id: string; envelope: string }>, {
            kind: "invoice",
            signer: owner,
            pqPublicKey: key.publicKey,
          });
        } catch {
          return fail(
            reply,
            400,
            "BAD_SIGNATURE",
            "The signature does not match your key on chain. Nothing was sent.",
            "nothing-stored",
          );
        }
      }

      await db.transaction(async (tx) => {
        // Invoices and their attachments are kept until the owner deletes them; an edit replaces the set.
        await release(tx, owner, `invoice:${b.data.id}`);
        await hold(tx, must, owner, `invoice:${b.data.id}`);
        const now = new Date();
        await tx
          .insert(invoices)
          .values({
            id: b.data.id,
            owner,
            privateEnvelope: b.data.privateEnvelope,
            ...(b.data.send
              ? { envelope: b.data.send.envelope, sig: b.data.send.sig, state: "sent", sentAt: now }
              : {}),
          })
          .onConflictDoUpdate({
            target: invoices.id,
            set: {
              privateEnvelope: b.data.privateEnvelope,
              updatedAt: now,
              ...(b.data.send
                ? {
                    envelope: b.data.send.envelope,
                    sig: b.data.send.sig,
                    state: "sent",
                    sentAt: existing?.sentAt ?? now,
                  }
                : {}),
            },
          });
      });
      return { ok: true, state: b.data.send ? "sent" : (existing?.state ?? "draft") };
    });

    app.get("/owner/invoices", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db
        .select()
        .from(invoices)
        .where(eq(invoices.owner, owner))
        .orderBy(desc(invoices.createdAt))
        .limit(1000);
      const ids = rows.map((r) => r.id);
      const paid = ids.length
        ? await db
            .select()
            .from(payments)
            .where(and(eq(payments.toAddr, owner), eq(payments.kind, "inv"), inArray(payments.ref, ids)))
        : [];
      return {
        invoices: rows.map((r) => ({
          id: r.id,
          envelope: r.envelope,
          privateEnvelope: r.privateEnvelope,
          state: r.state,
          archived: r.archived,
          viewedAt: r.viewedAt?.toISOString() ?? null,
          recordedPaidAt: r.recordedPaidAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
          sentAt: r.sentAt?.toISOString() ?? null,
          payments: paid
            .filter((p) => p.ref === r.id)
            .map((p) => ({
              txHash: p.txHash,
              from: p.fromAddr,
              denom: p.denom,
              amount: p.amount,
              at: p.time.toISOString(),
            })),
        })),
      };
    });

    app.patch("/owner/invoices/:id", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { id } = req.params as { id: string };
      const b = z
        .object({
          cancel: z.literal(true).optional(),
          archived: z.boolean().optional(),
          recordPaid: z.boolean().optional(),
        })
        .safeParse(req.body);
      if (!ID.test(id) || !b.success) return fail(reply, 400, "BAD_REQUEST", "Nothing changed.");
      const set: Partial<typeof invoices.$inferInsert> = { updatedAt: new Date() };
      if (b.data.cancel) set.state = "cancelled";
      if (b.data.archived !== undefined) set.archived = b.data.archived;
      if (b.data.recordPaid !== undefined) set.recordedPaidAt = b.data.recordPaid ? new Date() : null;
      const r = await db
        .update(invoices)
        .set(set)
        .where(and(eq(invoices.id, id), eq(invoices.owner, owner)))
        .returning({ id: invoices.id });
      if (r.length === 0) return fail(reply, 404, "NOT_FOUND", "That invoice is not yours.");
      return { ok: true };
    });

    app.delete("/owner/invoices/:id", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { id } = req.params as { id: string };
      const r = await db
        .delete(invoices)
        .where(and(eq(invoices.id, id), eq(invoices.owner, owner), eq(invoices.state, "draft")))
        .returning({ id: invoices.id });
      if (r.length === 0)
        return fail(reply, 404, "NOT_FOUND", "Only your own drafts can be deleted. Sent invoices can be cancelled.");
      await release(db, owner, `invoice:${id}`);
      return { ok: true };
    });

    /** What a payer's browser needs: the sealed invoice, its signature and who sent it. Never content. */
    app.get("/invoices/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      if (!ID.test(id)) return fail(reply, 404, "NOT_FOUND", "This invoice link is not valid.");
      const [r] = await db.select().from(invoices).where(eq(invoices.id, id));
      if (!r || r.state === "draft" || !r.envelope)
        return fail(reply, 404, "NOT_FOUND", "There is no invoice at this link. Check it with the sender.");
      const owned = await db
        .select({ name: names.name, primary: names.primary })
        .from(names)
        .where(eq(names.address, r.owner));
      const paid = await db
        .select()
        .from(payments)
        .where(and(eq(payments.toAddr, r.owner), eq(payments.kind, "inv"), eq(payments.ref, id)));
      return {
        id: r.id,
        owner: r.owner,
        ownerName: owned.find((o) => o.primary)?.name ?? owned[0]?.name ?? null,
        envelope: r.envelope,
        sig: r.sig,
        state: r.state,
        sentAt: r.sentAt?.toISOString() ?? null,
        payments: paid.map((p) => ({
          txHash: p.txHash,
          from: p.fromAddr,
          denom: p.denom,
          amount: p.amount,
          at: p.time.toISOString(),
        })),
      };
    });

    app.post(
      "/invoices/:id/viewed",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const { id } = req.params as { id: string };
        if (!ID.test(id)) return fail(reply, 400, "BAD_REQUEST", "Not an invoice.");
        await db
          .update(invoices)
          .set({ viewedAt: sql`coalesce(${invoices.viewedAt}, now())` })
          .where(and(eq(invoices.id, id), eq(invoices.state, "sent")));
        return { ok: true };
      },
    );

    done();
  };
