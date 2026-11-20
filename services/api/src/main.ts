import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config";
import { runMigrations } from "@mizuhiki/db";
import { buildServer } from "./server";
import { sweepBlobs } from "./routes/blobs";
import { sweepRoomBatches } from "./routes/rooms";
import { remindCheckIns } from "./lib/reminders";

// Local secrets (for example ANTHROPIC_API_KEY) live in services/api/.env.local,
// which git ignores. Values already in the environment win.
const localEnv = fileURLToPath(new URL("../.env.local", import.meta.url));
if (existsSync(localEnv)) process.loadEnvFile(localEnv);

const cfg = loadConfig();
await runMigrations(cfg.DATABASE_URL);
const { app, ctx, close } = await buildServer(cfg);
await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });
const sweep = setInterval(() => {
  sweepRoomBatches(ctx.db).catch((e: unknown) => app.log.error(e, "room sweep failed"));
  sweepBlobs(ctx).catch((e: unknown) => app.log.error(e, "blob sweep failed"));
}, 10 * 60_000);
const reminders = setInterval(() => {
  remindCheckIns(ctx.db, ctx.push).catch((e: unknown) => app.log.error(e, "check-in reminders failed"));
}, 60 * 60_000);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(sweep);
    clearInterval(reminders);
    void close().then(() => process.exit(0));
  });
}
