// Runs the end-to-end suite against a production build of the web app (`next build` + `next start`), the way the
// app ships: production CSP, no dev-only 'unsafe-eval', no React Strict Mode double calls, real chunking. The API,
// indexer and helper must already be running (pnpm dev, with its web server stopped, frees port 3000).
// Usage: node tools/e2e-prod.mjs [playwright args...]
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const web = `${root}apps/web`;
const env = { ...process.env, NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000" };

const busy = (() => {
  try {
    return execSync("lsof -ti:3000", { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();
if (busy) {
  console.error(
    "Port 3000 is in use (the dev web server?). Stop it first; this run serves the production build there.",
  );
  process.exit(1);
}
try {
  execSync("curl -sf http://127.0.0.1:4000/health", { stdio: "ignore" });
} catch {
  console.error("The API is not answering on :4000. Start pnpm dev (then stop its web server) first.");
  process.exit(1);
}

execSync("npx next build", { cwd: web, env, stdio: "inherit" });
const server = spawn("npx", ["next", "start", "--port", "3000"], { cwd: web, env, stdio: "ignore" });
const stop = () => server.kill("SIGTERM");
process.on("SIGINT", () => {
  stop();
  process.exit(130);
});

let up = false;
for (let i = 0; i < 60 && !up; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try {
    execSync("curl -sf -o /dev/null http://localhost:3000/", { stdio: "ignore" });
    up = true;
  } catch {
    // not yet
  }
}
if (!up) {
  stop();
  console.error("The production server did not start on :3000.");
  process.exit(1);
}
const run = spawn("npx", ["playwright", "test", ...process.argv.slice(2)], {
  cwd: `${root}tests/e2e`,
  env,
  stdio: "inherit",
});
run.on("exit", (code) => {
  stop();
  process.exit(code ?? 1);
});
