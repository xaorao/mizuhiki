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
let backoff = 0;
while (!stop) {
  try {
    const pos = await indexLogs(db);
    const n = await indexAllPayments(db, since);
    if (n > 0) console.log(`indexed ${n} payment(s); logs at ${pos.toString()}`);
    backoff = 0;
  } catch (e) {
    backoff = Math.min(60_000, backoff ? backoff * 2 : 2_000);
    console.error(`indexer pass failed, retrying in ${backoff / 1000}s:`, (e as Error).message);
  }
  await new Promise((r) => setTimeout(r, backoff || 3_000));
}
await sql.end();
