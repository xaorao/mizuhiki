/**
 * Rooms (spec 5.10, ARCHITECTURE 8a): content-blind relay and membership cache.
 *
 * The chain is the source of truth for who may change a room: every create,
 * epoch change, role change, transfer and close is checked here against
 * MizuhikiRegistry before this database follows it. Messages are QoreSeal
 * PrivateBatchCodec blobs under the room's epoch key; the server checks the
 * header (room, epoch) and that the poster is a current member, and stores
 * no author. Room names, photos and every message stay sealed.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, asc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { parseBatchHeader } from "@qorechain/qoreseal";
import { parseAddress } from "@qorechain/qoresign";
import { membershipHash, roomContext, roomIdBytes32, PERMISSIONS, sha256Hex as hashBytes, utf8 } from "@mizuhiki/core";
import { readRoom, roleOnChain, ROOM_ROLE } from "@mizuhiki/chain";
import {
  blobHolds,
  blobs,
  cards,
  roomBatches,
  roomEpochs,
  roomHistory,
  roomInvites,
  roomMembers,
  roomRequests,
  rooms,
} from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { fail, isAddress, isHash } from "../lib/http";
import { hold, release, releaseAll } from "../lib/holds";

const ROOM_ID = /^[a-z0-9]{12,32}$/;
const INVITE_ID = /^[a-z0-9]{12,32}$/;
const HASH = /^[0-9a-f]{64}$/;
const TX = /^(0x)?[0-9a-fA-F]{64}$/;
const evm = (a: string) => parseAddress(a).hex.toLowerCase();
/** The server stores hashes of link secrets and delete tokens, never the values. */
const sha256Hex = (s: string) => hashBytes(utf8(s));

const Member = z.object({ address: z.string().refine(isAddress), role: z.enum(["member", "admin", "owner"]) });
const Perms = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

const Create = z.object({
  id: z.string().regex(ROOM_ID),
  txHash: z.string().regex(TX),
  members: z.array(Member).min(1).max(200),
  distribution: z.string().regex(HASH),
  approval: z.boolean(),
  autoDeleteSeconds: z.number().int().min(0).max(31_536_000),
});

const Epoch = z.object({
  epoch: z.number().int().min(2),
  txHash: z.string().regex(TX),
  reason: z.string().min(1).max(32),
  members: z.array(Member).min(1).max(200),
  distribution: z.string().regex(HASH),
  admitted: z
    .array(z.object({ address: z.string().refine(isAddress), history: z.string().regex(HASH).nullable() }))
    .max(200),
  removed: z.array(z.object({ address: z.string().refine(isAddress), blocked: z.boolean() })).max(200),
});

type Status = "active" | "left" | "removed" | "blocked";

export const roomRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    const notify = async (kind: string, addresses: string[]) => {
      for (const a of new Set(addresses)) await db.execute(sql`select pg_notify('mzk_events', ${`${kind}:${a}`})`);
    };
    const activeOf = (roomId: string) =>
      db
        .select()
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "active")));
    const memberRow = async (roomId: string, address: string) =>
      (
        await db
          .select()
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.address, address)))
      )[0];
    const roomRow = async (roomId: string) => (await db.select().from(rooms).where(eq(rooms.id, roomId)))[0];
    const blobsExist = async (hashes: string[]) => {
      if (hashes.length === 0) return true;
      const found = await db.select({ hash: blobs.hash }).from(blobs).where(inArray(blobs.hash, hashes));
      return new Set(found.map((f) => f.hash)).size === new Set(hashes).size;
    };
    const isAdmin = (m: { role: string; status: string } | undefined) =>
      m?.status === "active" && (m.role === "admin" || m.role === "owner");
    const canAdd = (m: { role: string; status: string; permissions: string[] } | undefined) =>
      isAdmin(m) || (m?.status === "active" && m.permissions.includes("add"));

    /** Chain read with a few retries: a just-included tx can take a moment to show on the RPC node. */
    const chainRoom = async (roomId: string, until: (r: Awaited<ReturnType<typeof readRoom>>) => boolean) => {
      let r = await readRoom(roomIdBytes32(roomId));
      for (let i = 0; i < 6 && !until(r); i++) {
        await new Promise((ok) => setTimeout(ok, 1000));
        r = await readRoom(roomIdBytes32(roomId));
      }
      return r;
    };

    // ---- create -------------------------------------------------------------------------
    app.post("/rooms", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. No room was made.", "nothing-stored");
      const b = Create.safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "The room details were incomplete. No room was made.", "nothing-stored");
      const { id, members } = b.data;
      if (await roomRow(id)) return fail(reply, 409, "TAKEN", "That room id is taken. Try again.", "nothing-stored");
      const owners = members.filter((m) => m.role === "owner");
      if (owners.length !== 1 || owners[0]?.address !== me || members.some((m) => m.role === "admin"))
        return fail(
          reply,
          400,
          "BAD_MEMBERS",
          "A new room has you as owner and everyone else as members.",
          "nothing-stored",
        );
      if (new Set(members.map((m) => m.address)).size !== members.length)
        return fail(reply, 400, "BAD_MEMBERS", "Someone is listed twice.", "nothing-stored");
      const withCards = await db
        .select({ a: cards.address })
        .from(cards)
        .where(
          inArray(
            cards.address,
            members.map((m) => m.address),
          ),
        );
      if (withCards.length !== members.length)
        return fail(
          reply,
          400,
          "NO_ACCOUNT",
          "Everyone in a room needs a Mizuhiki account with a sealing key.",
          "nothing-stored",
        );
      if (!(await blobsExist([b.data.distribution])))
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "The sealed room key did not arrive. No room was made.",
          "nothing-stored",
        );

      const chain = await chainRoom(id, (r) => r.owner !== null);
      if (!chain.owner || chain.owner.toLowerCase() !== evm(me) || chain.epoch !== 1n || chain.closed)
        return fail(
          reply,
          409,
          "NOT_ON_CHAIN",
          "QoreChain has no record of this room yet. Nothing was saved here.",
          "nothing-stored",
        );
      if (
        chain.membershipHash !== membershipHash(id, 1n, members) ||
        chain.distributionHash !== `0x${b.data.distribution}`
      )
        return fail(
          reply,
          409,
          "CHAIN_MISMATCH",
          "The members or key do not match the record on QoreChain. Nothing was saved here.",
          "nothing-stored",
        );

      await db.transaction(async (tx) => {
        // A room keeps its own blobs (holder "room:<id>"), so members leaving or deleting their pages never
        // remove what the room still shows.
        await hold(tx, [b.data.distribution], `room:${id}`, "keys");
        await tx.insert(rooms).values({
          id,
          chainId: roomIdBytes32(id),
          owner: me,
          epoch: 1,
          approval: b.data.approval,
          autoDeleteSeconds: b.data.autoDeleteSeconds,
        });
        await tx
          .insert(roomMembers)
          .values(
            members.map((m) => ({ roomId: id, address: m.address, role: m.role, joinedEpoch: 1, firstEpoch: 1 })),
          );
        await tx.insert(roomEpochs).values({
          roomId: id,
          epoch: 1,
          distribution: b.data.distribution,
          membershipHash: chain.membershipHash,
          txHash: b.data.txHash,
          by: me,
          reason: "created",
        });
      });
      await notify(
        "room",
        members.map((m) => m.address),
      );
      return reply.code(201).send({ id, epoch: 1 });
    });

    // ---- list ---------------------------------------------------------------------------
    app.get("/rooms", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const mine = await db
        .select({ m: roomMembers, r: rooms })
        .from(roomMembers)
        .innerJoin(rooms, eq(rooms.id, roomMembers.roomId))
        .where(and(eq(roomMembers.address, me), eq(rooms.closed, false), sql`${roomMembers.status} <> 'blocked'`));
      const out = [];
      for (const { m, r } of mine) {
        const lo = await visibleFrom(r.id, m);
        const hi = m.status === "active" ? r.epoch : (m.lastEpoch ?? r.epoch);
        const [agg] = await db
          .select({
            last: sql<string | null>`max(${roomBatches.seq})::text`,
            lastAt: sql<string | null>`max(${roomBatches.at})`,
            unread: sql<number>`count(*) filter (where ${roomBatches.seq} > ${m.lastReadSeq})::int`,
          })
          .from(roomBatches)
          .where(
            and(eq(roomBatches.roomId, r.id), gte(roomBatches.epoch, lo), lte(roomBatches.epoch, hi), notExpired()),
          );
        const [count] = await db
          .select({ n: sql<number>`count(*)::int` })
          .from(roomMembers)
          .where(and(eq(roomMembers.roomId, r.id), eq(roomMembers.status, "active")));
        const admin = isAdmin(m);
        const [reqs] = admin
          ? await db
              .select({ n: sql<number>`count(*)::int` })
              .from(roomRequests)
              .where(and(eq(roomRequests.roomId, r.id), eq(roomRequests.status, "pending")))
          : [{ n: 0 }];
        out.push({
          id: r.id,
          epoch: r.epoch,
          role: m.role,
          status: m.status as Status,
          muted: m.muted,
          members: count?.n ?? 0,
          lastSeq: agg?.last ?? "0",
          lastAt: agg?.lastAt ?? r.createdAt,
          unread: m.muted ? 0 : (agg?.unread ?? 0),
          requests: reqs?.n ?? 0,
          needsRotation: admin && (await needsRotation(r.id, r.epoch)),
          createdAt: r.createdAt,
        });
      }
      const waiting = await db
        .select({ roomId: roomRequests.roomId, at: roomRequests.at, status: roomRequests.status })
        .from(roomRequests)
        .where(and(eq(roomRequests.address, me), inArray(roomRequests.status, ["pending", "declined"])));
      return { rooms: out.sort((a, b) => +new Date(b.lastAt) - +new Date(a.lastAt)), waiting };
    });

    const notExpired = () => or(isNull(roomBatches.expiresAt), gt(roomBatches.expiresAt, new Date()));

    /** Members admitted with "Share past messages" see from epoch 1; others from the epoch they joined. */
    async function visibleFrom(roomId: string, m: { address: string; joinedEpoch: number }): Promise<number> {
      const [h] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(roomHistory)
        .where(and(eq(roomHistory.roomId, roomId), eq(roomHistory.member, m.address)));
      return (h?.n ?? 0) > 0 ? 1 : m.joinedEpoch;
    }

    /** Someone left during the current epoch: the key must change before they could read anything new. */
    async function needsRotation(roomId: string, epoch: number): Promise<boolean> {
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), eq(roomMembers.status, "left"), eq(roomMembers.lastEpoch, epoch)));
      return (r?.n ?? 0) > 0;
    }

    // ---- one room -----------------------------------------------------------------------
    type Refusal = { refused: { status: number; code: string; message: string } };
    const notFound: Refusal = {
      refused: { status: 404, code: "NOT_FOUND", message: "This room does not exist or you are not in it." },
    };
    // Member rows carry a bigint read marker; JSON carries it as a string (MemberRow.lastReadSeq).
    const plain = <T extends { lastReadSeq: bigint }>(x: T) => ({ ...x, lastReadSeq: x.lastReadSeq.toString() });

    /** The room as this person may see it. */
    async function roomView(id: string, me: string) {
      const r = await roomRow(id);
      const m = r && (await memberRow(id, me));
      if (!r || !m || m.status === "blocked" || r.closed) return notFound;
      if (m.status !== "active") {
        // Someone who left or was removed keeps the record of the epochs they belonged to (so their device can
        // still check who wrote what they saw), but learns nothing about the room after they left.
        const last = m.lastEpoch ?? r.epoch;
        const epochs = await db
          .select()
          .from(roomEpochs)
          .where(and(eq(roomEpochs.roomId, id), lte(roomEpochs.epoch, last)))
          .orderBy(asc(roomEpochs.epoch));
        return { id, epoch: last, me: plain(m), members: [], epochs, settings: null, owner: r.owner, closed: r.closed };
      }
      const members = await db
        .select()
        .from(roomMembers)
        .where(eq(roomMembers.roomId, id))
        .orderBy(asc(roomMembers.joinedAt));
      const epochs = await db.select().from(roomEpochs).where(eq(roomEpochs.roomId, id)).orderBy(asc(roomEpochs.epoch));
      return {
        id,
        epoch: r.epoch,
        owner: r.owner,
        chainId: r.chainId,
        me: plain(m),
        members: members.filter((x) => x.status !== "blocked" || isAdmin(m)).map(plain),
        epochs,
        settings: { approval: r.approval, autoDeleteSeconds: r.autoDeleteSeconds },
        needsRotation: isAdmin(m) && (await needsRotation(id, r.epoch)),
        closed: r.closed,
      };
    }

    /** The sealed epoch keys this person may try to open: every epoch they were a member of, plus shared history. */
    async function keysView(id: string, me: string) {
      const r = await roomRow(id);
      const m = r && (await memberRow(id, me));
      if (!r || !m || m.status === "blocked") return notFound;
      const hi = m.status === "active" ? r.epoch : (m.lastEpoch ?? r.epoch);
      const epochs = await db
        .select({ epoch: roomEpochs.epoch, hash: roomEpochs.distribution })
        .from(roomEpochs)
        .where(and(eq(roomEpochs.roomId, id), gte(roomEpochs.epoch, m.joinedEpoch), lte(roomEpochs.epoch, hi)))
        .orderBy(asc(roomEpochs.epoch));
      const history = await db
        .select({ hash: roomHistory.envelope, by: roomHistory.by })
        .from(roomHistory)
        .where(and(eq(roomHistory.roomId, id), eq(roomHistory.member, me)));
      return { epochs, history, current: r.epoch };
    }

    async function batchesView(id: string, me: string, after: bigint, limit: number) {
      const r = await roomRow(id);
      const m = r && (await memberRow(id, me));
      if (!r || !m || m.status === "blocked" || r.closed) return notFound;
      const lo = await visibleFrom(id, m);
      const hi = m.status === "active" ? r.epoch : (m.lastEpoch ?? r.epoch);
      const rows = await db
        .select({
          seq: sql<string>`${roomBatches.seq}::text`,
          hash: roomBatches.hash,
          epoch: roomBatches.epoch,
          at: roomBatches.at,
          size: roomBatches.size,
          expiresAt: roomBatches.expiresAt,
        })
        .from(roomBatches)
        .where(
          and(
            eq(roomBatches.roomId, id),
            gt(roomBatches.seq, after),
            gte(roomBatches.epoch, lo),
            lte(roomBatches.epoch, hi),
            notExpired(),
          ),
        )
        .orderBy(asc(roomBatches.seq))
        .limit(limit);
      return { batches: rows, more: rows.length === limit };
    }

    async function requestsView(id: string, me: string) {
      const m = await memberRow(id, me);
      if (!canAdd(m))
        return {
          refused: { status: 403, code: "NO_PERMISSION", message: "You cannot see join requests." },
        } satisfies Refusal;
      const rows = await db
        .select()
        .from(roomRequests)
        .where(and(eq(roomRequests.roomId, id), eq(roomRequests.status, "pending")))
        .orderBy(asc(roomRequests.at));
      return { requests: rows };
    }

    const refused = (x: object): x is Refusal => "refused" in x;
    const Page = z.object({
      after: z.coerce.bigint().min(0n).default(0n),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    });

    app.get("/rooms/:id", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const v = await roomView((req.params as { id: string }).id, me);
      return refused(v) ? fail(reply, v.refused.status, v.refused.code, v.refused.message) : v;
    });

    app.get("/rooms/:id/keys", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const v = await keysView((req.params as { id: string }).id, me);
      return refused(v) ? fail(reply, v.refused.status, v.refused.code, v.refused.message) : v;
    });

    // ---- batches (messages) -------------------------------------------------------------
    app.get("/rooms/:id/batches", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const q = Page.safeParse(req.query);
      if (!q.success) return fail(reply, 400, "BAD_REQUEST", "Bad page request.");
      const v = await batchesView((req.params as { id: string }).id, me, q.data.after, q.data.limit);
      return refused(v) ? fail(reply, v.refused.status, v.refused.code, v.refused.message) : v;
    });

    /**
     * One refresh of an open room in one request: the room, new sealed batches after `after`, the
     * sealed keys this person may open, and (for people who can add members) pending join requests.
     */
    app.get("/rooms/:id/sync", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const id = (req.params as { id: string }).id;
      const q = Page.safeParse(req.query);
      if (!q.success) return fail(reply, 400, "BAD_REQUEST", "Bad page request.");
      const room = await roomView(id, me);
      if (refused(room)) return fail(reply, room.refused.status, room.refused.code, room.refused.message);
      const [page, keys, reqs] = await Promise.all([
        batchesView(id, me, q.data.after, q.data.limit),
        keysView(id, me),
        requestsView(id, me),
      ]);
      return {
        room,
        ...(refused(page) ? { batches: [], more: false } : page),
        keys: refused(keys) ? { epochs: [], history: [], current: room.epoch } : keys,
        requests: refused(reqs) ? [] : reqs.requests,
      };
    });

    app.post(
      "/rooms/:id/batches",
      { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const me = await sessionAddress(db, req);
        if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was sent.", "nothing-stored");
        const { id } = req.params as { id: string };
        const b = z.object({ hash: z.string().regex(HASH), deleteHash: z.string().regex(HASH) }).safeParse(req.body);
        if (!b.success)
          return fail(
            reply,
            400,
            "BAD_REQUEST",
            "The sealed message was incomplete. Nothing was sent.",
            "nothing-stored",
          );
        const r = await roomRow(id);
        const m = r && (await memberRow(id, me));
        if (!r || r.closed)
          return fail(reply, 404, "NOT_FOUND", "This room no longer exists. Nothing was sent.", "nothing-stored");
        if (!m || m.status !== "active")
          return fail(reply, 403, "NOT_MEMBER", "You are no longer in this room. Nothing was sent.", "nothing-stored");
        if (!isAdmin(m) && !m.permissions.includes("send") && !m.permissions.includes("files"))
          return fail(
            reply,
            403,
            "NO_PERMISSION",
            "An admin turned off sending for you in this room. Nothing was sent.",
            "nothing-stored",
          );
        const bytes = await ctx.blobs.get(b.data.hash);
        if (!bytes)
          return fail(
            reply,
            409,
            "MISSING_PARTS",
            "The sealed message did not arrive. Nothing was sent.",
            "nothing-stored",
          );
        let header: ReturnType<typeof parseBatchHeader>;
        try {
          header = parseBatchHeader(bytes);
        } catch {
          return fail(
            reply,
            400,
            "NOT_A_BATCH",
            "That is not a sealed room message. Nothing was sent.",
            "nothing-stored",
          );
        }
        if (header.context !== roomContext(id))
          return fail(
            reply,
            400,
            "WRONG_ROOM",
            "That message was sealed for another room. Nothing was sent.",
            "nothing-stored",
          );
        if (header.epoch !== BigInt(r.epoch))
          return reply.code(409).send({
            error: {
              code: "STALE_EPOCH",
              message: "The room key changed while you were writing. Sealing again with the new key.",
              dataState: "nothing-stored",
            },
            epoch: r.epoch,
          });
        const expiresAt = r.autoDeleteSeconds > 0 ? new Date(Date.now() + r.autoDeleteSeconds * 1000) : null;
        let seq: string | undefined;
        await db.transaction(async (tx) => {
          await hold(tx, [b.data.hash], `room:${id}`, "batch", expiresAt);
          const [row] = await tx
            .insert(roomBatches)
            .values({
              roomId: id,
              hash: b.data.hash,
              epoch: r.epoch,
              size: bytes.length,
              deleteHash: b.data.deleteHash,
              expiresAt,
            })
            .onConflictDoNothing()
            .returning({ seq: sql<string>`${roomBatches.seq}::text` });
          seq = row?.seq;
        });
        if (!seq) return fail(reply, 409, "DUPLICATE", "That message was already sent.", "stored");
        const active = await activeOf(id);
        await notify(
          "room",
          active.map((a) => a.address),
        );
        return reply.code(201).send({ seq, epoch: r.epoch, expiresAt });
      },
    );

    /** "Delete for everyone": the author proves authorship with their delete token; admins may delete any message. */
    app.post("/rooms/:id/batches/:hash/delete", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id, hash } = req.params as { id: string; hash: string };
      const token = z.object({ token: z.string().regex(HASH).optional() }).safeParse(req.body ?? {});
      if (!isHash(hash) || !token.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing was deleted.");
      const m = await memberRow(id, me);
      if (!m || m.status !== "active")
        return fail(reply, 403, "NOT_MEMBER", "You are not in this room. Nothing was deleted.");
      const [row] = await db
        .select()
        .from(roomBatches)
        .where(and(eq(roomBatches.roomId, id), eq(roomBatches.hash, hash)));
      if (!row) return { deleted: false };
      const own = token.data.token !== undefined && sha256Hex(token.data.token) === row.deleteHash;
      if (!own && !isAdmin(m))
        return fail(reply, 403, "NOT_YOURS", "Only the author or an admin can delete this for everyone.");
      await db.delete(roomBatches).where(eq(roomBatches.seq, row.seq));
      const still = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(roomBatches)
        .where(eq(roomBatches.hash, hash));
      if ((still[0]?.n ?? 0) === 0) {
        await release(db, `room:${id}`, "batch", [hash]);
        // Gone at once unless another account holds the same bytes for itself.
        const [other] = await db.select({ h: blobHolds.hash }).from(blobHolds).where(eq(blobHolds.hash, hash)).limit(1);
        if (!other) {
          await ctx.blobs.delete(hash);
          await db.delete(blobs).where(eq(blobs.hash, hash));
        }
      }
      await notify(
        "room",
        (await activeOf(id)).map((a) => a.address),
      );
      return { deleted: true };
    });

    app.post("/rooms/:id/read", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const b = z.object({ seq: z.coerce.bigint().min(0n) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      await db
        .update(roomMembers)
        .set({ lastReadSeq: sql`greatest(${roomMembers.lastReadSeq}, ${b.data.seq})` })
        .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, me)));
      return { ok: true };
    });

    app.patch("/rooms/:id/me", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const b = z.object({ muted: z.boolean() }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      await db
        .update(roomMembers)
        .set({ muted: b.data.muted, updatedAt: new Date() })
        .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, me)));
      return { ok: true };
    });

    // ---- membership changes (epoch rotation) -------------------------------------------
    app.post("/rooms/:id/epochs", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.", "nothing-stored");
      const { id } = req.params as { id: string };
      const b = Epoch.safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "The change was incomplete.", "nothing-stored");
      const r = await roomRow(id);
      const actor = r && (await memberRow(id, me));
      if (!r || r.closed) return fail(reply, 404, "NOT_FOUND", "This room no longer exists.", "nothing-stored");
      if (!isAdmin(actor))
        return fail(reply, 403, "NOT_ADMIN", "Only admins can change who is in the room.", "nothing-stored");
      if (b.data.epoch !== r.epoch + 1)
        return reply.code(409).send({
          error: {
            code: "STALE_EPOCH",
            message: "Someone else changed this room at the same moment. Refresh and try again.",
            dataState: "nothing-stored",
          },
          epoch: r.epoch,
        });

      const all = await db.select().from(roomMembers).where(eq(roomMembers.roomId, id));
      const byAddr = new Map(all.map((x) => [x.address, x]));
      const next = b.data.members;
      const nextSet = new Set(next.map((x) => x.address));
      if (nextSet.size !== next.length)
        return fail(reply, 400, "BAD_MEMBERS", "Someone is listed twice.", "nothing-stored");
      const admitted = new Map(b.data.admitted.map((a) => [a.address, a]));
      const removed = new Map(b.data.removed.map((x) => [x.address, x]));
      for (const x of next) {
        const cur = byAddr.get(x.address);
        if (cur?.status === "active") {
          if (cur.role !== x.role)
            return fail(reply, 400, "BAD_MEMBERS", "Roles change separately from membership.", "nothing-stored");
        } else {
          if (!admitted.has(x.address) || x.role !== "member")
            return fail(reply, 400, "BAD_MEMBERS", "A new member must be admitted as a member.", "nothing-stored");
          if (cur?.status === "blocked")
            return fail(
              reply,
              403,
              "BLOCKED",
              "That person was removed and blocked. Unblock them first.",
              "nothing-stored",
            );
        }
      }
      for (const cur of all) {
        if (cur.status === "active" && !nextSet.has(cur.address)) {
          if (!removed.has(cur.address))
            return fail(reply, 400, "BAD_MEMBERS", "Say who is being removed.", "nothing-stored");
          if (cur.role === "owner")
            return fail(reply, 400, "BAD_MEMBERS", "The owner cannot be removed.", "nothing-stored");
        }
      }
      for (const a of admitted.keys())
        if (!nextSet.has(a))
          return fail(reply, 400, "BAD_MEMBERS", "An admitted person is missing from the list.", "nothing-stored");
      const newcomers = [...admitted.keys()];
      if (newcomers.length > 0) {
        const withCards = await db.select({ a: cards.address }).from(cards).where(inArray(cards.address, newcomers));
        if (withCards.length !== newcomers.length)
          return fail(
            reply,
            400,
            "NO_ACCOUNT",
            "Everyone in a room needs a Mizuhiki account with a sealing key.",
            "nothing-stored",
          );
      }
      const histories = b.data.admitted.flatMap((a) => (a.history ? [a.history] : []));
      if (!(await blobsExist([b.data.distribution, ...histories])))
        return fail(reply, 409, "MISSING_PARTS", "The sealed room key did not arrive.", "nothing-stored");

      const chain = await chainRoom(id, (c) => c.epoch >= BigInt(b.data.epoch));
      if (chain.epoch !== BigInt(b.data.epoch) || chain.closed)
        return fail(reply, 409, "NOT_ON_CHAIN", "QoreChain has no record of this key change yet.", "nothing-stored");
      if (
        chain.membershipHash !== membershipHash(id, BigInt(b.data.epoch), next) ||
        chain.distributionHash !== `0x${b.data.distribution}`
      )
        return fail(
          reply,
          409,
          "CHAIN_MISMATCH",
          "The members or key do not match the record on QoreChain.",
          "nothing-stored",
        );
      // A removed admin must lose their on-chain admin role first, or they could still change the room.
      for (const x of removed.keys()) {
        if ((await roleOnChain(roomIdBytes32(id), evm(x) as `0x${string}`)) >= ROOM_ROLE.admin)
          return fail(reply, 409, "STILL_ADMIN", "Dismiss them as admin before removing them.", "nothing-stored");
      }

      const now = new Date();
      await db.transaction(async (tx) => {
        await hold(tx, [b.data.distribution, ...histories], `room:${id}`, "keys");
        await tx.update(rooms).set({ epoch: b.data.epoch, updatedAt: now }).where(eq(rooms.id, id));
        await tx.insert(roomEpochs).values({
          roomId: id,
          epoch: b.data.epoch,
          distribution: b.data.distribution,
          membershipHash: chain.membershipHash,
          txHash: b.data.txHash,
          by: me,
          reason: b.data.reason,
        });
        for (const cur of all) {
          if (cur.status === "active" && !nextSet.has(cur.address)) {
            const blocked = removed.get(cur.address)?.blocked ?? false;
            await tx
              .update(roomMembers)
              .set({ status: blocked ? "blocked" : "removed", lastEpoch: r.epoch, role: "member", updatedAt: now })
              .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, cur.address)));
          }
        }
        for (const [addr, a] of admitted) {
          await tx
            .insert(roomMembers)
            .values({ roomId: id, address: addr, role: "member", joinedEpoch: b.data.epoch, firstEpoch: b.data.epoch })
            .onConflictDoUpdate({
              target: [roomMembers.roomId, roomMembers.address],
              set: {
                status: "active",
                role: "member",
                joinedEpoch: b.data.epoch,
                lastEpoch: null,
                lastReadSeq: 0n,
                permissions: [...PERMISSIONS],
                joinedAt: now,
                updatedAt: now,
              },
            });
          if (a.history)
            await tx
              .insert(roomHistory)
              .values({ roomId: id, member: addr, envelope: a.history, by: me })
              .onConflictDoNothing();
          await tx
            .update(roomRequests)
            .set({ status: "approved" })
            .where(and(eq(roomRequests.roomId, id), eq(roomRequests.address, addr)));
        }
        // Blocking someone who only asked to join (never a member).
        for (const [addr, x] of removed) {
          if (!byAddr.has(addr) && x.blocked)
            await tx
              .insert(roomMembers)
              .values({
                roomId: id,
                address: addr,
                role: "member",
                status: "blocked",
                joinedEpoch: b.data.epoch,
                firstEpoch: b.data.epoch,
                lastEpoch: 0,
              })
              .onConflictDoNothing();
        }
      });
      await notify("room", [...next.map((x) => x.address), ...removed.keys()]);
      return reply.code(201).send({ epoch: b.data.epoch });
    });

    // ---- roles, permissions, ownership --------------------------------------------------
    app.post("/rooms/:id/role", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const b = z
        .object({ member: z.string().refine(isAddress), role: z.enum(["member", "admin"]), permissions: Perms })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing changed.");
      const r = await roomRow(id);
      const actor = r && (await memberRow(id, me));
      const target = r && (await memberRow(id, b.data.member));
      if (!r || r.closed || !target || target.status !== "active")
        return fail(reply, 404, "NOT_FOUND", "That person is not in this room.");
      if (!isAdmin(actor)) return fail(reply, 403, "NOT_ADMIN", "Only admins can change roles and permissions.");
      if (target.role === "owner")
        return fail(reply, 400, "OWNER", "The owner's role changes only by transferring the room.");
      const adminChange = b.data.role === "admin" || target.role === "admin";
      if (adminChange && actor?.role !== "owner")
        return fail(reply, 403, "NOT_OWNER", "Only the owner can make or dismiss admins.");
      if (b.data.role !== target.role) {
        const want = b.data.role === "admin" ? ROOM_ROLE.admin : ROOM_ROLE.none;
        let onChain = -1;
        for (let i = 0; i < 6; i++) {
          onChain = await roleOnChain(roomIdBytes32(id), evm(b.data.member) as `0x${string}`);
          if (onChain === want) break;
          await new Promise((ok) => setTimeout(ok, 1000));
        }
        if (onChain !== want)
          return fail(
            reply,
            409,
            "NOT_ON_CHAIN",
            "QoreChain has no record of this role change yet. Nothing changed here.",
          );
      }
      await db
        .update(roomMembers)
        .set({ role: b.data.role, permissions: b.data.permissions, updatedAt: new Date() })
        .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, b.data.member)));
      await notify(
        "room",
        (await activeOf(id)).map((a) => a.address),
      );
      return { ok: true };
    });

    app.post("/rooms/:id/transfer", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const b = z.object({ newOwner: z.string().refine(isAddress) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing changed.");
      const r = await roomRow(id);
      if (!r || r.owner !== me) return fail(reply, 403, "NOT_OWNER", "Only the owner can transfer this room.");
      const target = await memberRow(id, b.data.newOwner);
      if (!target || target.status !== "active" || target.role !== "admin")
        return fail(reply, 400, "NOT_ADMIN", "Ownership goes only to an admin of this room.");
      const chain = await chainRoom(id, (c) => c.owner?.toLowerCase() === evm(b.data.newOwner));
      if (chain.owner?.toLowerCase() !== evm(b.data.newOwner))
        return fail(reply, 409, "NOT_ON_CHAIN", "QoreChain has no record of the transfer yet. Nothing changed here.");
      const now = new Date();
      await db.transaction(async (tx) => {
        await tx.update(rooms).set({ owner: b.data.newOwner, updatedAt: now }).where(eq(rooms.id, id));
        await tx
          .update(roomMembers)
          .set({ role: "owner", updatedAt: now })
          .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, b.data.newOwner)));
        await tx
          .update(roomMembers)
          .set({ role: "admin", updatedAt: now })
          .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, me)));
      });
      await notify(
        "room",
        (await activeOf(id)).map((a) => a.address),
      );
      return { ok: true };
    });

    app.post("/rooms/:id/settings", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const b = z
        .object({ approval: z.boolean(), autoDeleteSeconds: z.number().int().min(0).max(31_536_000) })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing changed.");
      const m = await memberRow(id, me);
      // Who may join and how long messages are kept are admin decisions (security review L4); the "info"
      // permission covers the room's name, photo and description only.
      if (!isAdmin(m))
        return fail(reply, 403, "NOT_ADMIN", "Only admins can change who joins and how long messages are kept.");
      await db
        .update(rooms)
        .set({ ...b.data, updatedAt: new Date() })
        .where(eq(rooms.id, id));
      return { ok: true };
    });

    app.post("/rooms/:id/leave", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const r = await roomRow(id);
      const m = r && (await memberRow(id, me));
      if (!r || !m || m.status !== "active") return fail(reply, 404, "NOT_FOUND", "You are not in this room.");
      if (m.role === "owner")
        return fail(reply, 400, "OWNER", "Transfer the room to an admin before leaving, or delete it.");
      await db
        .update(roomMembers)
        .set({ status: "left", lastEpoch: r.epoch, updatedAt: new Date() })
        .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, me)));
      await notify("room", [...(await activeOf(id)).map((a) => a.address), me]);
      return { ok: true };
    });

    /** Forget a room you left or were removed from (your list only). */
    app.delete("/rooms/:id/me", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const m = await memberRow(id, me);
      if (!m) return { ok: true };
      if (m.status === "active") return fail(reply, 400, "ACTIVE", "Leave the room first.");
      if (m.status === "blocked") return { ok: true };
      await db
        .update(roomMembers)
        .set({ status: "blocked", updatedAt: new Date() })
        .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, me)));
      return { ok: true };
    });

    app.post("/rooms/:id/close", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const r = await roomRow(id);
      if (!r || r.owner !== me) return fail(reply, 403, "NOT_OWNER", "Only the owner can delete this room.");
      const chain = await chainRoom(id, (c) => c.closed);
      if (!chain.closed)
        return fail(
          reply,
          409,
          "NOT_ON_CHAIN",
          "QoreChain has no record of the room being closed yet. Nothing changed here.",
        );
      const members = await activeOf(id);
      const batches = await db.select({ hash: roomBatches.hash }).from(roomBatches).where(eq(roomBatches.roomId, id));
      await db.transaction(async (tx) => {
        await tx.update(rooms).set({ closed: true, updatedAt: new Date() }).where(eq(rooms.id, id));
        await tx.delete(roomBatches).where(eq(roomBatches.roomId, id));
        await tx.update(roomInvites).set({ revoked: true }).where(eq(roomInvites.roomId, id));
        // Closed for everyone: the room lets go of everything it kept.
        await releaseAll(tx, `room:${id}`);
      });
      await notify(
        "room",
        members.map((m) => m.address),
      );
      return { ok: true, deleted: batches.length };
    });

    // ---- invites and join requests ------------------------------------------------------
    app.post("/rooms/:id/invites", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.", "nothing-stored");
      const { id } = req.params as { id: string };
      const b = z
        .object({
          id: z.string().regex(INVITE_ID),
          secretHash: z.string().regex(HASH),
          card: z.string().regex(HASH),
          primary: z.boolean(),
          expiresAt: z.iso.datetime().nullable(),
          maxUses: z.number().int().min(1).max(100_000).nullable(),
        })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "The link details were incomplete.", "nothing-stored");
      const r = await roomRow(id);
      const m = r && (await memberRow(id, me));
      if (!r || r.closed) return fail(reply, 404, "NOT_FOUND", "This room no longer exists.", "nothing-stored");
      if (!canAdd(m))
        return fail(reply, 403, "NO_PERMISSION", "You cannot invite people to this room.", "nothing-stored");
      if (!(await blobsExist([b.data.card])))
        return fail(reply, 409, "MISSING_PARTS", "The sealed invite card did not arrive.", "nothing-stored");
      await db.transaction(async (tx) => {
        await hold(tx, [b.data.card], `room:${id}`, "invites");
        if (b.data.primary)
          await tx
            .update(roomInvites)
            .set({ revoked: true })
            .where(and(eq(roomInvites.roomId, id), eq(roomInvites.primary, true)));
        await tx.insert(roomInvites).values({
          id: b.data.id,
          roomId: id,
          secretHash: b.data.secretHash,
          card: b.data.card,
          createdBy: me,
          primary: b.data.primary,
          expiresAt: b.data.expiresAt ? new Date(b.data.expiresAt) : null,
          maxUses: b.data.maxUses,
        });
      });
      return reply.code(201).send({ id: b.data.id });
    });

    app.get("/rooms/:id/invites", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const m = await memberRow(id, me);
      if (!canAdd(m)) return fail(reply, 403, "NO_PERMISSION", "You cannot see this room's invite links.");
      const rows = await db
        .select()
        .from(roomInvites)
        .where(eq(roomInvites.roomId, id))
        .orderBy(asc(roomInvites.createdAt));
      return { invites: rows.map(({ secretHash: _s, ...rest }) => rest) };
    });

    app.patch("/rooms/:id/invites/:inv", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id, inv } = req.params as { id: string; inv: string };
      const b = z.object({ revoked: z.literal(true) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      const m = await memberRow(id, me);
      const [row] = await db
        .select()
        .from(roomInvites)
        .where(and(eq(roomInvites.id, inv), eq(roomInvites.roomId, id)));
      if (!row) return fail(reply, 404, "NOT_FOUND", "No such link.");
      if (!isAdmin(m) && row.createdBy !== me)
        return fail(reply, 403, "NO_PERMISSION", "Only admins or the link's maker can revoke it.");
      await db.update(roomInvites).set({ revoked: true }).where(eq(roomInvites.id, inv));
      return { ok: true };
    });

    const inviteState = (row: typeof roomInvites.$inferSelect) =>
      row.revoked
        ? "revoked"
        : row.expiresAt && row.expiresAt < new Date()
          ? "expired"
          : row.maxUses !== null && row.uses >= row.maxUses
            ? "used-up"
            : "ok";

    /** Public: what an invite link shows before joining. The card is sealed to the key in the link's fragment. */
    app.get("/invites/:inv", async (req, reply) => {
      const { inv } = req.params as { inv: string };
      if (!INVITE_ID.test(inv)) return fail(reply, 404, "NOT_FOUND", "This invite link does not exist.");
      const [row] = await db.select().from(roomInvites).where(eq(roomInvites.id, inv));
      if (!row) return fail(reply, 404, "NOT_FOUND", "This invite link does not exist.");
      const r = await roomRow(row.roomId);
      if (!r || r.closed) return fail(reply, 410, "CLOSED", "This room was deleted.");
      const [count] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(roomMembers)
        .where(and(eq(roomMembers.roomId, r.id), eq(roomMembers.status, "active")));
      const me = await sessionAddress(db, req);
      const mine = me ? await memberRow(r.id, me) : undefined;
      const [request] = me
        ? await db
            .select()
            .from(roomRequests)
            .where(and(eq(roomRequests.roomId, r.id), eq(roomRequests.address, me)))
        : [];
      return {
        roomId: r.id,
        card: row.card,
        state: inviteState(row),
        approval: r.approval,
        members: count?.n ?? 0,
        expiresAt: row.expiresAt,
        createdBy: row.createdBy,
        you: mine ? mine.status : request ? `request-${request.status}` : null,
      };
    });

    app.post(
      "/invites/:inv/join",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const me = await sessionAddress(db, req);
        if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. You have not joined.");
        const { inv } = req.params as { inv: string };
        const b = z.object({ secret: z.string().regex(HASH) }).safeParse(req.body);
        if (!b.success || !INVITE_ID.test(inv)) return fail(reply, 400, "BAD_REQUEST", "This invite link is damaged.");
        const [row] = await db.select().from(roomInvites).where(eq(roomInvites.id, inv));
        if (!row || sha256Hex(b.data.secret) !== row.secretHash)
          return fail(reply, 404, "NOT_FOUND", "This invite link does not exist or is damaged.");
        const r = await roomRow(row.roomId);
        if (!r || r.closed) return fail(reply, 410, "CLOSED", "This room was deleted.");
        const state = inviteState(row);
        if (state !== "ok")
          return fail(
            reply,
            410,
            "INVITE_" + state.toUpperCase().replace("-", "_"),
            state === "revoked"
              ? "This link was reset by an admin. Ask for a new one."
              : state === "expired"
                ? "This link has expired. Ask for a new one."
                : "This link reached its limit of uses. Ask for a new one.",
          );
        const [card] = await db.select({ a: cards.address }).from(cards).where(eq(cards.address, me));
        if (!card)
          return fail(
            reply,
            400,
            "NO_ACCOUNT",
            "Finish setting up your account first, so the room key can be sealed to you.",
          );
        const mine = await memberRow(r.id, me);
        if (mine?.status === "active") return { status: "member", roomId: r.id };
        if (mine?.status === "blocked")
          return fail(reply, 403, "BLOCKED", "An admin removed you from this room and blocked you from joining again.");
        const [existing] = await db
          .select()
          .from(roomRequests)
          .where(and(eq(roomRequests.roomId, r.id), eq(roomRequests.address, me)));
        if (existing?.status === "pending") return { status: "pending", roomId: r.id, approval: r.approval };
        await db.transaction(async (tx) => {
          await tx
            .update(roomInvites)
            .set({ uses: sql`${roomInvites.uses} + 1` })
            .where(eq(roomInvites.id, inv));
          await tx
            .insert(roomRequests)
            .values({ roomId: r.id, address: me, inviteId: inv })
            .onConflictDoUpdate({
              target: [roomRequests.roomId, roomRequests.address],
              set: { status: "pending", inviteId: inv, at: new Date() },
            });
        });
        const admins = (await activeOf(r.id)).filter((a) => a.role === "admin" || a.role === "owner");
        await notify(
          "roomreq",
          admins.map((a) => a.address),
        );
        return { status: "pending", roomId: r.id, approval: r.approval };
      },
    );

    /** A member with the "add" right suggests people; an admin's device seals the key to them. */
    app.post("/rooms/:id/requests", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      const b = z.object({ addresses: z.array(z.string().refine(isAddress)).min(1).max(50) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      const r = await roomRow(id);
      const m = r && (await memberRow(id, me));
      if (!r || r.closed || !canAdd(m)) return fail(reply, 403, "NO_PERMISSION", "You cannot add people to this room.");
      const withCards = await db
        .select({ a: cards.address })
        .from(cards)
        .where(inArray(cards.address, b.data.addresses));
      if (withCards.length !== new Set(b.data.addresses).size)
        return fail(reply, 400, "NO_ACCOUNT", "Everyone in a room needs a Mizuhiki account with a sealing key.");
      for (const a of b.data.addresses) {
        const cur = await memberRow(id, a);
        if (cur?.status === "active" || cur?.status === "blocked") continue;
        await db
          .insert(roomRequests)
          .values({ roomId: id, address: a, inviteId: `add:${me}` })
          .onConflictDoUpdate({
            target: [roomRequests.roomId, roomRequests.address],
            set: { status: "pending", inviteId: `add:${me}`, at: new Date() },
          });
      }
      const admins = (await activeOf(id)).filter((a) => a.role === "admin" || a.role === "owner");
      await notify(
        "roomreq",
        admins.map((a) => a.address),
      );
      return { ok: true };
    });

    app.get("/rooms/:id/requests", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const v = await requestsView((req.params as { id: string }).id, me);
      return refused(v) ? fail(reply, v.refused.status, v.refused.code, v.refused.message) : v;
    });

    app.patch("/rooms/:id/requests/:address", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id, address } = req.params as { id: string; address: string };
      const b = z.object({ status: z.literal("declined") }).safeParse(req.body);
      if (!b.success || !isAddress(address)) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      if (!isAdmin(await memberRow(id, me))) return fail(reply, 403, "NOT_ADMIN", "Only admins can decline requests.");
      await db
        .update(roomRequests)
        .set({ status: "declined" })
        .where(and(eq(roomRequests.roomId, id), eq(roomRequests.address, address)));
      await notify("room", [address]);
      return { ok: true };
    });

    /** Unblock someone removed and blocked, so they can ask to join again. */
    app.delete("/rooms/:id/blocked/:address", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id, address } = req.params as { id: string; address: string };
      if (!isAddress(address)) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      if (!isAdmin(await memberRow(id, me))) return fail(reply, 403, "NOT_ADMIN", "Only admins can unblock people.");
      await db
        .update(roomMembers)
        .set({ status: "removed", updatedAt: new Date() })
        .where(and(eq(roomMembers.roomId, id), eq(roomMembers.address, address), eq(roomMembers.status, "blocked")));
      return { ok: true };
    });

    /** Cancel your own pending request, or dismiss a declined one. */
    app.delete("/rooms/:id/requests/me", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { id } = req.params as { id: string };
      await db
        .delete(roomRequests)
        .where(
          and(
            eq(roomRequests.roomId, id),
            eq(roomRequests.address, me),
            inArray(roomRequests.status, ["pending", "declined"]),
          ),
        );
      return { ok: true };
    });

    done();
  };

/** Delete room batches whose auto-delete time passed (their blobs expire with them). */
export async function sweepRoomBatches(db: Ctx["db"]): Promise<number> {
  const gone = await db
    .delete(roomBatches)
    .where(lte(roomBatches.expiresAt, new Date()))
    .returning({ seq: roomBatches.seq });
  return gone.length;
}
