/**
 * The owner's inbox index (spec 4.2, 5.8): metadata only. Every row points at a
 * sealed envelope the owner opens on their own device; payments come from the
 * chain (indexer) and carry their sealed note's hash when there is one.
 * A WebSocket tells an open dashboard that something new arrived (no content).
 */
import type { FastifyPluginCallback } from "fastify";
import { and, desc, eq, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { envelopes, names, payments, roomMembers, roomRequests, sessions } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { SELF_KINDS } from "./drop";
import { fail, isHash } from "../lib/http";
import { createHash } from "node:crypto";

export interface InboxRow {
  id: string;
  /** "request": someone asked to join a room this account administers (spec: the inbox "Room request" type). */
  type: "envelope" | "payment" | "request";
  kind: string;
  envelope: string | null;
  size: number;
  readers: number;
  at: string;
  read: boolean;
  archived: boolean;
  ref: string | null;
  sender: { address: string; name: string | null; how: "signed" | "payment" | "request" } | null;
  /** The sender's signature record, so the owner's device can check it again itself. */
  senderSig: unknown;
  /** For sent items: who it was sent to. */
  to: { address: string; name: string | null } | null;
  payment: { txHash: string; denom: string; amount: string; memo: string } | null;
  /** A payment whose memo names a sealed note that has not arrived (or a note whose payment is not on chain yet). */
  noteMissing?: boolean;
  paymentMissing?: boolean;
  expiresAt: string | null;
}

export const inboxRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    app.get("/owner/inbox", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const q = z
        .object({
          box: z.enum(["inbox", "archived", "sent"]).default("inbox"),
          before: z.iso.datetime().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(100),
        })
        .safeParse(req.query);
      if (!q.success) return fail(reply, 400, "BAD_REQUEST", "That inbox query is not valid.");
      const box = q.data.box;
      const before = q.data.before ? new Date(q.data.before) : new Date(Date.now() + 60_000);

      const env = await db
        .select()
        .from(envelopes)
        .where(
          box === "sent"
            ? and(
                sql`${envelopes.senderSig}->>'signer' = ${owner}`,
                lt(envelopes.createdAt, before),
                notInArray(envelopes.kind, [...SELF_KINDS]),
              )
            : and(
                eq(envelopes.owner, owner),
                eq(envelopes.archived, box === "archived"),
                lt(envelopes.createdAt, before),
                notInArray(envelopes.kind, [...SELF_KINDS]),
              ),
        )
        .orderBy(desc(envelopes.createdAt))
        .limit(q.data.limit);
      const pays =
        box !== "inbox"
          ? []
          : await db
              .select()
              .from(payments)
              .where(and(eq(payments.toAddr, owner), lt(payments.time, before)))
              .orderBy(desc(payments.time))
              .limit(q.data.limit);

      // Join requests for rooms this account owns or administers; they leave the inbox once handled.
      const reqs =
        box !== "inbox"
          ? []
          : await db
              .select({ roomId: roomRequests.roomId, address: roomRequests.address, at: roomRequests.at })
              .from(roomRequests)
              .innerJoin(
                roomMembers,
                and(
                  eq(roomMembers.roomId, roomRequests.roomId),
                  eq(roomMembers.address, owner),
                  eq(roomMembers.status, "active"),
                  inArray(roomMembers.role, ["owner", "admin"]),
                ),
              )
              .where(and(eq(roomRequests.status, "pending"), lt(roomRequests.at, before)))
              .orderBy(desc(roomRequests.at))
              .limit(q.data.limit);

      const signers = [
        ...new Set([
          ...reqs.map((r) => r.address),
          ...env.map((e) => (e.senderSig as { signer?: string } | null)?.signer).filter((x): x is string => !!x),
          ...env.map((e) => e.owner),
          ...pays.map((p) => p.fromAddr),
        ]),
      ];
      const named = signers.length
        ? await db
            .select({ address: names.address, name: names.name, primary: names.primary })
            .from(names)
            .where(inArray(names.address, signers))
        : [];
      const nameOf = (a: string) =>
        named.find((n) => n.address === a && n.primary)?.name ?? named.find((n) => n.address === a)?.name ?? null;
      // Notes named by these payments, looked up directly (they may be older, or archived), owner-bound.
      const noteHashes = [...new Set(pays.map((p) => p.noteHash).filter((h): h is string => !!h))];
      const notes = noteHashes.length
        ? await db
            .select()
            .from(envelopes)
            .where(and(eq(envelopes.owner, owner), inArray(envelopes.hash, noteHashes)))
        : [];
      // Payment notes whose payment is on chain (any time), so they are shown inside that payment row.
      const paynoteHashes = env.filter((e) => e.kind === "paynote").map((e) => e.hash);
      const paidNotes = new Set(
        paynoteHashes.length
          ? (
              await db
                .select({ noteHash: payments.noteHash })
                .from(payments)
                .where(and(eq(payments.toAddr, owner), inArray(payments.noteHash, paynoteHashes)))
            ).map((r) => r.noteHash)
          : [],
      );

      const rows: InboxRow[] = [
        ...env
          // A payment's sealed note is shown inside its payment row, not twice.
          .filter((e) => !(e.kind === "paynote" && paidNotes.has(e.hash)))
          .map((e): InboxRow => {
            const signer = (e.senderSig as { signer?: string } | null)?.signer;
            return {
              id: e.hash,
              type: "envelope",
              kind: e.kind,
              envelope: e.hash,
              size: e.size,
              readers: e.readers,
              at: e.createdAt.toISOString(),
              // What you sent is never "unread" for you.
              read: box === "sent" || e.readAt !== null,
              archived: e.archived,
              ref: e.ref,
              sender: signer ? { address: signer, name: nameOf(signer), how: "signed" } : null,
              senderSig: e.senderSig,
              to: box === "sent" ? { address: e.owner, name: nameOf(e.owner) } : null,
              payment: null,
              ...(e.kind === "paynote" ? { paymentMissing: true } : {}),
              expiresAt: e.expiresAt?.toISOString() ?? null,
            };
          }),
        ...pays.map((p): InboxRow => {
          const note = notes.find((e) => e.hash === p.noteHash);
          return {
            id: `${p.txHash}:${p.msgIndex}`,
            type: "payment",
            kind: p.kind === "inv" ? "invoice-payment" : p.kind === "ord" ? "order" : "payment",
            envelope: p.noteHash,
            size: note?.size ?? 0,
            readers: note?.readers ?? 0,
            at: p.time.toISOString(),
            read: note ? note.readAt !== null : true,
            archived: false,
            ref: p.ref,
            sender: { address: p.fromAddr, name: nameOf(p.fromAddr), how: "payment" },
            senderSig: note?.senderSig ?? null,
            to: null,
            payment: { txHash: p.txHash, denom: p.denom, amount: p.amount, memo: p.memo },
            ...(p.noteHash && !note ? { noteMissing: true } : {}),
            expiresAt: note?.expiresAt?.toISOString() ?? null,
          };
        }),
        ...reqs.map((r): InboxRow => ({
          id: `room:${r.roomId}:${r.address}`,
          type: "request",
          kind: "request",
          envelope: null,
          size: 0,
          readers: 0,
          at: r.at.toISOString(),
          read: false,
          archived: false,
          ref: `room:${r.roomId}`,
          sender: { address: r.address, name: nameOf(r.address), how: "request" },
          senderSig: null,
          to: null,
          payment: null,
          expiresAt: null,
        })),
      ].sort((a, b) => b.at.localeCompare(a.at));
      return { rows: rows.slice(0, q.data.limit), unread: rows.filter((r) => !r.read).length };
    });

    app.patch("/owner/inbox/:hash", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const { hash } = req.params as { hash: string };
      if (!isHash(hash)) return fail(reply, 400, "BAD_HASH", "Not an item id.");
      const b = z.object({ read: z.boolean().optional(), archived: z.boolean().optional() }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Nothing changed.");
      const set: Partial<typeof envelopes.$inferInsert> = {};
      if (b.data.read !== undefined) set.readAt = b.data.read ? new Date() : null;
      if (b.data.archived !== undefined) set.archived = b.data.archived;
      const r = await db
        .update(envelopes)
        .set(set)
        .where(and(eq(envelopes.hash, hash), eq(envelopes.owner, owner)))
        .returning({ hash: envelopes.hash });
      if (r.length === 0) return fail(reply, 404, "NOT_FOUND", "That item is not in your inbox.");
      return { ok: true };
    });

    /** Notes an owner filed for themselves (for example proof labels): hashes and refs only. */
    app.get("/owner/notes", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const { kind } = req.query as { kind?: string };
      if (!kind || !SELF_KINDS.includes(kind)) return fail(reply, 400, "BAD_REQUEST", "Say which kind of note.");
      const rows = await db
        .select({ hash: envelopes.hash, ref: envelopes.ref, at: envelopes.createdAt })
        .from(envelopes)
        .where(and(eq(envelopes.owner, owner), eq(envelopes.kind, kind)))
        .orderBy(desc(envelopes.createdAt))
        .limit(1000);
      return { notes: rows.map((r) => ({ hash: r.hash, ref: r.ref, at: r.at.toISOString() })) };
    });

    app.get("/owner/unread", async (req, reply) => {
      const owner = await sessionAddress(db, req);
      if (!owner) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const [r] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(envelopes)
        .where(and(eq(envelopes.owner, owner), eq(envelopes.archived, false), isNull(envelopes.readAt)));
      const [q] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(roomRequests)
        .innerJoin(
          roomMembers,
          and(
            eq(roomMembers.roomId, roomRequests.roomId),
            eq(roomMembers.address, owner),
            eq(roomMembers.status, "active"),
            inArray(roomMembers.role, ["owner", "admin"]),
          ),
        )
        .where(eq(roomRequests.status, "pending"));
      return { unread: (r?.n ?? 0) + (q?.n ?? 0) };
    });

    /**
     * Live "something new arrived" events for an open dashboard. The first frame
     * must be the session token; after that the socket only ever carries the
     * word "new" (never content, never who sent it).
     */
    app.get("/owner/events", { websocket: true }, (socket) => {
      let owner: string | null = null;
      const timer = setTimeout(() => socket.close(4401, "sign in first"), 5000);
      socket.on("message", (raw: Buffer) => {
        if (owner) return;
        const token = raw.toString().trim();
        void db
          .select()
          .from(sessions)
          .where(and(eq(sessions.tokenHash, createHash("sha256").update(token).digest("hex"))))
          .then(([s]) => {
            clearTimeout(timer);
            if (!s || s.expiresAt < new Date()) {
              socket.close(4401, "signed out");
              return;
            }
            owner = s.address;
            ctx.events.subscribe(owner, socket);
            socket.send(JSON.stringify({ type: "ready" }));
          });
      });
      socket.on("close", () => {
        clearTimeout(timer);
        if (owner) ctx.events.unsubscribe(owner, socket);
      });
    });

    done();
  };
