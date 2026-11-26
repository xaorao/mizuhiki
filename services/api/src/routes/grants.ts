/**
 * Starter grants (ARCHITECTURE 8h): a new account gets a little test QOR once, from the testnet sponsor, so sign-up
 * needs no faucet. The browser proves it controls the address with its classical key over a one-time challenge (its
 * ML-DSA key is registered with this money, so it cannot be checked yet) and a proof of work. One grant per address,
 * only for addresses that have never existed on chain, under a per-network and a global daily limit. Testnet only.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, count, eq, gt } from "drizzle-orm";
import { z } from "zod";
import { verifySiwq } from "@qorechain/qoresign";
import { DENOMS, NETWORK, accountInfo, balanceOf, feeFor, msgSend, sendTx, type Signer } from "@mizuhiki/chain";
import { createHmac } from "node:crypto";
import { checkPow, deriveAccount, sha256Hex, utf8 } from "@mizuhiki/core";
import { authNonces, starterGrants } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { webOriginFor } from "../config";
import { fail } from "../lib/http";

/** Enough gas for one bank send, for the sponsor's balance check (the real fee comes from simulation). */
const SEND_GAS = 200_000n;

const Body = z.object({
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  signature: z.object({
    signatureType: z.literal("secp256k1"),
    classical: z.object({
      keyType: z.enum(["secp256k1", "eth_secp256k1"]),
      publicKey: z.string().max(200),
      signature: z.string().max(200),
    }),
  }),
  pow: z.object({ minute: z.number().int(), nonce: z.number().int(), bits: z.number().int() }),
});

const startOfDay = () => new Date(Date.now() - 24 * 3600_000);

export const grantRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const sponsor: Signer | null =
      // Testnet only: NETWORK is the testnet by type (`chainId: "qorechain-diana"`), there is no mainnet setting.
      ctx.cfg.SPONSOR_PHRASE
        ? (() => {
            const k = deriveAccount(ctx.cfg.SPONSOR_PHRASE);
            return { address: k.address.bech32, classical: k.classical, pq: k.pq };
          })()
        : null;
    const amount = BigInt(ctx.cfg.STARTER_GRANT_UQOR);
    const ipKey = sha256Hex(utf8(`mzk:grant-ip-key|${ctx.cfg.SPONSOR_PHRASE ?? ""}`));
    // One send at a time, so the sponsor's sequence numbers never collide.
    let queue: Promise<unknown> = Promise.resolve();
    const serial = <T>(job: () => Promise<T>): Promise<T> => {
      const run = queue.then(job, job);
      queue = run.catch(() => undefined);
      return run;
    };

    app.get("/grants/starter", async () => {
      if (!sponsor) return { enabled: false, reason: "off" as const };
      const [today] = await ctx.db
        .select({ n: count() })
        .from(starterGrants)
        .where(gt(starterGrants.createdAt, startOfDay()));
      if ((today?.n ?? 0) >= ctx.cfg.STARTER_DAILY_CAP) return { enabled: false, reason: "cap" as const };
      return {
        enabled: true,
        amount: amount.toString(),
        denom: DENOMS.QOR.denom,
        powBits: ctx.cfg.STARTER_POW_BITS,
      };
    });

    app.post(
      "/grants/starter",
      {
        config: {
          rateLimit: {
            max: ctx.cfg.STARTER_REQUESTS_PER_10MIN,
            timeWindow: "10 minutes",
            keyGenerator: (req) => req.ip,
            hook: "preHandler",
          },
        },
      },
      async (req, reply) => {
        if (!sponsor)
          return fail(
            reply,
            404,
            "GRANTS_OFF",
            "Starter test QOR is not offered here. Use the faucet.",
            "nothing-changed",
          );
        const b = Body.safeParse(req.body);
        if (!b.success)
          return fail(reply, 400, "BAD_REQUEST", "The request was incomplete. Nothing was sent.", "nothing-changed");

        // The challenge is used once, whatever happens next.
        const [row] = await ctx.db
          .select()
          .from(authNonces)
          .where(and(eq(authNonces.nonce, b.data.nonce), gt(authNonces.expiresAt, new Date())));
        if (!row)
          return fail(reply, 401, "EXPIRED", "This request expired. Try again. Nothing was sent.", "nothing-changed");
        await ctx.db.delete(authNonces).where(eq(authNonces.nonce, b.data.nonce));
        const address = row.address;
        try {
          verifySiwq({
            message: row.message,
            signature: b.data.signature,
            domain: new URL(webOriginFor(ctx.cfg, req.headers.origin)).host,
            nonce: row.nonce,
            chainId: NETWORK.chainId,
            requirePq: false,
          });
        } catch {
          return fail(
            reply,
            401,
            "NOT_YOURS",
            "The signature does not match this account. Nothing was sent.",
            "nothing-changed",
          );
        }
        if (!checkPow(b.data.pow, address, sha256Hex(utf8(b.data.nonce)), ctx.cfg.STARTER_POW_BITS))
          return fail(
            reply,
            429,
            "POW",
            "Your browser's anti-spam check did not pass. Try again. Nothing was sent.",
            "nothing-changed",
          );

        // Only accounts that have never been on chain: an existing one can pay its own fees.
        const [onChain, balance] = await Promise.all([accountInfo(address), balanceOf(address, DENOMS.QOR.denom)]);
        if (onChain.exists || balance > 0n)
          return fail(
            reply,
            409,
            "ALREADY_ON_CHAIN",
            "This account is already on QoreChain, so it can pay its own fees. Nothing was sent.",
            "nothing-changed",
          );

        // Keyed with a secret only this server holds, so a stored hash cannot be brute-forced back to an address.
        const ipHash = createHmac("sha256", ipKey).update(req.ip).digest("hex");
        const [all] = await ctx.db
          .select({ n: count() })
          .from(starterGrants)
          .where(gt(starterGrants.createdAt, startOfDay()));
        if ((all?.n ?? 0) >= ctx.cfg.STARTER_DAILY_CAP)
          return fail(
            reply,
            429,
            "CAP",
            "Today's starter test QOR has all been given out. Use the faucet. Nothing was sent.",
            "nothing-changed",
          );
        const [mine] = await ctx.db
          .select({ n: count() })
          .from(starterGrants)
          .where(and(eq(starterGrants.ipHash, ipHash), gt(starterGrants.createdAt, startOfDay())));
        if ((mine?.n ?? 0) >= ctx.cfg.STARTER_PER_IP_DAY)
          return fail(
            reply,
            429,
            "IP_CAP",
            "This network has had its starter test QOR for today. Use the faucet. Nothing was sent.",
            "nothing-changed",
          );

        // Claim the address first, so two requests at once cannot both be paid.
        const claimed = await ctx.db
          .insert(starterGrants)
          .values({ address, ipHash, amount: amount.toString(), txHash: "" })
          .onConflictDoNothing()
          .returning({ address: starterGrants.address });
        if (!claimed.length)
          return fail(
            reply,
            409,
            "ALREADY_GRANTED",
            "This account already had its starter test QOR. Nothing was sent.",
            "nothing-changed",
          );

        try {
          const result = await serial(async () => {
            const have = await balanceOf(sponsor.address, DENOMS.QOR.denom);
            if (have < amount + feeFor(SEND_GAS)) throw new Error("SPONSOR_LOW");
            return sendTx(sponsor, [msgSend(sponsor.address, address, DENOMS.QOR.denom, amount)], "mzk:starter-grant");
          });
          await ctx.db.update(starterGrants).set({ txHash: result.txHash }).where(eq(starterGrants.address, address));
          return { txHash: result.txHash, amount: amount.toString(), denom: DENOMS.QOR.denom };
        } catch (e) {
          // Nothing was paid: release the claim so the account can try again later or use the faucet.
          await ctx.db.delete(starterGrants).where(eq(starterGrants.address, address));
          if ((e as Error).message === "SPONSOR_LOW")
            return fail(
              reply,
              503,
              "SPONSOR_LOW",
              "The starter test QOR has run out for now. Use the faucet. Nothing was sent.",
              "nothing-changed",
            );
          req.log.warn({ err: e }, "starter grant failed");
          return fail(
            reply,
            502,
            "SEND_FAILED",
            "QoreChain did not take the starter test QOR just now. Try again, or use the faucet.",
            "nothing-changed",
          );
        }
      },
    );
    done();
  };
