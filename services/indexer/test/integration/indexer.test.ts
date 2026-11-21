/** Indexer against the real testnet: registry logs into names, and a real tagged payment into payments. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, lte } from "drizzle-orm";
import { makeDb, names, pages, payments, runMigrations, chainEvents } from "@mizuhiki/db";
import { buildMemo, sha256Hex, utf8 } from "@mizuhiki/core";
import { CONTRACTS, DENOMS, msgSend, sendTx } from "@mizuhiki/chain";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import { indexAllPayments, indexLogs, indexPaymentsFor } from "../../src/indexer";

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
    const reached = await indexLogs(db, { maxChunks: 200 });
    const [row] = await db.select().from(names).where(eq(names.name, "mzk-api-owner"));
    expect(row?.address).toBe(owner.address);
    // Count only up to where the first pass reached: other suites may add events to the chain meanwhile.
    const upTo = async () => (await db.select().from(chainEvents).where(lte(chainEvents.block, reached))).length;
    const count1 = await upTo();
    await sql`delete from index_checkpoints`;
    await indexLogs(db, { maxChunks: 200 });
    expect(await upTo()).toBe(count1);
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

  it("one scan for all owners stores a real payment to a page owner, once, and only to owners", async () => {
    const note = sha256Hex(utf8(`all-${Date.now()}`));
    const ref = `a${Date.now().toString(36)}`;
    const sent = await sendTx(
      payer,
      [msgSend(payer.address, owner.address, DENOMS.QOR.denom, 777n)],
      buildMemo("pay", ref, note),
    );
    await sql`delete from index_checkpoints where stream = 'pay:all' or stream like 'pay:qor%'`;
    await sql`delete from payments where tx_hash = ${sent.txHash}`;
    const n = await indexAllPayments(db, sent.height - 1n);
    expect(n).toBeGreaterThanOrEqual(1);
    const rows = await db.select().from(payments).where(eq(payments.txHash, sent.txHash));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toAddr: owner.address, amount: "777", ref, noteHash: note });
    // Every stored payment goes to an owner with a page.
    const strays =
      await sql`select count(*)::int as n from payments p where not exists (select 1 from pages g where g.address = p.to_addr)`;
    expect(strays[0]?.n).toBe(0);
    // The next pass reads from the checkpoint and stores nothing twice.
    await indexAllPayments(db, sent.height - 1n);
    expect(await db.select().from(payments).where(eq(payments.txHash, sent.txHash))).toHaveLength(1);
  }, 300_000);

  it("money that arrived before the page existed is found once the page appears", async () => {
    const before = await sendTx(
      payer,
      [msgSend(payer.address, owner.address, DENOMS.QOR.denom, 555n)],
      "mzk:test-fund:indexer",
    );
    await sql`delete from payments where tx_hash = ${before.txHash}`;
    await sql`delete from pages where address = ${owner.address}`;
    // A pass with no page: the payment is not an owner's, and the shared scan moves past it.
    await sql`delete from index_checkpoints where stream like 'pay:%'`;
    await indexAllPayments(db, before.height - 1n);
    expect(await db.select().from(payments).where(eq(payments.txHash, before.txHash))).toHaveLength(0);
    // The page is published later: the next pass reads that owner's history once.
    await db.insert(pages).values({ address: owner.address, name: "mzk-api-owner", record: {}, version: 1 });
    await indexAllPayments(db, before.height - 1n);
    const rows = await db.select().from(payments).where(eq(payments.txHash, before.txHash));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toAddr: owner.address, amount: "555" });
  }, 300_000);

  it("knows where the contracts were deployed", () => {
    expect(CONTRACTS.deployBlock).toBeGreaterThan(10_000_000n);
  });
});
