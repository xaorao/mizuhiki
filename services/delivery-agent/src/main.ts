/** Runs the delivery helper: one pass every few seconds. Configuration in services/delivery-agent/.env.local. */
import { existsSync } from "node:fs";
import { DeliveryAgent } from "./agent";

const here = new URL("../.env.local", import.meta.url);
if (existsSync(here)) process.loadEnvFile(here);
const phrase = process.env.AGENT_PHRASE;
if (!phrase) {
  console.error("AGENT_PHRASE is not set. Run `pnpm --filter @mizuhiki/delivery-agent provision` first.");
  process.exit(1);
}
const agent = new DeliveryAgent({ api: process.env.API_URL ?? "http://127.0.0.1:4000", phrase });
console.log(`delivery helper ${agent.address} running`);
let stop = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stop = true));
let backoff = 0;
while (!stop) {
  try {
    await agent.pass();
    backoff = 0;
  } catch (e) {
    backoff = Math.min(60_000, backoff ? backoff * 2 : 2_000);
    console.error(`helper pass failed, retrying in ${backoff / 1000}s:`, (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, backoff || 4_000));
}
