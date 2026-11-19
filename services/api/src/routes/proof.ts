/**
 * Public, read-only helpers for proof certificates (spec 5.15). Everything
 * here is public chain data the indexer copied; the browser re-reads the
 * anchor itself from chain before showing a certificate.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, desc, eq, sql } from "drizzle-orm";
import { hexToString, type Hex } from "viem";
import { parseAddress } from "@qorechain/qoresign";
import { chainEvents, names } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { fail, isAddress } from "../lib/http";

export interface ProofRow {
  contentHash: string;
  kind: string;
  txHash: string;
  block: string;
  at: string | null;
}

const kindText = (k: unknown): string => {
  if (typeof k !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k)) return "";
  return hexToString(k as Hex, { size: 32 }).replace(/\0+$/, "");
};

export const proofRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    /** The account's Mizuhiki name (primary first). Clients confirm it on chain with `resolve`. */
    app.get("/names/of/:address", async (req, reply) => {
      const { address } = req.params as { address: string };
      if (!isAddress(address)) return fail(reply, 400, "BAD_ADDRESS", "That is not a QoreChain address.");
      const rows = await db
        .select({ name: names.name, primary: names.primary })
        .from(names)
        .where(eq(names.address, address));
      return { name: rows.find((r) => r.primary)?.name ?? rows[0]?.name ?? null };
    });

    /** Anchors made by one account, newest first. */
    app.get("/proofs", async (req, reply) => {
      const { by } = req.query as { by?: string };
      if (!by || !isAddress(by)) return fail(reply, 400, "BAD_ADDRESS", "Say whose anchors to list.");
      const evm = parseAddress(by).hex.toLowerCase();
      const rows = await db
        .select()
        .from(chainEvents)
        .where(and(eq(chainEvents.event, "Anchored"), sql`lower(${chainEvents.args}->>'by') = ${evm}`))
        .orderBy(desc(chainEvents.block))
        .limit(500);
      return {
        proofs: rows.map((r): ProofRow => {
          const a = r.args as { contentHash?: string; kind?: string; at?: string };
          return {
            contentHash: (a.contentHash ?? "").replace(/^0x/, ""),
            kind: kindText(a.kind),
            txHash: r.txHash,
            block: r.block.toString(),
            at: a.at ? new Date(Number(a.at) * 1000).toISOString() : null,
          };
        }),
      };
    });

    done();
  };
