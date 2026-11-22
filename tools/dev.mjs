// Runs the whole product locally against QoreChain testnet: database migrations,
// then the API, the indexer and the web app, with prefixed output.
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki",
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000",
  // On a laptop every request comes from one loopback address, so the per-network starter-grant limit (5 a day,
  // THREAT_MODEL A9) would stop local sign-ups after five; the daily cap and every other check still apply.
  STARTER_PER_IP_DAY: process.env.STARTER_PER_IP_DAY ?? "100000",
};
// Postgres client tools: PG_BIN if set, else Homebrew's postgresql@17, else whatever is on PATH.
const HOMEBREW_PG = "/opt/homebrew/opt/postgresql@17/bin";
const pgBin = process.env.PG_BIN ?? (existsSync(HOMEBREW_PG) ? HOMEBREW_PG : "");
try {
  execSync(`${pgBin ? join(pgBin, "pg_isready") : "pg_isready"} -q`, { stdio: "ignore" });
} catch {
  console.error(
    "Postgres 17 is not answering on 127.0.0.1:5432. Start it (macOS: brew services start postgresql@17), or set PG_BIN to its bin folder.",
  );
  process.exit(1);
}
execSync("pnpm --filter @mizuhiki/db migrate", { stdio: "inherit", env });
const procs = [
  ["api", "pnpm", ["--filter", "@mizuhiki/api", "dev"], "\x1b[35m"],
  ["indexer", "pnpm", ["--filter", "@mizuhiki/indexer", "dev"], "\x1b[36m"],
  ["web", "pnpm", ["--filter", "@mizuhiki/web", "dev"], "\x1b[33m"],
  // The opt-in Instant delivery helper, once provisioned (pnpm --filter @mizuhiki/delivery-agent provision).
  ...(existsSync(new URL("../services/delivery-agent/.env.local", import.meta.url))
    ? [["helper", "pnpm", ["--filter", "@mizuhiki/delivery-agent", "start"], "\x1b[32m"]]
    : []),
];
const children = procs.map(([name, cmd, args, color]) => {
  const c = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  const out = (d) =>
    d
      .toString()
      .split("\n")
      .filter(Boolean)
      .forEach((l) => console.log(`${color}${name.padEnd(8)}\x1b[0m ${l}`));
  c.stdout.on("data", out);
  c.stderr.on("data", out);
  c.on("exit", (code) => console.log(`${color}${name}\x1b[0m exited with ${code}`));
  return c;
});
const stop = () => {
  children.forEach((c) => c.kill("SIGTERM"));
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
