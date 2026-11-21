/**
 * Relay for QoreChain native-lane REST calls from browsers. The public testnet
 * REST endpoint sends no CORS headers (checked 2026-11-18), so a page cannot
 * call it directly. This relay forwards only an allowlist of read routes plus
 * simulate and broadcast of transactions the browser already signed, and one RPC read (a committed
 * transaction's exact bytes, by hash). It holds
 * no keys and changes nothing; a relay that lies is caught where it matters
 * (THREAT_MODEL A6, and packages/chain/src/recipients.ts).
 */
import type { FastifyPluginCallback } from "fastify";
import { NETWORK } from "@mizuhiki/chain";
import { fail } from "../lib/http";

const ADDR = "qor1[02-9ac-hj-np-z]{38}";
const GET_ROUTES: RegExp[] = [
  new RegExp(`^/cosmos/auth/v1beta1/account_info/${ADDR}$`),
  new RegExp(`^/cosmos/bank/v1beta1/balances/${ADDR}(/by_denom)?$`),
  /^\/cosmos\/tx\/v1beta1\/txs\/[0-9A-Fa-f]{64}$/,
  /^\/cosmos\/tx\/v1beta1\/txs$/,
  /^\/cosmos\/base\/tendermint\/v1beta1\/blocks\/(latest|\d+)$/,
  /^\/cosmos\/base\/tendermint\/v1beta1\/node_info$/,
  /^\/cosmos\/upgrade\/v1beta1\/applied_plan\/[A-Za-z0-9._-]{1,64}$/,
  new RegExp(`^/qorechain/pqc/v1/(account|kem|evm_window|evm-window)/${ADDR}$`),
  /^\/qorechain\/pqc\/v1\/protocol_features$/,
  /^\/qorechain\/pqc\/v1\/[a-z_/-]{1,60}$/,
];
const POST_ROUTES = new Set(["/cosmos/tx/v1beta1/simulate", "/cosmos/tx/v1beta1/txs"]);
const QUERY_KEYS = new Set([
  "denom",
  "query",
  "page",
  "limit",
  "order_by",
  "pagination.limit",
  "pagination.key",
  "pagination.offset",
  "pagination.reverse",
]);

export const chainRoutes = (): FastifyPluginCallback => (app, _opts, done) => {
  app.route({
    method: ["GET", "POST"],
    url: "/chain/*",
    config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
    handler: async (req, reply) => {
      const raw = (req.params as { "*": string })["*"];
      const path = `/${raw}`;
      // The exact committed bytes of one transaction, from the CometBFT RPC node, so a browser can check its
      // ML-DSA-87 layer over what was really committed (and hash them to the id it asked for).
      if (path === "/rpc/tx") {
        const q = req.query as Record<string, unknown>;
        const hash = typeof q.hash === "string" ? q.hash : "";
        if (req.method !== "GET" || Object.keys(q).length !== 1 || !/^0x[0-9A-Fa-f]{64}$/.test(hash))
          return fail(reply, 400, "NOT_RELAYED", "That chain query is not relayed.");
        let rpc: Response;
        try {
          rpc = await fetch(`${NETWORK.rpc}/tx?hash=${hash}`, { signal: AbortSignal.timeout(20_000) });
        } catch {
          return fail(reply, 502, "CHAIN_UNREACHABLE", "QoreChain did not answer.", "nothing-changed");
        }
        return reply
          .code(rpc.status)
          .header("content-type", "application/json")
          .header("cache-control", "no-store")
          .send(await rpc.text());
      }
      const url = new URL(`${NETWORK.rest}${path}`);
      for (const [k, v] of Object.entries(req.query as Record<string, string>)) {
        if (!QUERY_KEYS.has(k) || typeof v !== "string" || v.length > 512)
          return fail(reply, 400, "NOT_RELAYED", "That chain query is not relayed.");
        url.searchParams.set(k, v);
      }
      if (req.method === "GET" && !GET_ROUTES.some((r) => r.test(path)))
        return fail(reply, 404, "NOT_RELAYED", "That chain route is not relayed.");
      if (req.method === "POST") {
        if (!POST_ROUTES.has(path)) return fail(reply, 404, "NOT_RELAYED", "That chain route is not relayed.");
        const b = req.body as { tx_bytes?: unknown; mode?: unknown } | undefined;
        if (typeof b?.tx_bytes !== "string" || b.tx_bytes.length > 200_000)
          return fail(reply, 400, "BAD_TX", "No signed transaction was sent.", "nothing-stored");
        if (path.endsWith("/txs") && b.mode !== "BROADCAST_MODE_SYNC")
          return fail(reply, 400, "BAD_TX", "Only synchronous broadcast is relayed.", "nothing-stored");
      }
      let res: Response;
      try {
        res = await fetch(url, {
          method: req.method,
          headers: req.method === "POST" ? { "content-type": "application/json" } : {},
          ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}),
          signal: AbortSignal.timeout(20_000),
        });
      } catch {
        return fail(reply, 502, "CHAIN_UNREACHABLE", "QoreChain did not answer. Nothing was sent.", "nothing-changed");
      }
      const text = await res.text();
      // Polling a transaction that is not committed yet is normal, not an error:
      // answer 200 with no tx_response so browsers do not log a failed request.
      if (req.method === "GET" && res.status === 404 && /^\/cosmos\/tx\/v1beta1\/txs\/[0-9A-Fa-f]{64}$/.test(path)) {
        return reply.code(200).header("cache-control", "no-store").send({ tx_response: null, pending: true });
      }
      return reply
        .code(res.status)
        .header("content-type", res.headers.get("content-type") ?? "application/json")
        .header("cache-control", "no-store")
        .send(text);
    },
  });
  done();
};
