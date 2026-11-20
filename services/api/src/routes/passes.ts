/**
 * Passes (spec 5.12, ARCHITECTURE 8c). The owner's invite and the holder's
 * acceptance are signed records checked here against each person's key on
 * QoreChain. Keys move only as sealed envelopes made on the owner's device; the
 * server lists what a pass covers (metadata) and keeps re-sealed copies.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  PassAcceptSchema,
  PassInviteSchema,
  verifyRecord,
  type PassInvite,
  type PassScope,
  type Signed,
} from "@mizuhiki/core";
import { blobs, cards, envelopes, passItems, passes } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { pqKeyOf } from "../lib/chainreads";
import { fail } from "../lib/http";
import { hold } from "../lib/holds";

const HASH = /^[0-9a-f]{64}$/;
const SignedShape = z.object({
  kind: z.literal("pass"),
  signer: z.string(),
  body: z.unknown(),
  signature: z.unknown(),
});

type PassRow = typeof passes.$inferSelect;
type Status = "invited" | "accepted" | "active" | "expired" | "revoked" | "declined";

/** Inbox envelope kinds each period kind covers. */
const ENVELOPE_KINDS: Record<string, string[]> = {
  messages: ["message", "reply"],
  payments: ["paynote"],
  forms: ["form"],
};

export const passRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;
    const notify = async (kind: string, address: string) => {
      await db.execute(sql`select pg_notify('mzk_events', ${`${kind}:${address}`})`);
    };
    const inviteOf = (p: PassRow) => (p.invite as Signed<PassInvite>).body;
    const statusOf = (p: PassRow): Status =>
      p.status === "active" && p.expiresAt && p.expiresAt < new Date() ? "expired" : (p.status as Status);
    const view = (p: PassRow) => ({
      id: p.id,
      owner: p.owner,
      holder: p.holder,
      invite: p.invite as Signed<PassInvite>,
      accept: p.accept,
      status: statusOf(p),
      keyEnvelope: p.keyEnvelope,
      expiresAt: p.expiresAt,
      createdAt: p.createdAt,
      acceptedAt: p.acceptedAt,
      confirmedAt: p.confirmedAt,
      revokedAt: p.revokedAt,
    });
    const verified = async <T>(rec: unknown, signer: string): Promise<T | null> => {
      const key = await pqKeyOf(signer);
      if (!key.publicKey || !key.possessionProven) return null;
      try {
        return verifyRecord(rec as Signed<T>, { kind: "pass", signer, pqPublicKey: key.publicKey });
      } catch {
        return null;
      }
    };
    const passFor = async (id: string, me: string) => {
      const [p] = await db.select().from(passes).where(eq(passes.id, id));
      return p && (p.owner === me || p.holder === me) ? p : undefined;
    };

    app.post("/passes", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. No pass was made.", "nothing-stored");
      const b = z.object({ invite: SignedShape }).safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "The pass was incomplete. No pass was made.", "nothing-stored");
      const parsed = PassInviteSchema.safeParse(b.data.invite.body);
      if (!parsed.success || b.data.invite.signer !== me || parsed.data.owner !== me)
        return fail(
          reply,
          400,
          "BAD_INVITE",
          "This invite is not signed by your account. No pass was made.",
          "nothing-stored",
        );
      const inv = parsed.data;
      if (inv.holder === me) return fail(reply, 400, "SELF", "A pass is for someone else.", "nothing-stored");
      if (!(await verified<PassInvite>(b.data.invite, me)))
        return fail(
          reply,
          400,
          "BAD_SIGNATURE",
          "The signature does not match your key on chain. No pass was made.",
          "nothing-stored",
        );
      const [card] = await db.select({ a: cards.address }).from(cards).where(eq(cards.address, inv.holder));
      if (!card)
        return fail(
          reply,
          400,
          "NO_ACCOUNT",
          "That person has no Mizuhiki key yet, so nothing can be sealed to them. Ask them to make an account first.",
          "nothing-stored",
        );
      const [exists] = await db.select({ id: passes.id }).from(passes).where(eq(passes.id, inv.id));
      if (exists) return fail(reply, 409, "TAKEN", "That pass id is taken. Try again.", "nothing-stored");
      const keyIndex = inv.scope.kind === "period" ? inv.scope.keyIndex : null;
      if (keyIndex !== null) {
        const [clash] = await db
          .select({ id: passes.id })
          .from(passes)
          .where(and(eq(passes.owner, me), eq(passes.keyIndex, keyIndex)));
        if (clash)
          return fail(reply, 409, "KEY_TAKEN", "That pass key is already in use. Try again.", "nothing-stored");
        // A signed page lists at most 16 pass keys.
        const [live] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(passes)
          .where(
            and(
              eq(passes.owner, me),
              sql`${passes.keyIndex} is not null`,
              inArray(passes.status, ["invited", "accepted", "active"]),
              or(isNull(passes.expiresAt), gt(passes.expiresAt, new Date())),
            ),
          );
        if ((live?.n ?? 0) >= 16)
          return fail(
            reply,
            409,
            "TOO_MANY",
            "You have 16 period passes in use. Revoke one before making another.",
            "nothing-stored",
          );
      }
      await db.insert(passes).values({
        id: inv.id,
        owner: me,
        holder: inv.holder,
        invite: b.data.invite,
        keyIndex,
        expiresAt: inv.expiresAt ? new Date(inv.expiresAt) : null,
      });
      await notify("pass", inv.holder);
      return reply.code(201).send({ id: inv.id });
    });

    app.get("/owner/passes", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db.select().from(passes).where(eq(passes.owner, me)).orderBy(desc(passes.createdAt));
      const counts = rows.length
        ? await db
            .select({ id: passItems.passId, n: sql<number>`count(*)::int` })
            .from(passItems)
            .where(
              inArray(
                passItems.passId,
                rows.map((r) => r.id),
              ),
            )
            .groupBy(passItems.passId)
        : [];
      // The next free key index, so the owner's device can make a new period key without a clash.
      const [max] = await db
        .select({ n: sql<number | null>`max(${passes.keyIndex})` })
        .from(passes)
        .where(eq(passes.owner, me));
      return {
        passes: rows.map((p) => ({ ...view(p), resealed: counts.find((c) => c.id === p.id)?.n ?? 0 })),
        nextKeyIndex: Math.max(2_000_000, (max?.n ?? 1_999_999) + 1),
      };
    });

    app.get("/passes/mine", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db.select().from(passes).where(eq(passes.holder, me)).orderBy(desc(passes.createdAt));
      return { passes: rows.map(view) };
    });

    app.get("/passes/:id", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const p = await passFor((req.params as { id: string }).id, me);
      if (!p) return fail(reply, 404, "NOT_FOUND", "This pass does not exist or is not for you.");
      return view(p);
    });

    app.post("/passes/:id/accept", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const id = (req.params as { id: string }).id;
      const [p] = await db
        .select()
        .from(passes)
        .where(and(eq(passes.id, id), eq(passes.holder, me)));
      if (!p) return fail(reply, 404, "NOT_FOUND", "This pass does not exist or is not for you.");
      if (p.status !== "invited") return fail(reply, 409, "NOT_INVITED", "This pass is no longer waiting for you.");
      const b = z.object({ accept: SignedShape }).safeParse(req.body);
      const a = b.success ? PassAcceptSchema.safeParse(b.data.accept.body) : null;
      if (!b.success || !a?.success || a.data.id !== id || a.data.holder !== me || b.data.accept.signer !== me)
        return fail(reply, 400, "BAD_ACCEPT", "This acceptance is not signed by your account. Nothing changed.");
      if (!(await verified(b.data.accept, me)))
        return fail(reply, 400, "BAD_SIGNATURE", "The signature does not match your key on chain. Nothing changed.");
      await db
        .update(passes)
        .set({ accept: b.data.accept, status: "accepted", acceptedAt: new Date() })
        .where(eq(passes.id, id));
      await notify("pass", p.owner);
      return { ok: true };
    });

    app.post("/passes/:id/decline", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const id = (req.params as { id: string }).id;
      const [p] = await db
        .select()
        .from(passes)
        .where(and(eq(passes.id, id), eq(passes.holder, me)));
      if (!p) return fail(reply, 404, "NOT_FOUND", "This pass does not exist or is not for you.");
      if (p.status !== "invited") return fail(reply, 409, "NOT_INVITED", "This pass is no longer waiting for you.");
      await db.update(passes).set({ status: "declined" }).where(eq(passes.id, id));
      await notify("pass", p.owner);
      return { ok: true };
    });

    /** The owner confirms after comparing safety words; the key (when the scope needs one) arrives sealed to the holder. */
    app.post("/passes/:id/confirm", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.", "nothing-stored");
      const id = (req.params as { id: string }).id;
      const b = z.object({ keyEnvelope: z.string().regex(HASH).nullable() }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.", "nothing-stored");
      const [p] = await db
        .select()
        .from(passes)
        .where(and(eq(passes.id, id), eq(passes.owner, me)));
      if (!p) return fail(reply, 404, "NOT_FOUND", "No such pass.", "nothing-stored");
      if (p.status !== "accepted")
        return fail(reply, 409, "NOT_ACCEPTED", "This pass has not been accepted yet.", "nothing-stored");
      const scope = inviteOf(p).scope;
      const needsKey = scope.kind === "period" || scope.kind === "product";
      if (needsKey !== (b.data.keyEnvelope !== null))
        return fail(
          reply,
          400,
          "KEY",
          needsKey ? "This pass needs its key sealed to the holder." : "This pass shares no key.",
          "nothing-stored",
        );
      if (b.data.keyEnvelope) {
        const [blob] = await db.select({ h: blobs.hash }).from(blobs).where(eq(blobs.hash, b.data.keyEnvelope));
        if (!blob) return fail(reply, 409, "MISSING_PARTS", "The sealed key did not arrive.", "nothing-stored");
        await hold(db, [b.data.keyEnvelope], me, `pass:${id}`);
      }
      await db
        .update(passes)
        .set({ status: "active", keyEnvelope: b.data.keyEnvelope, confirmedAt: new Date() })
        .where(eq(passes.id, id));
      await notify("pass", p.holder);
      return { ok: true };
    });

    app.post("/passes/:id/revoke", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const id = (req.params as { id: string }).id;
      const [p] = await db
        .select()
        .from(passes)
        .where(and(eq(passes.id, id), eq(passes.owner, me)));
      if (!p) return fail(reply, 404, "NOT_FOUND", "No such pass.");
      await db.update(passes).set({ status: "revoked", revokedAt: new Date() }).where(eq(passes.id, id));
      await notify("pass", p.holder);
      return { ok: true };
    });

    /** Older items (or one item from "Add a reader") re-sealed to the pass by the owner's device. */
    app.post("/passes/:id/items", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.", "nothing-stored");
      const id = (req.params as { id: string }).id;
      const b = z
        .object({
          items: z
            .array(
              z.object({
                source: z.string().min(6).max(80),
                kind: z.string().max(20),
                envelope: z.string().regex(HASH),
                itemAt: z.iso.datetime(),
              }),
            )
            .min(1)
            .max(500),
        })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing was added.", "nothing-stored");
      const [p] = await db
        .select()
        .from(passes)
        .where(and(eq(passes.id, id), eq(passes.owner, me)));
      if (!p) return fail(reply, 404, "NOT_FOUND", "No such pass.", "nothing-stored");
      if (statusOf(p) !== "active")
        return fail(reply, 409, "NOT_ACTIVE", "Items can be added only to an active pass.", "nothing-stored");
      const hashes = b.data.items.map((i) => i.envelope);
      const found = await db.select({ h: blobs.hash }).from(blobs).where(inArray(blobs.hash, hashes));
      if (new Set(found.map((f) => f.h)).size !== new Set(hashes).size)
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "Some sealed copies did not arrive. Nothing was added.",
          "nothing-stored",
        );
      await db.transaction(async (tx) => {
        await hold(tx, hashes, me, `pass:${id}`);
        for (const i of b.data.items)
          await tx
            .insert(passItems)
            .values({ passId: id, source: i.source, kind: i.kind, envelope: i.envelope, itemAt: new Date(i.itemAt) })
            .onConflictDoUpdate({ target: [passItems.passId, passItems.source], set: { envelope: i.envelope } });
      });
      await notify("pass", p.holder);
      return { ok: true, added: b.data.items.length };
    });

    /**
     * What a pass covers: copies re-sealed to it by the owner's device (older items, invoices, "Add a reader"),
     * plus the owner's inbox items in its scope that senders sealed to it directly (metadata only; the holder's
     * device opens what it can, and the owner's device re-seals what it cannot). Owner and holder may both look.
     */
    app.get("/passes/:id/items", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const p = await passFor((req.params as { id: string }).id, me);
      if (!p) return fail(reply, 404, "NOT_FOUND", "This pass does not exist or is not for you.");
      const st = statusOf(p);
      if (p.holder === me && st !== "active" && st !== "expired" && st !== "revoked")
        return { resealed: [], live: [], status: st };
      const resealed = await db
        .select()
        .from(passItems)
        .where(eq(passItems.passId, p.id))
        .orderBy(asc(passItems.itemAt));
      const scope: PassScope = inviteOf(p).scope;
      const live: { source: string; kind: string; envelope: string; itemAt: Date; ref: string | null }[] = [];
      if (scope.kind === "period" || scope.kind === "form") {
        const from = scope.kind === "period" ? new Date(scope.from) : new Date(0);
        // Items sent after the pass stopped covering new ones are never sealed to it.
        const ends = [scope.kind === "period" ? new Date(scope.until) : null, p.expiresAt, p.revokedAt].filter(
          (d): d is Date => !!d,
        );
        const until = ends.length ? new Date(Math.min(...ends.map((d) => d.getTime()))) : new Date(8.64e15);
        const kinds = scope.kind === "period" ? scope.kinds.flatMap((k) => ENVELOPE_KINDS[k] ?? []) : ["form"];
        if (kinds.length) {
          const rows = await db
            .select({ hash: envelopes.hash, kind: envelopes.kind, at: envelopes.createdAt, ref: envelopes.ref })
            .from(envelopes)
            .where(
              and(
                eq(envelopes.owner, p.owner),
                inArray(envelopes.kind, kinds),
                gte(envelopes.createdAt, from),
                lt(envelopes.createdAt, until),
                ...(scope.kind === "form" ? [eq(envelopes.ref, `form:${scope.formId}`)] : []),
              ),
            )
            .orderBy(asc(envelopes.createdAt))
            .limit(2000);
          for (const r of rows) live.push({ source: r.hash, kind: r.kind, envelope: r.hash, itemAt: r.at, ref: r.ref });
        }
      }
      return { resealed, live, status: st };
    });

    done();
  };
