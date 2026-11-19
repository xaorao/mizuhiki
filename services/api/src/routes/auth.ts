import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import type { Ctx } from "../server";
import { AuthError, completeSignIn, endSession, issueChallenge, sessionAddress } from "../lib/auth";
import { fail, isAddress } from "../lib/http";

const Sig = z.object({
  signatureType: z.enum(["ml-dsa-87-hybrid", "secp256k1"]),
  classical: z.object({
    keyType: z.enum(["secp256k1", "eth_secp256k1"]),
    publicKey: z.string().max(200),
    signature: z.string().max(200),
  }),
  pq: z.object({ algorithmId: z.number(), signature: z.string().max(8000) }).optional(),
});

export const authRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    // Limits are per account (and per nonce for verify), so many people behind one
    // address (an office, a test run) are not blocked by each other; the global
    // per-IP limit still applies on top.
    const byAccount = (req: { ip: string; body: unknown }) => {
      const b = req.body as { address?: unknown; nonce?: unknown } | undefined;
      return `${req.ip}|${typeof b?.address === "string" ? b.address : typeof b?.nonce === "string" ? b.nonce : ""}`;
    };
    app.post(
      "/auth/challenge",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute", keyGenerator: byAccount, hook: "preHandler" } } },
      async (req, reply) => {
        const address = (req.body as { address?: unknown } | undefined)?.address;
        if (!isAddress(address)) return fail(reply, 400, "BAD_ADDRESS", "That is not a QoreChain address.");
        return issueChallenge(ctx.db, address, ctx.cfg.WEB_ORIGIN);
      },
    );
    app.post(
      "/auth/verify",
      { config: { rateLimit: { max: 5, timeWindow: "1 minute", keyGenerator: byAccount, hook: "preHandler" } } },
      async (req, reply) => {
        const body = z.object({ nonce: z.string().regex(/^[0-9a-f]{32}$/), signature: Sig }).safeParse(req.body);
        if (!body.success) return fail(reply, 400, "BAD_REQUEST", "The sign-in request was incomplete.");
        try {
          const { signature } = body.data;
          const s = await completeSignIn(ctx.db, {
            nonce: body.data.nonce,
            signature: {
              signatureType: signature.signatureType,
              classical: signature.classical,
              ...(signature.pq ? { pq: signature.pq } : {}),
            },
            origin: ctx.cfg.WEB_ORIGIN,
            sessionHours: ctx.cfg.SESSION_HOURS,
          });
          return { token: s.token, address: s.address, expiresAt: s.expiresAt.toISOString() };
        } catch (e) {
          if (e instanceof AuthError) return fail(reply, 401, "SIGN_IN_FAILED", e.message);
          throw e;
        }
      },
    );
    app.get("/auth/me", async (req, reply) => {
      const address = await sessionAddress(ctx.db, req);
      if (!address) return fail(reply, 401, "SIGNED_OUT", "You are signed out on this device.");
      return { address };
    });
    app.post("/auth/logout", async (req) => {
      await endSession(ctx.db, req);
      return { ok: true };
    });
    done();
  };
