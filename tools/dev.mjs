// Runs the whole product locally against QoreChain testnet: database migrations,
// then the API, the indexer and the web app, with prefixed output.
import { spawn, execSync } from "node:child_process";

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki",
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000",
};
try {
  execSync("/opt/homebrew/opt/postgresql@17/bin/pg_isready -q", { stdio: "ignore" });
} catch {
  console.error("Postgres is not running. Start it with: brew services start postgresql@17");
  process.exit(1);
}
execSync("pnpm --filter @mizuhiki/db migrate", { stdio: "inherit", env });
const procs = [
  ["api", "pnpm", ["--filter", "@mizuhiki/api", "dev"], "\x1b[35m"],
  ["indexer", "pnpm", ["--filter", "@mizuhiki/indexer", "dev"], "\x1b[36m"],
  ["web", "pnpm", ["--filter", "@mizuhiki/web", "dev"], "\x1b[33m"],
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
