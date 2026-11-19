/**
 * The indexer: a pure function of public chain data (ARCHITECTURE.md 2.6).
 * Stream 1 follows MizuhikiRegistry and CapsuleVault logs into chain_events and
 * the materialised tables. Stream 2 finds payments to page owners by the
 * transfer.recipient event (memos are not searchable), reads the memo from the
 * transaction body, and links it. Both are checkpointed and idempotent.
 */
import { decodeEventLog, type Log } from "viem";
import { and, eq, sql } from "drizzle-orm";
import {
  CONTRACTS,
  capsuleVaultAbi,
  mizuhikiRegistryAbi,
  publicClient,
  searchTxs,
  type TxResponse,
} from "@mizuhiki/chain";
import { parseMemo } from "@mizuhiki/core";
import { addressFromBytes } from "@qorechain/qoresign";
import { chainEvents, indexCheckpoints, names, pages, payments, type Db } from "@mizuhiki/db";

export const LOG_CHUNK = 5_000n;
const CONFIRMATIONS = 1n;

async function getCheckpoint(db: Db, stream: string): Promise<string | undefined> {
  const [row] = await db.select().from(indexCheckpoints).where(eq(indexCheckpoints.stream, stream));
  return row?.position;
}
async function setCheckpoint(db: Db, stream: string, position: string): Promise<void> {
  await db
    .insert(indexCheckpoints)
    .values({ stream, position })
    .onConflictDoUpdate({ target: indexCheckpoints.stream, set: { position, updatedAt: new Date() } });
}

const toQor = (hex: string): string => addressFromBytes(Uint8Array.from(Buffer.from(hex.slice(2), "hex"))).bech32;
const jsonSafe = (v: unknown): unknown =>
  JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x)));

/** Apply one decoded event to the materialised tables. */
async function materialise(
  db: Db,
  ev: { event: string; args: Record<string, unknown>; txHash: string; block: bigint },
): Promise<void> {
  const a = ev.args;
  if (ev.event === "NameClaimed") {
    const owner = String(a.owner);
    await db
      .insert(names)
      .values({
        name: String(a.name),
        nameHash: String(a.nameHash),
        address: toQor(owner),
        evm: owner,
        primary: Boolean(a.primary),
        claimedTx: ev.txHash,
        claimedBlock: ev.block,
      })
      .onConflictDoUpdate({
        target: names.name,
        set: {
          address: toQor(owner),
          evm: owner,
          primary: Boolean(a.primary),
          claimedTx: ev.txHash,
          claimedBlock: ev.block,
        },
      });
  } else if (ev.event === "NameReleased") {
    await db.delete(names).where(eq(names.name, String(a.name)));
  } else if (ev.event === "PrimaryNameSet") {
    const owner = toQor(String(a.owner));
    await db.update(names).set({ primary: false }).where(eq(names.address, owner));
    await db
      .update(names)
      .set({ primary: true })
      .where(and(eq(names.address, owner), eq(names.nameHash, String(a.nameHash))));
  }
}

/** Follow our contracts' logs up to the latest confirmed block. Returns the new position. */
export async function indexLogs(db: Db, opts: { maxChunks?: number } = {}): Promise<bigint> {
  const pub = publicClient();
  const stream = `logs:${CONTRACTS.registry}:${CONTRACTS.vault}`;
  const from = BigInt((await getCheckpoint(db, stream)) ?? (CONTRACTS.deployBlock - 1n).toString()) + 1n;
  const head = (await pub.getBlockNumber()) - CONFIRMATIONS;
  let cursor = from;
  let chunks = 0;
  while (cursor <= head && chunks < (opts.maxChunks ?? 20)) {
    const to = cursor + LOG_CHUNK - 1n > head ? head : cursor + LOG_CHUNK - 1n;
    const logs = await pub.getLogs({ address: [CONTRACTS.registry, CONTRACTS.vault], fromBlock: cursor, toBlock: to });
    await db.transaction(async (tx) => {
      for (const log of logs) await ingest(tx as unknown as Db, log);
      await setCheckpoint(tx as unknown as Db, stream, to.toString());
    });
    cursor = to + 1n;
    chunks++;
  }
  return cursor - 1n;
}

async function ingest(db: Db, log: Log): Promise<void> {
  const isRegistry = log.address.toLowerCase() === CONTRACTS.registry.toLowerCase();
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({
      abi: isRegistry ? mizuhikiRegistryAbi : capsuleVaultAbi,
      data: log.data,
      topics: log.topics,
    });
  } catch {
    return; // not one of our events
  }
  if (log.transactionHash === null || log.logIndex === null || log.blockNumber === null) return;
  const args = jsonSafe(decoded.args) as Record<string, unknown>;
  const inserted = await db
    .insert(chainEvents)
    .values({
      contract: log.address,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      block: log.blockNumber,
      event: decoded.eventName,
      args,
    })
    .onConflictDoNothing()
    .returning({ tx: chainEvents.txHash });
  if (inserted.length > 0)
    await materialise(db, { event: decoded.eventName, args, txHash: log.transactionHash, block: log.blockNumber });
}

interface MsgSendJson {
  "@type": string;
  from_address?: string;
  to_address?: string;
  amount?: { denom: string; amount: string }[];
}

/** Payments to one owner since its checkpoint height. */
export async function indexPaymentsFor(db: Db, owner: string, sinceHeight: bigint): Promise<number> {
  const stream = `pay:${owner}`;
  const from = BigInt((await getCheckpoint(db, stream)) ?? sinceHeight.toString());
  let page = 1;
  let maxHeight = from;
  let n = 0;
  for (;;) {
    const { txs, total } = await searchTxs(`transfer.recipient='${owner}' AND tx.height>=${from.toString()}`, {
      page,
      limit: 50,
      orderBy: "ORDER_BY_ASC",
    });
    for (const t of txs) {
      n += await storePayments(db, owner, t);
      const h = BigInt(t.height);
      if (h > maxHeight) maxHeight = h;
    }
    if (page * 50 >= total || txs.length === 0) break;
    page++;
  }
  await setCheckpoint(db, stream, maxHeight.toString());
  return n;
}

async function storePayments(db: Db, owner: string, t: TxResponse): Promise<number> {
  if (t.code !== 0) return 0;
  const memo = t.tx?.body?.memo ?? "";
  const parsed = parseMemo(memo);
  const msgs = (t.tx?.body?.messages ?? []) as unknown as MsgSendJson[];
  let n = 0;
  for (const [i, m] of msgs.entries()) {
    if (m["@type"] !== "/cosmos.bank.v1beta1.MsgSend" || m.to_address !== owner || !m.from_address) continue;
    for (const coin of m.amount ?? []) {
      const r = await db
        .insert(payments)
        .values({
          txHash: t.txhash,
          msgIndex: i * 16 + (m.amount?.indexOf(coin) ?? 0),
          fromAddr: m.from_address,
          toAddr: owner,
          denom: coin.denom,
          amount: coin.amount,
          memo,
          kind: parsed?.kind ?? null,
          ref: parsed?.ref ?? null,
          noteHash: parsed?.noteHash ?? null,
          height: BigInt(t.height),
          time: new Date(t.timestamp),
        })
        .onConflictDoNothing()
        .returning({ tx: payments.txHash });
      n += r.length;
    }
  }
  return n;
}

/** One pass over every owner with a published page. */
export async function indexAllPayments(db: Db, defaultSince: bigint): Promise<number> {
  const owners = await db.select({ address: pages.address }).from(pages);
  let n = 0;
  for (const o of owners) {
    const found = await indexPaymentsFor(db, o.address, defaultSince);
    // Tell that owner's open dashboards; the payload names no payer and no amount.
    if (found > 0) await db.execute(sql`select pg_notify('mzk_events', ${`pay:${o.address}`})`);
    n += found;
  }
  return n;
}
