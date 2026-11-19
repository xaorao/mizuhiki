import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
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
    allowedHeaders: ["content-type", "authorization", "x-pow"],
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
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
