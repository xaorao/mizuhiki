import { loadConfig } from "./config";
import { runMigrations } from "@mizuhiki/db";
import { buildServer } from "./server";
import { sweepBlobs } from "./routes/blobs";

const cfg = loadConfig();
await runMigrations(cfg.DATABASE_URL);
const { app, ctx, close } = await buildServer(cfg);
await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });
const sweep = setInterval(() => {
  sweepBlobs(ctx).catch((e: unknown) => app.log.error(e, "blob sweep failed"));
}, 10 * 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(sweep);
    void close().then(() => process.exit(0));
  });
}
