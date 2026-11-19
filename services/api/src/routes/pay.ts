/**
 * Payment lookups for a payer's screen (spec 5.5). Payments are public chain
 * data the indexer copied; this route only answers "has the payment with this
 * reference reached this owner yet", so a manual payer's screen can move on.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import { payments } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { fail, isAddress } from "../lib/http";

export const payRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    app.get("/pay/:address/:ref", async (req, reply) => {
      const { address, ref } = req.params as { address: string; ref: string };
      if (!isAddress(address) || !/^[A-Za-z0-9_-]{1,64}$/.test(ref))
        return fail(reply, 400, "BAD_REQUEST", "That payment reference is not valid.");
      const rows = await ctx.db
        .select()
        .from(payments)
        .where(and(eq(payments.toAddr, address), eq(payments.ref, ref)))
        .orderBy(desc(payments.height))
        .limit(20);
      return {
        payments: rows.map((p) => ({
          txHash: p.txHash,
          from: p.fromAddr,
          denom: p.denom,
          amount: p.amount,
          noteHash: p.noteHash,
          height: p.height.toString(),
          at: p.time.toISOString(),
        })),
      };
    });
    done();
  };
