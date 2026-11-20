import { makeDb, runMigrations } from "@mizuhiki/db";
import { CONTRACTS } from "@mizuhiki/chain";
import { indexAllPayments, indexLogs } from "./indexer";

const url = process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki";
await runMigrations(url);
const { db, sql } = makeDb(url);
/** Pages exist only after our contracts were deployed, so no payment to an owner can be older. */
const since = CONTRACTS.deployBlock;
let stop = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => (stop = true));
/**
 * Contract events and payments follow the chain in two independent loops: a slow payment scan never holds back
 * a name, anchor or capsule change, and a failure in one does not stop the other.
 */
async function follow(label: string, pass: () => Promise<string | null>): Promise<void> {
  let backoff = 0;
  while (!stop) {
    try {
      const said = await pass();
      if (said) console.log(said);
      backoff = 0;
    } catch (e) {
      backoff = Math.min(60_000, backoff ? backoff * 2 : 2_000);
      console.error(`indexer ${label} pass failed, retrying in ${backoff / 1000}s:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, backoff || 3_000));
  }
}
await Promise.all([
  follow("logs", async () => {
    await indexLogs(db);
    return null;
  }),
  follow("payments", async () => {
    const n = await indexAllPayments(db, since);
    return n > 0 ? `indexed ${n} payment(s)` : null;
  }),
]);
await sql.end();
