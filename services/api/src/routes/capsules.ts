/**
 * Capsules (spec 5.14, ARCHITECTURE 8e). CapsuleVault on QoreChain decides
 * release; this keeps the owner's sealed working copy, guardians' signed
 * consent, the signed plan (checked against the hash on chain), and the
 * envelopes guardians re-seal to recipients after release. Every release
 * envelope is accepted only while the chain says Released and the access
 * window is open.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { parseAddress } from "@qorechain/qoresign";
import {
  CapsuleAcceptSchema,
  CapsuleInviteSchema,
  CapsulePlanSchema,
  MODE_INDEX,
  planHash,
  planProblems,
  verifyRecord,
  type CapsulePlan,
  type Signed,
} from "@mizuhiki/core";
import { chainNow, readCapsule } from "@mizuhiki/chain";
import { blobs, cards, capsuleGuardians, capsuleReleases, capsules } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { pqKeyOf } from "../lib/chainreads";
import { fail } from "../lib/http";
import { hold, release, setHoldExpiry } from "../lib/holds";

const ID = /^[0-9a-f]{64}$/;
const HASH = /^[0-9a-f]{64}$/;
const ADDR = /^qor1[02-9ac-hj-np-z]{38}$/;
const SignedShape = z.object({
  kind: z.literal("capsule"),
  signer: z.string(),
  body: z.unknown(),
  signature: z.unknown(),
});
const evmOf = (a: string) => parseAddress(a).hex.toLowerCase();

export const capsuleRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;
    const notify = async (address: string) => {
      await db.execute(sql`select pg_notify('mzk_events', ${`capsule:${address}`})`);
    };
    const verified = async <T>(rec: unknown, signer: string): Promise<T | null> => {
      const key = await pqKeyOf(signer);
      if (!key.publicKey || !key.possessionProven) return null;
      try {
        return verifyRecord(rec as Signed<T>, { kind: "capsule", signer, pqPublicKey: key.publicKey });
      } catch {
        return null;
      }
    };
    const own = async (id: string, me: string) => {
      const [c] = await db
        .select()
        .from(capsules)
        .where(and(eq(capsules.id, id), eq(capsules.owner, me)));
      return c;
    };
    const planOf = (c: typeof capsules.$inferSelect) => (c.plan ? (c.plan as Signed<CapsulePlan>) : null);
    const blobsExist = async (hashes: string[]) => {
      if (hashes.length === 0) return true;
      const found = await db.select({ h: blobs.hash }).from(blobs).where(inArray(blobs.hash, hashes));
      return new Set(found.map((f) => f.h)).size === new Set(hashes).size;
    };

    // ---- owner -------------------------------------------------------------------------------------

    app.get("/owner/capsules", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db.select().from(capsules).where(eq(capsules.owner, me)).orderBy(desc(capsules.createdAt));
      const ids = rows.map((r) => r.id);
      const gs = ids.length
        ? await db
            .select()
            .from(capsuleGuardians)
            .where(inArray(capsuleGuardians.capsuleId, ids))
            .orderBy(asc(capsuleGuardians.createdAt))
        : [];
      const rs = ids.length
        ? await db.select().from(capsuleReleases).where(inArray(capsuleReleases.capsuleId, ids))
        : [];
      return {
        capsules: rows.map((c) => ({
          id: c.id,
          label: c.label,
          state: c.state,
          draftEnvelope: c.draftEnvelope,
          plan: c.plan,
          armedTx: c.armedTx,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
          guardians: gs
            .filter((g) => g.capsuleId === c.id && g.status !== "removed")
            .map((g) => ({ guardian: g.guardian, status: g.status, invite: g.invite, accept: g.accept })),
          releases: rs
            .filter((r) => r.capsuleId === c.id)
            .map((r) => ({ guardian: r.guardian, recipient: r.recipient, at: r.createdAt })),
        })),
      };
    });

    /** Create or update the owner's working copy (sealed to the owner only). */
    app.put("/owner/capsules", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was saved.", "nothing-stored");
      const b = z
        .object({
          id: z.string().regex(ID),
          label: z.string().trim().min(1).max(80),
          draftEnvelope: z.string().regex(HASH),
        })
        .safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "The capsule was incomplete. Nothing was saved.", "nothing-stored");
      const [existing] = await db.select().from(capsules).where(eq(capsules.id, b.data.id));
      if (existing && existing.owner !== me)
        return fail(reply, 409, "TAKEN", "That capsule id is taken. Nothing was saved.", "nothing-stored");
      if (existing?.state === "cancelled")
        return fail(reply, 409, "CANCELLED", "This capsule was cancelled. Make a new one.", "nothing-stored");
      if (!(await blobsExist([b.data.draftEnvelope])))
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "The sealed copy did not arrive. Nothing was saved.",
          "nothing-stored",
        );
      await db.transaction(async (tx) => {
        await release(tx, me, `capsule-draft:${b.data.id}`);
        await hold(tx, [b.data.draftEnvelope], me, `capsule-draft:${b.data.id}`);
      });
      await db
        .insert(capsules)
        .values({ id: b.data.id, owner: me, label: b.data.label, draftEnvelope: b.data.draftEnvelope })
        .onConflictDoUpdate({
          target: capsules.id,
          set: { label: b.data.label, draftEnvelope: b.data.draftEnvelope, updatedAt: new Date() },
        });
      return { ok: true };
    });

    app.delete("/owner/capsules/:id", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const c = await own(id, me);
      if (!c) return fail(reply, 404, "NOT_FOUND", "No such capsule.");
      if (c.state !== "draft") return fail(reply, 409, "ARMED", "An armed capsule is cancelled, not deleted.");
      const gs = await db.select().from(capsuleGuardians).where(eq(capsuleGuardians.capsuleId, id));
      await db.delete(capsuleGuardians).where(eq(capsuleGuardians.capsuleId, id));
      await db.delete(capsules).where(eq(capsules.id, id));
      await release(db, me, `capsule-draft:${id}`);
      for (const g of gs) await notify(g.guardian);
      return { ok: true };
    });

    app.post("/owner/capsules/:id/guardians", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { id } = req.params as { id: string };
      const c = await own(id, me);
      if (!c) return fail(reply, 404, "NOT_FOUND", "Save the capsule first.");
      if (c.state === "cancelled") return fail(reply, 409, "CANCELLED", "This capsule was cancelled.");
      const b = z.object({ invite: SignedShape }).safeParse(req.body);
      const inv = b.success ? CapsuleInviteSchema.safeParse(b.data.invite.body) : null;
      if (
        !b.success ||
        !inv?.success ||
        inv.data.owner !== me ||
        inv.data.capsule !== id ||
        b.data.invite.signer !== me
      )
        return fail(reply, 400, "BAD_INVITE", "This invite is not signed by your account. Nothing changed.");
      if (inv.data.guardian === me) return fail(reply, 400, "SELF", "You cannot be your own guardian.");
      if (!(await verified(b.data.invite, me)))
        return fail(reply, 400, "BAD_SIGNATURE", "The signature does not match your key on chain. Nothing changed.");
      const [card] = await db.select({ a: cards.address }).from(cards).where(eq(cards.address, inv.data.guardian));
      if (!card)
        return fail(
          reply,
          400,
          "NO_ACCOUNT",
          "That person has no Mizuhiki key yet, so no piece can be sealed to them.",
        );
      const live = (await db.select().from(capsuleGuardians).where(eq(capsuleGuardians.capsuleId, id))).filter(
        (g) => g.status !== "removed" && g.status !== "declined",
      );
      if (live.some((g) => g.guardian === inv.data.guardian))
        return fail(reply, 409, "ALREADY", "They are already a guardian of this capsule.");
      if (live.length >= 16) return fail(reply, 409, "TOO_MANY", "A capsule can have up to 16 guardians.");
      await db
        .insert(capsuleGuardians)
        .values({ capsuleId: id, guardian: inv.data.guardian, invite: b.data.invite })
        .onConflictDoUpdate({
          target: [capsuleGuardians.capsuleId, capsuleGuardians.guardian],
          set: { invite: b.data.invite, status: "invited", accept: null, updatedAt: new Date() },
        });
      await notify(inv.data.guardian);
      return reply.code(201).send({ ok: true });
    });

    app.post("/owner/capsules/:id/guardians/:g/confirm", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id, g } = req.params as { id: string; g: string };
      if (!(await own(id, me))) return fail(reply, 404, "NOT_FOUND", "No such capsule.");
      const [row] = await db
        .select()
        .from(capsuleGuardians)
        .where(and(eq(capsuleGuardians.capsuleId, id), eq(capsuleGuardians.guardian, g)));
      if (row?.status !== "accepted") return fail(reply, 409, "NOT_ACCEPTED", "They have not accepted yet.");
      await db
        .update(capsuleGuardians)
        .set({ status: "confirmed", updatedAt: new Date() })
        .where(and(eq(capsuleGuardians.capsuleId, id), eq(capsuleGuardians.guardian, g)));
      return { ok: true };
    });

    app.delete("/owner/capsules/:id/guardians/:g", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id, g } = req.params as { id: string; g: string };
      if (!(await own(id, me))) return fail(reply, 404, "NOT_FOUND", "No such capsule.");
      await db
        .update(capsuleGuardians)
        .set({ status: "removed", updatedAt: new Date() })
        .where(and(eq(capsuleGuardians.capsuleId, id), eq(capsuleGuardians.guardian, g)));
      // Removal is not announced to the removed person (spec 5.14); their pieces stop fitting once the owner re-arms.
      return { ok: true };
    });

    /** The signed plan, after `create` or `setGuardians` on chain: checked against the chain before it is kept. */
    app.put("/owner/capsules/:id/plan", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was armed.", "nothing-stored");
      const { id } = req.params as { id: string };
      const c = await own(id, me);
      if (!c) return fail(reply, 404, "NOT_FOUND", "No such capsule.", "nothing-stored");
      const b = z.object({ plan: SignedShape, txHash: z.string().regex(/^0x[0-9a-f]{64}$/i) }).safeParse(req.body);
      const parsed = b.success ? CapsulePlanSchema.safeParse(b.data.plan.body) : null;
      if (
        !b.success ||
        !parsed?.success ||
        parsed.data.id !== id ||
        parsed.data.owner !== me ||
        b.data.plan.signer !== me
      )
        return fail(
          reply,
          400,
          "BAD_PLAN",
          "This plan is not signed by your account for this capsule. Nothing was armed.",
          "nothing-stored",
        );
      const plan = parsed.data;
      const problems = planProblems(plan);
      if (problems.length)
        return fail(
          reply,
          400,
          "BAD_PLAN",
          `${problems[0] ?? "The plan is not valid."} Nothing was armed.`,
          "nothing-stored",
        );
      const prior = planOf(c);
      if (prior && plan.version <= prior.body.version)
        return fail(reply, 409, "STALE", "A newer plan is already armed. Reload and try again.", "nothing-stored");
      if (!(await verified(b.data.plan, me)))
        return fail(
          reply,
          400,
          "BAD_SIGNATURE",
          "The signature does not match your key on chain. Nothing was armed.",
          "nothing-stored",
        );
      const confirmed = (
        await db
          .select()
          .from(capsuleGuardians)
          .where(and(eq(capsuleGuardians.capsuleId, id), eq(capsuleGuardians.status, "confirmed")))
      ).map((g) => g.guardian);
      if (plan.guardians.length !== confirmed.length || !plan.guardians.every((g) => confirmed.includes(g)))
        return fail(
          reply,
          409,
          "GUARDIANS",
          "Every guardian in the plan must have accepted and been confirmed by you. Nothing was armed.",
          "nothing-stored",
        );
      const hashes = [...plan.recipients.map((r) => r.content), ...plan.pieces.map((p) => p.envelope)];
      if (!(await blobsExist(hashes)))
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "Some sealed parts did not arrive. Nothing was armed.",
          "nothing-stored",
        );
      // The chain is the source of truth: the plan we keep must be the one it holds.
      const chain = await readCapsule(`0x${id}`);
      if (!chain.owner || chain.owner.toLowerCase() !== evmOf(me))
        return fail(
          reply,
          409,
          "NOT_ON_CHAIN",
          "QoreChain has no capsule with this id for your account yet. Nothing was armed.",
          "nothing-stored",
        );
      if (chain.planHash.toLowerCase() !== planHash(plan).toLowerCase())
        return fail(
          reply,
          409,
          "PLAN_MISMATCH",
          "The plan does not match the one recorded on QoreChain. Nothing was armed.",
          "nothing-stored",
        );
      const chainGuardians = chain.guardians.map((g) => g.toLowerCase()).sort();
      if (
        chain.threshold !== plan.threshold ||
        chainGuardians.join() !== plan.guardians.map(evmOf).sort().join() ||
        chain.mode !== MODE_INDEX[plan.mode]
      )
        return fail(
          reply,
          409,
          "PLAN_MISMATCH",
          "The guardians or mode differ from QoreChain's record. Nothing was armed.",
          "nothing-stored",
        );
      await db.transaction(async (tx) => {
        // The armed plan's content and pieces are kept by the owner (also through a later page delete).
        await release(tx, me, `capsule:${id}`);
        await hold(tx, hashes, me, `capsule:${id}`);
        await tx
          .update(capsules)
          .set({ plan: b.data.plan, state: "armed", armedTx: b.data.txHash, label: plan.label, updatedAt: new Date() })
          .where(eq(capsules.id, id));
      });
      for (const a of new Set([...plan.guardians, ...plan.recipients.map((r) => r.address)])) await notify(a);
      return { ok: true };
    });

    app.post("/owner/capsules/:id/cancelled", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const c = await own(id, me);
      if (!c) return fail(reply, 404, "NOT_FOUND", "No such capsule.");
      const chain = await readCapsule(`0x${id}`);
      if (chain.status !== "cancelled")
        return fail(reply, 409, "NOT_CANCELLED", "QoreChain does not show this capsule as cancelled yet.");
      await db.update(capsules).set({ state: "cancelled", updatedAt: new Date() }).where(eq(capsules.id, id));
      // Cancelled on chain: nothing will open, so the sealed contents and every piece are let go. The owner's own
      // working copy stays: the cancelled capsule is still in their list and opens to show what it was.
      await release(db, me, `capsule:${id}`);
      const plan = planOf(c);
      if (plan)
        for (const a of new Set([...plan.body.guardians, ...plan.body.recipients.map((r) => r.address)]))
          await notify(a);
      return { ok: true };
    });

    // ---- guardian ----------------------------------------------------------------------------------

    app.get("/capsules/guarding", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const mine = await db
        .select()
        .from(capsuleGuardians)
        .where(eq(capsuleGuardians.guardian, me))
        .orderBy(desc(capsuleGuardians.createdAt));
      const live = mine.filter((g) => g.status !== "removed");
      const ids = live.map((g) => g.capsuleId);
      const rows = ids.length ? await db.select().from(capsules).where(inArray(capsules.id, ids)) : [];
      const rel = ids.length
        ? await db
            .select()
            .from(capsuleReleases)
            .where(and(inArray(capsuleReleases.capsuleId, ids), eq(capsuleReleases.guardian, me)))
        : [];
      return {
        capsules: live.flatMap((g) => {
          const c = rows.find((r) => r.id === g.capsuleId);
          if (!c) return [];
          const plan = planOf(c);
          // A guardian sees the plan only if it names them (a later plan may have dropped them).
          const inPlan = plan?.body.guardians.includes(me) ?? false;
          return [
            {
              id: c.id,
              owner: c.owner,
              label: c.label,
              state: c.state,
              status: g.status,
              invite: g.invite,
              plan: inPlan ? plan : null,
              released: rel
                .filter((r) => r.capsuleId === c.id)
                .map((r) => ({ recipient: r.recipient, version: r.planVersion })),
            },
          ];
        }),
      };
    });

    const guardianRow = async (id: string, me: string) => {
      const [g] = await db
        .select()
        .from(capsuleGuardians)
        .where(and(eq(capsuleGuardians.capsuleId, id), eq(capsuleGuardians.guardian, me)));
      return g;
    };

    app.post("/capsules/:id/accept", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { id } = req.params as { id: string };
      const g = await guardianRow(id, me);
      if (!g || g.status === "removed")
        return fail(reply, 404, "NOT_FOUND", "You were not asked to guard this capsule.");
      if (g.status !== "invited") return fail(reply, 409, "NOT_INVITED", "This request is no longer waiting for you.");
      const [c] = await db.select().from(capsules).where(eq(capsules.id, id));
      const b = z.object({ accept: SignedShape }).safeParse(req.body);
      const a = b.success ? CapsuleAcceptSchema.safeParse(b.data.accept.body) : null;
      if (
        !c ||
        !b.success ||
        !a?.success ||
        a.data.capsule !== id ||
        a.data.guardian !== me ||
        a.data.owner !== c.owner ||
        b.data.accept.signer !== me
      )
        return fail(reply, 400, "BAD_ACCEPT", "This acceptance is not signed by your account. Nothing changed.");
      if (!(await verified(b.data.accept, me)))
        return fail(reply, 400, "BAD_SIGNATURE", "The signature does not match your key on chain. Nothing changed.");
      await db
        .update(capsuleGuardians)
        .set({ status: "accepted", accept: b.data.accept, updatedAt: new Date() })
        .where(and(eq(capsuleGuardians.capsuleId, id), eq(capsuleGuardians.guardian, me)));
      await notify(c.owner);
      return { ok: true };
    });

    app.post("/capsules/:id/decline", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const g = await guardianRow(id, me);
      if (!g || g.status === "removed") return fail(reply, 404, "NOT_FOUND", "You are not a guardian of this capsule.");
      await db
        .update(capsuleGuardians)
        .set({ status: "declined", updatedAt: new Date() })
        .where(and(eq(capsuleGuardians.capsuleId, id), eq(capsuleGuardians.guardian, me)));
      const [c] = await db.select({ owner: capsules.owner }).from(capsules).where(eq(capsules.id, id));
      if (c) await notify(c.owner);
      return { ok: true };
    });

    /** A guardian's pieces, re-sealed on their device to each recipient, accepted only while the chain says Released and the window is open. */
    app.post("/capsules/:id/release", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was sent.", "nothing-stored");
      const { id } = req.params as { id: string };
      const b = z
        .object({
          version: z.number().int().min(1),
          items: z
            .array(z.object({ recipient: z.string().regex(ADDR), envelope: z.string().regex(HASH) }))
            .min(1)
            .max(10),
        })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing was sent.", "nothing-stored");
      const [c] = await db.select().from(capsules).where(eq(capsules.id, id));
      const plan = c ? planOf(c) : null;
      if (!c || !plan || c.state !== "armed")
        return fail(reply, 404, "NOT_FOUND", "This capsule is not armed.", "nothing-stored");
      if (plan.body.version !== b.data.version || !plan.body.guardians.includes(me))
        return fail(
          reply,
          403,
          "NOT_A_GUARDIAN",
          "You do not hold pieces of this capsule's current plan.",
          "nothing-stored",
        );
      if (!b.data.items.every((i) => plan.body.recipients.some((r) => r.address === i.recipient)))
        return fail(reply, 400, "NOT_A_RECIPIENT", "Pieces go only to the recipients in the plan.", "nothing-stored");
      const chain = await readCapsule(`0x${id}`);
      if (chain.status !== "released")
        return fail(
          reply,
          409,
          "NOT_RELEASED",
          "QoreChain does not show this capsule as released. Nothing was sent.",
          "nothing-stored",
        );
      const windowEnd = Number(chain.releasedAt + chain.accessSeconds);
      if (Number(await chainNow()) >= windowEnd)
        return fail(
          reply,
          409,
          "WINDOW_OVER",
          "The time to collect this capsule has ended. Nothing was sent.",
          "nothing-stored",
        );
      if (!(await blobsExist(b.data.items.map((i) => i.envelope))))
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "Some sealed pieces did not arrive. Nothing was sent.",
          "nothing-stored",
        );
      const expiresAt = plan.body.deleteAfter ? new Date(windowEnd * 1000) : null;
      await db.transaction(async (tx) => {
        // The guardian keeps the pieces they handed over for the access window (or for good).
        await hold(
          tx,
          b.data.items.map((i) => i.envelope),
          me,
          `capsule:${id}:release`,
          expiresAt,
        );
        // "Delete after the window", chosen in the owner's signed plan, ends the owner's hold on the content.
        if (expiresAt)
          await setHoldExpiry(
            tx,
            plan.signer,
            `capsule:${id}`,
            expiresAt,
            plan.body.recipients.map((r) => r.content),
          );
        for (const i of b.data.items)
          await tx
            .insert(capsuleReleases)
            .values({
              capsuleId: id,
              guardian: me,
              recipient: i.recipient,
              planVersion: plan.body.version,
              envelope: i.envelope,
            })
            .onConflictDoUpdate({
              target: [capsuleReleases.capsuleId, capsuleReleases.guardian, capsuleReleases.recipient],
              set: { envelope: i.envelope, planVersion: plan.body.version },
            });
      });
      for (const i of b.data.items) await notify(i.recipient);
      await notify(c.owner);
      return { ok: true };
    });

    // ---- recipient ---------------------------------------------------------------------------------

    app.get("/capsules/for-me", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db
        .select()
        .from(capsules)
        .where(
          and(
            inArray(capsules.state, ["armed", "cancelled"]),
            sql`${capsules.plan}->'body'->'recipients' @> ${JSON.stringify([{ address: me }])}::jsonb`,
          ),
        )
        .orderBy(desc(capsules.createdAt));
      const ids = rows.map((r) => r.id);
      const rel = ids.length
        ? await db
            .select()
            .from(capsuleReleases)
            .where(and(inArray(capsuleReleases.capsuleId, ids), eq(capsuleReleases.recipient, me)))
        : [];
      return {
        capsules: rows.map((c) => ({
          id: c.id,
          owner: c.owner,
          label: c.label,
          state: c.state,
          plan: c.plan,
          pieces: rel
            .filter((r) => r.capsuleId === c.id)
            .map((r) => ({ guardian: r.guardian, envelope: r.envelope, version: r.planVersion })),
        })),
      };
    });

    done();
  };
