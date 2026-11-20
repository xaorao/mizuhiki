/**
 * The drop service (spec 7): accepts sealed items addressed to an owner.
 * Content-blind: it reads only the envelope's header (magic, reader count),
 * checks size, a proof-of-work stamp bound to this envelope, rate limits and,
 * when the sender chose to sign, the sender's hybrid signature against their
 * key on chain. It never sees what is inside.
 */
import type { FastifyPluginCallback } from "fastify";
import { eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { checkPow, envelopeFacts, fromBase64Url, verifyRecord, type Signed } from "@mizuhiki/core";
import { blobs, cards, envelopes, pages } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { pqKeyOf } from "../lib/chainreads";
import { sha256Hex } from "../lib/blobstore";
import { formNotifies, formRefusal } from "./forms";
import { fileDropCheck } from "./filerequests";
import { fail, isAddress } from "../lib/http";

export const DROP_KINDS = [
  "message",
  "form",
  "paynote",
  "invoice",
  "order",
  "reply",
  "request",
  "proof",
  "formtags",
  "formsnaps",
  "filedrop",
] as const;
/** Kinds an owner files for themselves (private labels): kept until deleted, never "unread". */
export const SELF_KINDS: readonly string[] = ["proof", "formtags", "formsnaps"];
const MAX_ENVELOPE = 256 * 1024;
const MAX_CHUNKS = 600; // 600 x 4 MiB = 2.4 GB across all files in one drop

const SenderSig = z.object({
  kind: z.literal("sender"),
  signer: z.string(),
  body: z.object({ envelope: z.string().regex(/^[0-9a-f]{64}$/), to: z.string(), at: z.string() }),
  signature: z.object({
    signatureType: z.enum(["ml-dsa-87-hybrid", "secp256k1"]),
    classical: z.object({
      keyType: z.enum(["secp256k1", "eth_secp256k1"]),
      publicKey: z.string().max(200),
      signature: z.string().max(200),
    }),
    pq: z.object({ algorithmId: z.number(), signature: z.string().max(8000) }).optional(),
  }),
});

const Body = z.object({
  envelope: z.string().max(Math.ceil((MAX_ENVELOPE * 4) / 3) + 8),
  kind: z.enum(DROP_KINDS),
  ref: z
    .string()
    .regex(/^[A-Za-z0-9_:.-]{1,96}$/)
    .optional(),
  chunks: z
    .array(z.string().regex(/^[0-9a-f]{64}$/))
    .max(MAX_CHUNKS)
    .default([]),
  pow: z.object({ minute: z.number().int(), nonce: z.number().int(), bits: z.number().int() }),
  sender: SenderSig.optional(),
});

export const dropRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    app.get("/drop/config", () => ({
      powBits: ctx.cfg.POW_BITS,
      retentionDays: ctx.cfg.DROP_RETENTION_DAYS,
      maxEnvelopeBytes: MAX_ENVELOPE,
      chunkBytes: 4 * 1024 * 1024,
      maxChunks: MAX_CHUNKS,
    }));

    app.post(
      "/drop/:address",
      {
        bodyLimit: Math.ceil((MAX_ENVELOPE * 4) / 3) + 64 * 1024,
        config: {
          rateLimit: {
            max: 30,
            timeWindow: "10 minutes",
            hook: "preHandler",
            keyGenerator: (req) => `${req.ip}|${(req.params as { address?: string }).address ?? ""}`,
          },
        },
      },
      async (req, reply) => {
        const { address } = req.params as { address: string };
        if (!isAddress(address))
          return fail(
            reply,
            400,
            "BAD_ADDRESS",
            "That is not a QoreChain address. Nothing was stored.",
            "nothing-stored",
          );
        const b = Body.safeParse(req.body);
        if (!b.success)
          return fail(
            reply,
            400,
            "BAD_REQUEST",
            "The sealed item was incomplete. Nothing was stored.",
            "nothing-stored",
          );
        // A recipient needs a Mizuhiki account: a published page, or at least a signed
        // recipient card (people who only reply or receive forwards may have no page).
        const [page] = await ctx.db.select({ address: pages.address }).from(pages).where(eq(pages.address, address));
        const [card] = page
          ? [page]
          : await ctx.db.select({ address: cards.address }).from(cards).where(eq(cards.address, address));
        if (!card)
          return fail(
            reply,
            404,
            "NO_ACCOUNT",
            "This person does not have a Mizuhiki account. Nothing was stored.",
            "nothing-stored",
          );

        let bytes: Uint8Array;
        let facts: ReturnType<typeof envelopeFacts>;
        try {
          bytes = fromBase64Url(b.data.envelope);
          if (bytes.length > MAX_ENVELOPE) throw new Error("too large");
          facts = envelopeFacts(bytes);
        } catch {
          return fail(reply, 400, "NOT_SEALED", "That is not a sealed envelope. Nothing was stored.", "nothing-stored");
        }
        const hash = sha256Hex(bytes);
        if (!checkPow(b.data.pow, address, hash, ctx.cfg.POW_BITS)) {
          return fail(
            reply,
            429,
            "POW",
            "Your browser's anti-spam check did not pass. Try sending again. Nothing was stored.",
            "nothing-stored",
          );
        }

        // Chunks must already be uploaded (PUT /blobs), so a drop never points at nothing.
        let chunkBytes = 0;
        if (b.data.chunks.length > 0) {
          const found = await ctx.db
            .select({ hash: blobs.hash, size: blobs.size })
            .from(blobs)
            .where(inArray(blobs.hash, b.data.chunks));
          chunkBytes = found.reduce((n, f) => n + f.size, 0);
          if (new Set(found.map((f) => f.hash)).size !== new Set(b.data.chunks).size) {
            return fail(
              reply,
              409,
              "MISSING_PARTS",
              "Some sealed pieces of your files did not arrive. Send again. Nothing was delivered.",
              "nothing-stored",
            );
          }
        }

        let senderSig: Signed<{ envelope: string; to: string; at: string }> | null = null;
        if (b.data.sender) {
          const sig = b.data.sender;
          if (sig.body.envelope !== hash || sig.body.to !== address || !isAddress(sig.signer)) {
            return fail(
              reply,
              400,
              "BAD_SIGNATURE",
              "The signature is for a different item. Nothing was stored.",
              "nothing-stored",
            );
          }
          const key = await pqKeyOf(sig.signer);
          try {
            if (!key.publicKey) throw new Error("no key");
            verifyRecord(
              {
                kind: "sender",
                signer: sig.signer,
                body: sig.body,
                signature: { ...sig.signature, ...(sig.signature.pq ? { pq: sig.signature.pq } : {}) },
              } as Signed<typeof sig.body>,
              { kind: "sender", signer: sig.signer, pqPublicKey: key.publicKey },
            );
          } catch {
            return fail(
              reply,
              400,
              "BAD_SIGNATURE",
              "The sender signature does not match that account's key on chain. Nothing was stored.",
              "nothing-stored",
            );
          }
          senderSig = sig as Signed<typeof sig.body>;
        }

        // Form answers: the form must accept them; with notifications off they arrive already read and silent.
        let quiet = false;
        if (b.data.kind === "form") {
          const why = await formRefusal(ctx.db, address, b.data.ref);
          if (why) return fail(reply, 409, "FORM_CLOSED", why, "nothing-stored");
          quiet = !(await formNotifies(ctx.db, address, b.data.ref));
        }
        // File request uploads: the request must take them now; late ones are marked late.
        let late = false;
        if (b.data.kind === "filedrop") {
          const check = await fileDropCheck(ctx.db, address, b.data.ref);
          if ("refusal" in check) return fail(reply, 409, "REQUEST_CLOSED", check.refusal, "nothing-stored");
          late = check.late;
        }
        const self = SELF_KINDS.includes(b.data.kind);
        if (self && senderSig?.signer !== address)
          return fail(
            reply,
            400,
            "BAD_SIGNATURE",
            "Only the account owner can file this for themselves. Nothing was stored.",
            "nothing-stored",
          );
        const expiresAt = self ? null : new Date(Date.now() + ctx.cfg.DROP_RETENTION_DAYS * 86400_000);
        await ctx.blobs.put(bytes);
        await ctx.db.transaction(async (tx) => {
          await tx
            .insert(blobs)
            .values({ hash, size: bytes.length, expiresAt })
            .onConflictDoUpdate({ target: blobs.hash, set: { expiresAt } });
          if (b.data.chunks.length > 0)
            await tx.update(blobs).set({ expiresAt }).where(inArray(blobs.hash, b.data.chunks));
          await tx
            .insert(envelopes)
            .values({
              hash,
              owner: address,
              kind: b.data.kind,
              ref: b.data.ref ?? null,
              size: bytes.length + chunkBytes,
              readers: facts.readers,
              chunks: b.data.chunks,
              senderSig,
              expiresAt,
              readAt: self || quiet ? new Date() : null,
              late,
            })
            .onConflictDoNothing();
          if (!quiet) await tx.execute(sql`select pg_notify('mzk_events', ${`drop:${address}`})`);
        });
        return { hash, expiresAt: expiresAt?.toISOString() ?? null, readers: facts.readers, ...(late ? { late } : {}) };
      },
    );

    done();
  };
