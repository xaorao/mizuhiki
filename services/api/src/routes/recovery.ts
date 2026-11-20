/**
 * Spare key and recovery (spec 5.13, ARCHITECTURE 8d).
 *
 * Owner: contacts (signed invite, signed acceptance, confirmed after safety
 * words), the current set of pieces (envelopes sealed to each contact on the
 * owner's device), sheet and test marks, the offline reader key, cancel.
 * Contact: accept or decline, answer a request by re-sealing their piece to the
 * new device's one-time key. New device: open a request, poll it with its
 * secret; pieces are released only after the wait and only if not cancelled.
 * The server never holds anything it can open.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  checkPow,
  Purpose,
  RecoveryAcceptSchema,
  RecoveryInviteSchema,
  fromHex,
  randomBytes,
  sealItem,
  sha256Hex,
  toBase64Url,
  utf8,
  verifyRecord,
  type Signed,
} from "@mizuhiki/core";
import {
  blobs,
  cards,
  envelopes,
  names,
  recoveryAnswers,
  recoveryDismissals,
  recoveryChallenges,
  recoveryContacts,
  recoveryOfflineItems,
  recoveryRequests,
  recoverySettings,
} from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { pqKeyOf, ownerOfName } from "../lib/chainreads";
import { fail } from "../lib/http";
import { hold, release } from "../lib/holds";

const ADDR = /^qor1[02-9ac-hj-np-z]{38}$/;
const HASH = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;
const KeySchema = z.object({
  mlkem: z.string().regex(HEX).min(64).max(4000),
  x25519: z.string().regex(/^[0-9a-f]{64}$/),
});
/** The offline reader key, with when it was turned on (senders seal to it from then). */
const OfflineKeySchema = KeySchema.extend({ since: z.iso.datetime() });
const SignedShape = z.object({
  kind: z.literal("recovery"),
  signer: z.string(),
  body: z.unknown(),
  signature: z.unknown(),
});
const MAX_CONTACTS = 10;
const OPEN_PER_OWNER = 3;
const REQUEST_DAYS = 7;
/**
 * Kinds of the owner's items an offline reader can read (as the inbox): everything sealed to the owner's
 * recipient card, which carries the offline key. File-request uploads and invoices sent to the owner included.
 */
const OFFLINE_KINDS = ["message", "reply", "filedrop", "invoice", "paynote", "form"];

export const recoveryRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;
    const notify = async (kind: string, address: string) => {
      await db.execute(sql`select pg_notify('mzk_events', ${`${kind}:${address}`})`);
    };
    const verified = async <T>(rec: unknown, signer: string): Promise<T | null> => {
      const key = await pqKeyOf(signer);
      if (!key.publicKey || !key.possessionProven) return null;
      try {
        return verifyRecord(rec as Signed<T>, { kind: "recovery", signer, pqPublicKey: key.publicKey });
      } catch {
        return null;
      }
    };
    const settingsOf = async (owner: string) => {
      const [s] = await db.select().from(recoverySettings).where(eq(recoverySettings.owner, owner));
      return s ?? null;
    };
    const ensureSettings = async (owner: string) => {
      await db.insert(recoverySettings).values({ owner }).onConflictDoNothing();
      const s = await settingsOf(owner);
      if (!s) throw new Error("recovery settings missing after insert");
      return s;
    };
    /** Status as of now: a waiting request whose wait is over is ready; an old open one has expired. */
    const statusOf = (r: typeof recoveryRequests.$inferSelect): string => {
      if (r.status === "waiting" && r.releaseAt && r.releaseAt <= new Date()) return "ready";
      if ((r.status === "open" || r.status === "waiting") && r.expiresAt <= new Date()) return "expired";
      return r.status;
    };
    const answersOf = async (ids: string[]) =>
      ids.length
        ? await db
            .select()
            .from(recoveryAnswers)
            .where(inArray(recoveryAnswers.requestId, ids))
            .orderBy(asc(recoveryAnswers.createdAt))
        : [];
    const requestView = (r: typeof recoveryRequests.$inferSelect, answered: string[]) => ({
      id: r.id,
      owner: r.owner,
      recipient: r.recipient as { mlkem: string; x25519: string },
      test: r.test,
      version: r.version,
      threshold: r.threshold,
      status: statusOf(r),
      answered,
      createdAt: r.createdAt,
      releaseAt: r.releaseAt,
      cancelledAt: r.cancelledAt,
      expiresAt: r.expiresAt,
    });

    // ---- owner -------------------------------------------------------------------------------------

    app.get("/owner/recovery", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const s = await ensureSettings(me);
      const contacts = await db
        .select()
        .from(recoveryContacts)
        .where(eq(recoveryContacts.owner, me))
        .orderBy(asc(recoveryContacts.createdAt));
      const reqs = await db
        .select()
        .from(recoveryRequests)
        .where(eq(recoveryRequests.owner, me))
        .orderBy(desc(recoveryRequests.createdAt))
        .limit(20);
      const ans = await answersOf(reqs.map((r) => r.id));
      return {
        settings: {
          threshold: s.threshold,
          version: s.version,
          sheetSavedAt: s.sheetSavedAt,
          testedAt: s.testedAt,
          offlineKey: s.offlineKey,
          offlineSheetSavedAt: s.offlineSheetSavedAt,
        },
        contacts: contacts.map((c) => ({
          contact: c.contact,
          status: c.status,
          invite: c.invite,
          accept: c.accept,
          piece: c.piece,
          pieceVersion: c.pieceVersion,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        })),
        requests: reqs.map((r) =>
          requestView(
            r,
            ans.filter((a) => a.requestId === r.id).map((a) => a.contact),
          ),
        ),
      };
    });

    app.post("/owner/recovery/contacts", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const b = z.object({ invite: SignedShape }).safeParse(req.body);
      const inv = b.success ? RecoveryInviteSchema.safeParse(b.data.invite.body) : null;
      if (!b.success || !inv?.success || inv.data.owner !== me || b.data.invite.signer !== me)
        return fail(reply, 400, "BAD_INVITE", "This invite is not signed by your account. Nothing changed.");
      const contact = inv.data.contact;
      if (contact === me)
        return fail(
          reply,
          400,
          "SELF",
          "A recovery contact is someone else. Your own spare-key sheet already covers you.",
        );
      if (!(await verified(b.data.invite, me)))
        return fail(reply, 400, "BAD_SIGNATURE", "The signature does not match your key on chain. Nothing changed.");
      const [card] = await db.select({ a: cards.address }).from(cards).where(eq(cards.address, contact));
      if (!card)
        return fail(
          reply,
          400,
          "NO_ACCOUNT",
          "That person has no Mizuhiki key yet, so no piece can be sealed to them. Ask them to make an account first.",
        );
      const live = await db.select().from(recoveryContacts).where(eq(recoveryContacts.owner, me));
      const existing = live.find((c) => c.contact === contact);
      if (existing && existing.status !== "removed" && existing.status !== "declined")
        return fail(reply, 409, "ALREADY", "They are already one of your recovery contacts.");
      if (live.filter((c) => c.status !== "removed" && c.status !== "declined").length >= MAX_CONTACTS)
        return fail(reply, 409, "TOO_MANY", `You can have up to ${MAX_CONTACTS} recovery contacts.`);
      await ensureSettings(me);
      await db
        .insert(recoveryContacts)
        .values({ owner: me, contact, invite: b.data.invite, status: "invited" })
        .onConflictDoUpdate({
          target: [recoveryContacts.owner, recoveryContacts.contact],
          set: {
            invite: b.data.invite,
            status: "invited",
            accept: null,
            piece: null,
            pieceVersion: null,
            updatedAt: new Date(),
          },
        });
      await notify("recovery", contact);
      return reply.code(201).send({ ok: true });
    });

    app.post("/owner/recovery/contacts/:contact/confirm", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { contact } = req.params as { contact: string };
      const [c] = await db
        .select()
        .from(recoveryContacts)
        .where(and(eq(recoveryContacts.owner, me), eq(recoveryContacts.contact, contact)));
      if (!c) return fail(reply, 404, "NOT_FOUND", "No such contact.");
      if (c.status !== "accepted") return fail(reply, 409, "NOT_ACCEPTED", "They have not accepted yet.");
      await db
        .update(recoveryContacts)
        .set({ status: "confirmed", updatedAt: new Date() })
        .where(and(eq(recoveryContacts.owner, me), eq(recoveryContacts.contact, contact)));
      return { ok: true };
    });

    app.delete("/owner/recovery/contacts/:contact", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { contact } = req.params as { contact: string };
      const [c] = await db
        .select()
        .from(recoveryContacts)
        .where(and(eq(recoveryContacts.owner, me), eq(recoveryContacts.contact, contact)));
      if (!c) return fail(reply, 404, "NOT_FOUND", "No such contact.");
      await db
        .update(recoveryContacts)
        .set({ status: "removed", piece: null, pieceVersion: null, updatedAt: new Date() })
        .where(and(eq(recoveryContacts.owner, me), eq(recoveryContacts.contact, contact)));
      await notify("recovery", contact);
      return { ok: true };
    });

    /** A new set of pieces, one per confirmed contact, made and sealed on the owner's device. */
    app.put("/owner/recovery/pieces", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.", "nothing-stored");
      const b = z
        .object({
          version: z.number().int().min(1),
          threshold: z.number().int().min(2).max(MAX_CONTACTS),
          pieces: z
            .array(z.object({ contact: z.string().regex(ADDR), envelope: z.string().regex(HASH) }))
            .min(2)
            .max(MAX_CONTACTS),
        })
        .safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "The pieces were incomplete. Nothing changed.", "nothing-stored");
      const s = await ensureSettings(me);
      if (b.data.version !== s.version + 1)
        return fail(
          reply,
          409,
          "STALE",
          "Your pieces changed on another device. Reload and try again.",
          "nothing-stored",
        );
      if (b.data.threshold > b.data.pieces.length)
        return fail(reply, 400, "THRESHOLD", "More pieces are needed than there are contacts.", "nothing-stored");
      const confirmed = (
        await db
          .select()
          .from(recoveryContacts)
          .where(and(eq(recoveryContacts.owner, me), eq(recoveryContacts.status, "confirmed")))
      ).map((c) => c.contact);
      const given = b.data.pieces.map((p) => p.contact);
      if (
        new Set(given).size !== given.length ||
        given.length !== confirmed.length ||
        !given.every((g) => confirmed.includes(g))
      )
        return fail(
          reply,
          409,
          "CONTACTS_CHANGED",
          "Each confirmed contact needs exactly one piece. Reload and try again.",
          "nothing-stored",
        );
      const hashes = b.data.pieces.map((p) => p.envelope);
      const found = await db.select({ h: blobs.hash }).from(blobs).where(inArray(blobs.hash, hashes));
      if (new Set(found.map((f) => f.h)).size !== new Set(hashes).size)
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "Some sealed pieces did not arrive. Nothing changed.",
          "nothing-stored",
        );
      await db.transaction(async (tx) => {
        // A new split replaces the pieces: only the current version's pieces are kept.
        await release(tx, me, "recovery:owner:pieces");
        await hold(tx, hashes, me, "recovery:owner:pieces");
        for (const p of b.data.pieces)
          await tx
            .update(recoveryContacts)
            .set({ piece: p.envelope, pieceVersion: b.data.version, updatedAt: new Date() })
            .where(and(eq(recoveryContacts.owner, me), eq(recoveryContacts.contact, p.contact)));
        await tx
          .update(recoverySettings)
          .set({ version: b.data.version, threshold: b.data.threshold, updatedAt: new Date() })
          .where(eq(recoverySettings.owner, me));
        // Requests made against older pieces can no longer be answered.
        await tx
          .update(recoveryRequests)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(and(eq(recoveryRequests.owner, me), inArray(recoveryRequests.status, ["open", "waiting"])));
      });
      for (const c of given) await notify("recovery", c);
      return { ok: true, version: b.data.version };
    });

    app.post("/owner/recovery/marks", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const b = z
        .object({ sheet: z.boolean().optional(), offlineSheet: z.boolean().optional(), tested: z.string().optional() })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      await ensureSettings(me);
      const set: Partial<typeof recoverySettings.$inferInsert> = { updatedAt: new Date() };
      if (b.data.sheet) set.sheetSavedAt = new Date();
      if (b.data.offlineSheet) set.offlineSheetSavedAt = new Date();
      if (b.data.tested) {
        // A test counts only when that test request really had enough answers.
        const [r] = await db
          .select()
          .from(recoveryRequests)
          .where(
            and(
              eq(recoveryRequests.id, b.data.tested),
              eq(recoveryRequests.owner, me),
              eq(recoveryRequests.test, true),
            ),
          );
        const n = r ? (await answersOf([r.id])).length : 0;
        if (!r || n < r.threshold) return fail(reply, 409, "NOT_ENOUGH", "This test has not had enough answers yet.");
        set.testedAt = new Date();
        await db.update(recoveryRequests).set({ status: "done" }).where(eq(recoveryRequests.id, r.id));
      }
      await db.update(recoverySettings).set(set).where(eq(recoverySettings.owner, me));
      return { ok: true };
    });

    app.put("/owner/recovery/offline", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const b = z.object({ key: OfflineKeySchema.nullable() }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      await ensureSettings(me);
      await db
        .update(recoverySettings)
        .set({ offlineKey: b.data.key, offlineSheetSavedAt: null, updatedAt: new Date() })
        .where(eq(recoverySettings.owner, me));
      if (!b.data.key) await db.delete(recoveryOfflineItems).where(eq(recoveryOfflineItems.owner, me));
      return { ok: true };
    });

    app.post("/owner/recovery/offline/items", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.", "nothing-stored");
      const b = z
        .object({
          items: z
            .array(
              z.object({
                source: z.string().min(6).max(80),
                kind: z.string().max(20),
                ref: z.string().max(80).nullable(),
                envelope: z.string().regex(HASH),
                itemAt: z.iso.datetime(),
              }),
            )
            .min(1)
            .max(500),
        })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing was added.", "nothing-stored");
      const s = await settingsOf(me);
      if (!s?.offlineKey)
        return fail(reply, 409, "NO_OFFLINE_KEY", "Turn on the offline reader first.", "nothing-stored");
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
        await hold(tx, hashes, me, "recovery:owner:offline");
        for (const i of b.data.items)
          await tx
            .insert(recoveryOfflineItems)
            .values({
              owner: me,
              source: i.source,
              kind: i.kind,
              ref: i.ref,
              envelope: i.envelope,
              itemAt: new Date(i.itemAt),
            })
            .onConflictDoUpdate({
              target: [recoveryOfflineItems.owner, recoveryOfflineItems.source],
              set: { envelope: i.envelope },
            });
      });
      return { ok: true, added: b.data.items.length };
    });

    app.get("/owner/recovery/offline/items", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db
        .select({ source: recoveryOfflineItems.source })
        .from(recoveryOfflineItems)
        .where(eq(recoveryOfflineItems.owner, me));
      return { sources: rows.map((r) => r.source) };
    });

    /** A dry run: the signed-in owner opens a request; contacts answer as for real; there is no wait. */
    app.post("/owner/recovery/test", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was started.");
      const b = z.object({ recipient: KeySchema, secretHash: z.string().regex(HASH) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing was started.");
      const s = await settingsOf(me);
      if (!s || s.version === 0)
        return fail(reply, 409, "NO_PIECES", "Add recovery contacts and seal their pieces first.");
      // One test at a time.
      await db
        .update(recoveryRequests)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(
          and(
            eq(recoveryRequests.owner, me),
            eq(recoveryRequests.test, true),
            inArray(recoveryRequests.status, ["open", "waiting", "ready"]),
          ),
        );
      const id = `rq_${toBase64Url(randomBytes(18))}`;
      await db.insert(recoveryRequests).values({
        id,
        owner: me,
        recipient: b.data.recipient,
        secretHash: b.data.secretHash,
        test: true,
        version: s.version,
        threshold: s.threshold,
        expiresAt: new Date(Date.now() + REQUEST_DAYS * 86400_000),
      });
      for (const c of await db
        .select()
        .from(recoveryContacts)
        .where(and(eq(recoveryContacts.owner, me), eq(recoveryContacts.pieceVersion, s.version))))
        await notify("recovery", c.contact);
      return reply.code(201).send({ id });
    });

    app.post("/owner/recovery/requests/:id/cancel", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const [r] = await db
        .select()
        .from(recoveryRequests)
        .where(and(eq(recoveryRequests.id, id), eq(recoveryRequests.owner, me)));
      if (!r) return fail(reply, 404, "NOT_FOUND", "No such request.");
      const st = statusOf(r);
      if (st === "done")
        return fail(
          reply,
          409,
          "DONE",
          "That recovery already finished. If it was not you, move to a new account now.",
        );
      await db
        .update(recoveryRequests)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(recoveryRequests.id, id));
      for (const a of await answersOf([id])) await notify("recovery", a.contact);
      await notify("recovery", me);
      return { ok: true };
    });

    // ---- contact -----------------------------------------------------------------------------------

    app.get("/recovery/helping", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const mine = await db
        .select()
        .from(recoveryContacts)
        .where(eq(recoveryContacts.contact, me))
        .orderBy(asc(recoveryContacts.createdAt));
      const owners = mine.filter((c) => c.status === "confirmed" && c.piece).map((c) => c.owner);
      const reqs = owners.length
        ? await db
            .select()
            .from(recoveryRequests)
            .where(
              and(
                inArray(recoveryRequests.owner, owners),
                inArray(recoveryRequests.status, ["open", "waiting"]),
                gt(recoveryRequests.expiresAt, new Date()),
              ),
            )
            .orderBy(desc(recoveryRequests.createdAt))
        : [];
      const ans = await answersOf(reqs.map((r) => r.id));
      return {
        owners: mine
          .filter((c) => c.status !== "removed")
          .map((c) => ({
            owner: c.owner,
            status: c.status,
            invite: c.invite,
            piece: c.piece,
            pieceVersion: c.pieceVersion,
            updatedAt: c.updatedAt,
          })),
        requests: reqs
          .filter((r) => mine.some((c) => c.owner === r.owner && c.pieceVersion === r.version))
          .map((r) => ({
            ...requestView(
              r,
              ans.filter((a) => a.requestId === r.id).map((a) => a.contact),
            ),
            answeredByMe: ans.some((a) => a.requestId === r.id && a.contact === me),
          })),
      };
    });

    app.post("/recovery/helping/:owner/accept", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { owner } = req.params as { owner: string };
      const [c] = await db
        .select()
        .from(recoveryContacts)
        .where(and(eq(recoveryContacts.owner, owner), eq(recoveryContacts.contact, me)));
      if (!c) return fail(reply, 404, "NOT_FOUND", "You were not asked to be this person's recovery contact.");
      if (c.status !== "invited") return fail(reply, 409, "NOT_INVITED", "This request is no longer waiting for you.");
      const b = z.object({ accept: SignedShape }).safeParse(req.body);
      const a = b.success ? RecoveryAcceptSchema.safeParse(b.data.accept.body) : null;
      if (!b.success || !a?.success || a.data.owner !== owner || a.data.contact !== me || b.data.accept.signer !== me)
        return fail(reply, 400, "BAD_ACCEPT", "This acceptance is not signed by your account. Nothing changed.");
      if (!(await verified(b.data.accept, me)))
        return fail(reply, 400, "BAD_SIGNATURE", "The signature does not match your key on chain. Nothing changed.");
      await db
        .update(recoveryContacts)
        .set({ status: "accepted", accept: b.data.accept, updatedAt: new Date() })
        .where(and(eq(recoveryContacts.owner, owner), eq(recoveryContacts.contact, me)));
      await notify("recovery", owner);
      return { ok: true };
    });

    app.post("/recovery/helping/:owner/decline", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { owner } = req.params as { owner: string };
      const [c] = await db
        .select()
        .from(recoveryContacts)
        .where(and(eq(recoveryContacts.owner, owner), eq(recoveryContacts.contact, me)));
      if (!c || c.status === "removed")
        return fail(reply, 404, "NOT_FOUND", "You are not this person's recovery contact.");
      await db
        .update(recoveryContacts)
        .set({ status: "declined", piece: null, pieceVersion: null, updatedAt: new Date() })
        .where(and(eq(recoveryContacts.owner, owner), eq(recoveryContacts.contact, me)));
      await notify("recovery", owner);
      return { ok: true };
    });

    /** A contact's piece, re-sealed on their device to the new device's one-time key. */
    app.post("/recovery/requests/:id/answer", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was sent.", "nothing-stored");
      const { id } = req.params as { id: string };
      const b = z.object({ envelope: z.string().regex(HASH) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing was sent.", "nothing-stored");
      const [r] = await db.select().from(recoveryRequests).where(eq(recoveryRequests.id, id));
      if (!r) return fail(reply, 404, "NOT_FOUND", "This recovery request does not exist.", "nothing-stored");
      const [c] = await db
        .select()
        .from(recoveryContacts)
        .where(and(eq(recoveryContacts.owner, r.owner), eq(recoveryContacts.contact, me)));
      if (!c || c.status !== "confirmed" || c.pieceVersion !== r.version)
        return fail(reply, 403, "NOT_A_CONTACT", "You do not hold a current piece for this person.", "nothing-stored");
      const [dismissed] = await db
        .select({ c: recoveryDismissals.contact })
        .from(recoveryDismissals)
        .where(and(eq(recoveryDismissals.requestId, id), eq(recoveryDismissals.contact, me)));
      if (dismissed)
        return fail(
          reply,
          409,
          "DISMISSED",
          "You said you did not recognise this request. Nothing was sent.",
          "nothing-stored",
        );
      const st = statusOf(r);
      if (st !== "open" && st !== "waiting")
        return fail(
          reply,
          409,
          "CLOSED",
          st === "cancelled"
            ? "This recovery was cancelled. Nothing was sent."
            : "This recovery is no longer open. Nothing was sent.",
          "nothing-stored",
        );
      const [blob] = await db.select({ h: blobs.hash }).from(blobs).where(eq(blobs.hash, b.data.envelope));
      if (!blob)
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "The sealed piece did not arrive. Nothing was sent.",
          "nothing-stored",
        );
      // The contact keeps their answer only as long as the request lives.
      await hold(db, [b.data.envelope], me, `recovery:answer:${id}`, r.expiresAt);
      await db
        .insert(recoveryAnswers)
        .values({ requestId: id, contact: me, envelope: b.data.envelope })
        .onConflictDoUpdate({
          target: [recoveryAnswers.requestId, recoveryAnswers.contact],
          set: { envelope: b.data.envelope },
        });
      const n = (await answersOf([id])).length;
      if (r.status === "open" && n >= r.threshold) {
        const releaseAt = new Date(Date.now() + (r.test ? 0 : ctx.cfg.RECOVERY_DELAY_SECONDS * 1000));
        await db.update(recoveryRequests).set({ status: "waiting", releaseAt }).where(eq(recoveryRequests.id, id));
      }
      // The owner's dashboards show every answer, so a recovery they did not start can be cancelled.
      await notify("recovery", r.owner);
      return { ok: true, answered: n, threshold: r.threshold };
    });

    /**
     * A contact does not recognise this request (the words did not match, or nobody asked them): they will
     * not answer it, and once too few contacts are left to reach the threshold it is cancelled.
     */
    app.post("/recovery/requests/:id/dismiss", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { id } = req.params as { id: string };
      const [r] = await db.select().from(recoveryRequests).where(eq(recoveryRequests.id, id));
      if (!r) return fail(reply, 404, "NOT_FOUND", "This recovery request does not exist.");
      const contacts = await db
        .select({ contact: recoveryContacts.contact })
        .from(recoveryContacts)
        .where(
          and(
            eq(recoveryContacts.owner, r.owner),
            eq(recoveryContacts.status, "confirmed"),
            eq(recoveryContacts.pieceVersion, r.version),
          ),
        );
      if (!contacts.some((c) => c.contact === me))
        return fail(reply, 403, "NOT_A_CONTACT", "You do not hold a current piece for this person.");
      const st = statusOf(r);
      if (st !== "open" && st !== "waiting") return { ok: true, status: st };
      await db.insert(recoveryDismissals).values({ requestId: id, contact: me }).onConflictDoNothing();
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(recoveryDismissals)
        .where(eq(recoveryDismissals.requestId, id));
      let status = st;
      if (contacts.length - n < r.threshold) {
        await db
          .update(recoveryRequests)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(recoveryRequests.id, id));
        status = "cancelled";
      }
      await notify("recovery", r.owner);
      return { ok: true, status };
    });

    // ---- new device --------------------------------------------------------------------------------

    // Per network per hour: room for a household on one connection, not for guessing at scale.
    app.post("/recovery/requests", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
      const b = z
        .object({
          who: z.string().min(3).max(80),
          recipient: KeySchema,
          secretHash: z.string().regex(HASH),
          pow: z.object({ minute: z.number().int(), nonce: z.number().int(), bits: z.number().int() }),
        })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing was started.");
      const who = b.data.who.trim().replace(/^@/, "").toLowerCase();
      // A proof-of-work stamp bound to this name and this request's secret: cheap once, costly in bulk.
      if (!checkPow(b.data.pow, `recovery:${who}`, b.data.secretHash, ctx.cfg.POW_BITS))
        return fail(reply, 429, "POW", "This browser's anti-spam check did not pass. Try again. Nothing was started.");
      let owner = ADDR.test(who) ? who : null;
      if (!owner) {
        owner = (await ownerOfName(db, who)) ?? null;
      }
      // Accounts that do not exist and accounts without contacts get the same answer. Whether an account has
      // recovery contacts is visible to anyone who tries; who they are is not (THREAT_MODEL A2).
      const s = owner ? await settingsOf(owner) : null;
      if (!owner || !s || s.version === 0)
        return fail(
          reply,
          404,
          "NO_RECOVERY",
          "That account has no recovery contacts set up, so it cannot be recovered this way. Use the spare-key sheet's 24 words.",
        );
      // Strangers' requests must never block the owner's (security review H2). At the cap, the oldest request
      // no contact has answered is retired to make room; answers come only after a contact compares the
      // request's six words by voice, so a stranger cannot fill the cap with answered requests.
      const open = await db
        .select({ id: recoveryRequests.id, createdAt: recoveryRequests.createdAt })
        .from(recoveryRequests)
        .where(
          and(
            eq(recoveryRequests.owner, owner),
            eq(recoveryRequests.test, false),
            inArray(recoveryRequests.status, ["open", "waiting"]),
            gt(recoveryRequests.expiresAt, new Date()),
          ),
        )
        .orderBy(asc(recoveryRequests.createdAt));
      if (open.length >= OPEN_PER_OWNER) {
        const answered = new Set((await answersOf(open.map((o) => o.id))).map((a) => a.requestId));
        const unanswered = open.filter((o) => !answered.has(o.id));
        const retire = unanswered.slice(0, open.length - OPEN_PER_OWNER + 1);
        if (retire.length < open.length - OPEN_PER_OWNER + 1)
          return fail(
            reply,
            429,
            "BUSY",
            "Contacts are already answering other recoveries for this account. Ask a contact to dismiss the ones that are not you, then try again. Nothing was started.",
          );
        await db
          .update(recoveryRequests)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(
            inArray(
              recoveryRequests.id,
              retire.map((r) => r.id),
            ),
          );
      }
      const id = `rq_${toBase64Url(randomBytes(18))}`;
      await db.insert(recoveryRequests).values({
        id,
        owner,
        recipient: b.data.recipient,
        secretHash: b.data.secretHash,
        version: s.version,
        threshold: s.threshold,
        ipHash: sha256Hex(utf8(`mzk:recovery:${req.ip}`)),
        expiresAt: new Date(Date.now() + REQUEST_DAYS * 86400_000),
      });
      for (const c of await db
        .select()
        .from(recoveryContacts)
        .where(and(eq(recoveryContacts.owner, owner), eq(recoveryContacts.pieceVersion, s.version))))
        await notify("recovery", c.contact);
      await notify("recovery", owner);
      return reply.code(201).send({ id, owner, threshold: s.threshold });
    });

    const secretOk = (r: typeof recoveryRequests.$inferSelect, secret: string | undefined) =>
      !!secret && sha256Hex(utf8(secret)) === r.secretHash;

    app.get("/recovery/requests/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const secret = req.headers["x-recovery-secret"];
      const [r] = await db.select().from(recoveryRequests).where(eq(recoveryRequests.id, id));
      if (!r || !secretOk(r, typeof secret === "string" ? secret : undefined))
        return fail(reply, 404, "NOT_FOUND", "This recovery request does not exist on this device.");
      const ans = await answersOf([id]);
      const view = requestView(
        r,
        ans.map((a) => a.contact),
      );
      const [name] = await db
        .select({ n: names.name })
        .from(names)
        .where(and(eq(names.address, r.owner), eq(names.primary, true)));
      return { ...view, name: name?.n ?? null, pieces: view.status === "ready" ? ans.map((a) => a.envelope) : [] };
    });

    app.post("/recovery/requests/:id/done", async (req, reply) => {
      const { id } = req.params as { id: string };
      const secret = req.headers["x-recovery-secret"];
      const [r] = await db.select().from(recoveryRequests).where(eq(recoveryRequests.id, id));
      if (!r || !secretOk(r, typeof secret === "string" ? secret : undefined))
        return fail(reply, 404, "NOT_FOUND", "No such request.");
      if (statusOf(r) !== "ready") return fail(reply, 409, "NOT_READY", "This recovery is not ready.");
      await db.update(recoveryRequests).set({ status: "done" }).where(eq(recoveryRequests.id, id));
      await notify("recovery", r.owner);
      return { ok: true };
    });

    // ---- offline reader ----------------------------------------------------------------------------

    app.post(
      "/recovery/offline/challenge",
      { config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
      async (req, reply) => {
        const b = z.object({ who: z.string().min(3).max(80) }).safeParse(req.body);
        if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
        const who = b.data.who.trim().replace(/^@/, "").toLowerCase();
        let owner = ADDR.test(who) ? who : null;
        if (!owner) owner = (await ownerOfName(db, who)) ?? null;
        const s = owner ? await settingsOf(owner) : null;
        const key = s?.offlineKey as { mlkem: string; x25519: string } | null | undefined;
        if (!owner || !key) return fail(reply, 404, "NO_OFFLINE_KEY", "That account has no offline reader turned on.");
        const nonce = toBase64Url(randomBytes(32));
        const id = `ch_${toBase64Url(randomBytes(12))}`;
        const sealed = sealItem({
          purpose: Purpose.offlineChallenge,
          readers: [{ mlkemPublicKey: fromHex(key.mlkem), x25519PublicKey: fromHex(key.x25519) }],
          plaintext: utf8(nonce),
          context: id,
          anonymous: true,
        });
        await db
          .insert(recoveryChallenges)
          .values({ id, owner, nonceHash: sha256Hex(utf8(nonce)), expiresAt: new Date(Date.now() + 5 * 60_000) });
        return { id, owner, challenge: toBase64Url(sealed.envelope) };
      },
    );

    /** The owner's items an offline reader can try: sealed by senders to the offline key, and copies the owner made. */
    app.post("/recovery/offline/items", async (req, reply) => {
      const b = z
        .object({ id: z.string().regex(/^ch_[A-Za-z0-9_-]{8,40}$/), nonce: z.string().min(16).max(80) })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      const [c] = await db.select().from(recoveryChallenges).where(eq(recoveryChallenges.id, b.data.id));
      if (!c || c.expiresAt < new Date() || c.nonceHash !== sha256Hex(utf8(b.data.nonce)))
        return fail(
          reply,
          403,
          "WRONG_KEY",
          "Those words do not open this account's offline reader. Check each word and its order.",
        );
      await db.delete(recoveryChallenges).where(eq(recoveryChallenges.id, c.id));
      const live = await db
        .select({ hash: envelopes.hash, kind: envelopes.kind, ref: envelopes.ref, at: envelopes.createdAt })
        .from(envelopes)
        .where(and(eq(envelopes.owner, c.owner), inArray(envelopes.kind, OFFLINE_KINDS)))
        .orderBy(desc(envelopes.createdAt))
        .limit(2000);
      const copies = await db
        .select()
        .from(recoveryOfflineItems)
        .where(eq(recoveryOfflineItems.owner, c.owner))
        .orderBy(desc(recoveryOfflineItems.itemAt));
      return {
        owner: c.owner,
        live: live.map((l) => ({ source: l.hash, kind: l.kind, ref: l.ref, envelope: l.hash, at: l.at })),
        copies: copies.map((x) => ({ source: x.source, kind: x.kind, ref: x.ref, envelope: x.envelope, at: x.itemAt })),
      };
    });

    done();
  };
