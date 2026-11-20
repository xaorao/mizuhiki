import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createHash } from "node:crypto";
import { sessionAddress } from "./lib/auth";
import { isChainUnreachable } from "./lib/errors";
import websocket from "@fastify/websocket";
import type { Config } from "./config";
import { makeDb, type Db } from "@mizuhiki/db";
import { FsBlobStore, type BlobStore } from "./lib/blobstore";
import { EventHub } from "./lib/events";
import { authRoutes } from "./routes/auth";
import { pageRoutes } from "./routes/pages";
import { blobRoutes } from "./routes/blobs";
import { chainRoutes } from "./routes/chain";
import { aiRoutes } from "./routes/ai";
import { dropRoutes } from "./routes/drop";
import { inboxRoutes } from "./routes/inbox";
import { proofRoutes } from "./routes/proof";
import { payRoutes } from "./routes/pay";
import { invoiceRoutes } from "./routes/invoices";
import { formRoutes } from "./routes/forms";
import { snapshotRoutes } from "./routes/snapshots";
import { roomRoutes } from "./routes/rooms";
import { shopRoutes } from "./routes/shop";
import { passRoutes } from "./routes/passes";
import { recoveryRoutes } from "./routes/recovery";
import { capsuleRoutes } from "./routes/capsules";

export interface Ctx {
  cfg: Config;
  db: Db;
  blobs: BlobStore;
  events: EventHub;
}

export async function buildServer(
  cfg: Config,
  deps: Partial<Ctx> = {},
): Promise<{ app: FastifyInstance; ctx: Ctx; close: () => Promise<void> }> {
  const made = deps.db ? undefined : makeDb(cfg.DATABASE_URL);
  const db = deps.db ?? made?.db;
  if (!db) throw new Error("no database");
  const events = deps.events ?? new EventHub();
  if (!deps.events) await events.start(cfg.DATABASE_URL);
  const ctx: Ctx = { cfg, db, blobs: deps.blobs ?? new FsBlobStore(cfg.BLOB_DIR), events };
  const app = Fastify({
    logger: cfg.NODE_ENV === "test" ? false : { level: "info", redact: ["req.headers.authorization"] },
    bodyLimit: cfg.MAX_BLOB_BYTES,
    trustProxy: false,
  });
  await app.register(cors, {
    origin: [cfg.WEB_ORIGIN],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    allowedHeaders: ["content-type", "authorization", "x-pow", "x-recovery-secret"],
  });
  // Signed-in calls are counted per account, anonymous ones per IP address: people behind one network
  // (an office, a family's Wi-Fi) must not share one budget. Only a real, unexpired session counts as
  // signed in, so a made-up token falls back to the IP. Sign-in itself is limited per account (auth.ts).
  const accountOf = new Map<string, { address: string | undefined; at: number }>();
  await app.register(rateLimit, {
    global: true,
    // A signed-in account's open dashboards (live rooms, capsule and recovery watchers, several tabs) share one
    // budget, so it is larger than an anonymous network's.
    max: (_req, key) => (key.startsWith("a:") ? 900 : 300),
    timeWindow: "1 minute",
    keyGenerator: async (req) => {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ")) return `ip:${req.ip}`;
      const k = createHash("sha256").update(auth).digest("hex");
      let hit = accountOf.get(k);
      if (!hit || Date.now() - hit.at > 30_000) {
        hit = { address: await sessionAddress(ctx.db, req), at: Date.now() };
        accountOf.set(k, hit);
        if (accountOf.size > 10_000) accountOf.clear();
      }
      return hit.address ? `a:${hit.address}` : `ip:${req.ip}`;
    },
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  // One answer for failures no route handled. A QoreChain endpoint being unreachable (REST or EVM) is said
  // plainly as 503; anything else is a 500 that still says nothing changed. Both are logged.
  app.setErrorHandler((err, req, reply) => {
    const e = err as Error & { statusCode?: number; code?: string; name?: string; cause?: unknown };
    if (typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 500) return reply.send(err);
    const chainDown = isChainUnreachable(e);
    req.log.error({ err }, chainDown ? "QoreChain unreachable" : "unhandled error");
    if (chainDown)
      return reply.code(503).send({
        error: {
          code: "CHAIN_UNREACHABLE",
          message: "QoreChain could not be reached just now. Nothing was changed. Try again in a moment.",
          dataState: "nothing-changed",
        },
      });
    return reply.code(500).send({
      error: {
        code: "INTERNAL",
        message: "Something went wrong on our side. Nothing was changed.",
        dataState: "unknown",
      },
    });
  });
  app.get("/health", () => ({ ok: true }));
  await app.register(authRoutes(ctx));
  await app.register(pageRoutes(ctx));
  await app.register(blobRoutes(ctx));
  await app.register(chainRoutes());
  await app.register(aiRoutes(ctx));
  await app.register(dropRoutes(ctx));
  await app.register(inboxRoutes(ctx));
  await app.register(proofRoutes(ctx));
  await app.register(payRoutes(ctx));
  await app.register(invoiceRoutes(ctx));
  await app.register(formRoutes(ctx));
  await app.register(snapshotRoutes(ctx));
  await app.register(roomRoutes(ctx));
  await app.register(shopRoutes(ctx));
  await app.register(passRoutes(ctx));
  await app.register(recoveryRoutes(ctx));
  await app.register(capsuleRoutes(ctx));
  return {
    app,
    ctx,
    close: async () => {
      await app.close();
      if (!deps.events) await events.stop();
      await made?.sql.end();
    },
  };
}
