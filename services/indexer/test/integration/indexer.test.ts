/** Indexer against the real testnet: registry logs into names, and a real tagged payment into payments. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { makeDb, names, pages, payments, runMigrations, chainEvents } from "@mizuhiki/db";
import { buildMemo, sha256Hex, utf8 } from "@mizuhiki/core";
import { CONTRACTS, DENOMS, msgSend, sendTx } from "@mizuhiki/chain";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import { indexLogs, indexPaymentsFor } from "../../src/indexer";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
const { db, sql } = makeDb(DB);
let owner: ReadyPersona;
let payer: ReadyPersona;

beforeAll(async () => {
  await runMigrations(DB);
  await sql`truncate chain_events, names, payments, index_checkpoints, pages`;
  owner = await ensurePersona("api-owner", { name: "mzk-api-owner" });
  payer = await ensurePersona("payer", { minQor: 3n });
}, 300_000);
afterAll(async () => sql.end());

describe("indexer", () => {
  it("rebuilds names from registry logs, idempotently", async () => {
    await indexLogs(db, { maxChunks: 200 });
    const [row] = await db.select().from(names).where(eq(names.name, "mzk-api-owner"));
    expect(row?.address).toBe(owner.address);
    const count1 = (await db.select().from(chainEvents)).length;
    await sql`delete from index_checkpoints`;
    await indexLogs(db, { maxChunks: 200 });
    expect((await db.select().from(chainEvents)).length).toBe(count1);
  }, 300_000);

  it("links a real tagged payment by the recipient event and the memo", async () => {
    await db.insert(pages).values({ address: owner.address, name: "mzk-api-owner", record: {}, version: 1 });
    const note = sha256Hex(utf8(`note-${Date.now()}`));
    const ref = `t${Date.now().toString(36)}`;
    const sent = await sendTx(
      payer,
      [msgSend(payer.address, owner.address, DENOMS.QOR.denom, 1234n)],
      buildMemo("pay", ref, note),
    );
    const n = await indexPaymentsFor(db, owner.address, sent.height - 1n);
    expect(n).toBeGreaterThanOrEqual(1);
    const [p] = await db.select().from(payments).where(eq(payments.txHash, sent.txHash));
    expect(p).toMatchObject({
      fromAddr: payer.address,
      toAddr: owner.address,
      denom: "uqor",
      amount: "1234",
      kind: "pay",
      ref,
      noteHash: note,
    });
    expect(await indexPaymentsFor(db, owner.address, sent.height - 1n)).toBe(0);
  }, 300_000);

  it("knows where the contracts were deployed", () => {
    expect(CONTRACTS.deployBlock).toBeGreaterThan(10_000_000n);
  });
});
