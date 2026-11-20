/**
 * The indexer: a pure function of public chain data (ARCHITECTURE.md 2.6).
 * Stream 1 follows MizuhikiRegistry and CapsuleVault logs into chain_events and
 * the materialised tables. Stream 2 finds payments to page owners by the
 * transfer.recipient event (memos are not searchable), reads the memo from the
 * transaction body, and links it. Both are checkpointed and idempotent.
 */
import { decodeEventLog, type Log } from "viem";
import { and, eq, like, sql } from "drizzle-orm";
import {
  CONTRACTS,
  anchorBookAbi,
  capsuleVaultAbi,
  latestBlock,
  mizuhikiRegistryAbi,
  publicClient,
  searchTxs,
  type TxResponse,
} from "@mizuhiki/chain";
import { parseMemo } from "@mizuhiki/core";
import { addressFromBytes } from "@qorechain/qoresign";
import { capsules, chainEvents, indexCheckpoints, names, pages, payments, type Db } from "@mizuhiki/db";

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
/** CapsuleVault events that change what owners, guardians and recipients see (spec 5.14). */
const CAPSULE_EVENTS = [
  "CapsuleCreated",
  "GuardiansSet",
  "ReleaseRequested",
  "RequestRejected",
  "Released",
  "Cancelled",
  "CheckedIn",
];

/**
 * Tell the open dashboards of everyone a capsule names that its state changed on chain (a guardian's
 * request, the owner's reject or approve, a release, a cancel, a check-in). Only "capsule" is sent; each
 * dashboard reads the new state from QoreChain itself.
 */
async function notifyCapsule(db: Db, idHex: string | null, owner: string | null): Promise<void> {
  const rows = idHex
    ? await db
        .select()
        .from(capsules)
        .where(eq(capsules.id, idHex.replace(/^0x/, "").toLowerCase()))
    : owner
      ? await db.select().from(capsules).where(eq(capsules.owner, owner))
      : [];
  const who = new Set<string>();
  for (const c of rows) {
    who.add(c.owner);
    const plan = c.plan as { body?: { guardians?: string[]; recipients?: { address: string }[] } } | null;
    for (const g of plan?.body?.guardians ?? []) who.add(g);
    for (const r of plan?.body?.recipients ?? []) who.add(r.address);
  }
  if (owner) who.add(owner);
  for (const a of who) await db.execute(sql`select pg_notify('mzk_events', ${`capsule:${a}`})`);
}

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
  } else if (CAPSULE_EVENTS.includes(ev.event)) {
    await notifyCapsule(
      db,
      ev.event === "CheckedIn" ? null : String(a.id),
      ev.event === "CheckedIn" ? toQor(String(a.owner)) : null,
    );
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
  const contracts = [CONTRACTS.registry, CONTRACTS.vault, CONTRACTS.anchorBook];
  const stream = `logs:${contracts.join(":")}`;
  // AnchorBook came later: carry on from where the registry-and-vault stream had reached (it covers every
  // block AnchorBook can have logs in), and from the first deploy on a fresh database.
  const earlier = `logs:${CONTRACTS.registry}:${CONTRACTS.vault}`;
  const saved = (await getCheckpoint(db, stream)) ?? (await getCheckpoint(db, earlier));
  const from = BigInt(saved ?? (CONTRACTS.deployBlock - 1n).toString()) + 1n;
  const head = (await pub.getBlockNumber()) - CONFIRMATIONS;
  let cursor = from;
  let chunks = 0;
  while (cursor <= head && chunks < (opts.maxChunks ?? 20)) {
    const to = cursor + LOG_CHUNK - 1n > head ? head : cursor + LOG_CHUNK - 1n;
    const logs = await pub.getLogs({ address: contracts, fromBlock: cursor, toBlock: to });
    await db.transaction(async (tx) => {
      for (const log of logs) await ingest(tx as unknown as Db, log);
      await setCheckpoint(tx as unknown as Db, stream, to.toString());
    });
    cursor = to + 1n;
    chunks++;
  }
  return cursor - 1n;
}

function abiOf(address: string) {
  const a = address.toLowerCase();
  if (a === CONTRACTS.registry.toLowerCase()) return mizuhikiRegistryAbi;
  if (a === CONTRACTS.anchorBook.toLowerCase()) return anchorBookAbi;
  return capsuleVaultAbi;
}

async function ingest(db: Db, log: Log): Promise<void> {
  let decoded: { eventName: string; args: unknown };
  try {
    decoded = decodeEventLog({ abi: abiOf(log.address), data: log.data, topics: log.topics });
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

/** Record the payments to `owner` in one transaction (the indexer and the API fast path share this). */
export async function storePayments(db: Db, owner: string, t: TxResponse): Promise<number> {
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

/** Native transfers read per page of the chain's tx search (its own maximum). */
const PAY_PAGE = 50;
/** At most this many pages per pass, so a long catch-up never holds the loop for minutes. */
const PAY_PAGES_PER_PASS = 20;

/**
 * Payments to every owner with a published page, in one chain query per page of results: every native
 * MsgSend since the shared checkpoint, kept when it pays one of our owners. The cost follows the chain's
 * transfer volume, not the number of pages (one search per owner took a minute at 86 pages).
 */
export async function indexAllPayments(db: Db, defaultSince: bigint): Promise<number> {
  const stream = "pay:all";
  const saved = await getCheckpoint(db, stream);
  // First run after per-owner scanning: start where the least advanced owner had reached, so nothing is skipped.
  const legacy = saved
    ? undefined
    : (
        await db.execute<{ m: string | null }>(
          sql`select min(position::numeric)::text as m from index_checkpoints where stream like 'pay:qor%'`,
        )
      )[0]?.m;
  const from = BigInt(saved ?? legacy ?? defaultSince.toString());
  const owners = new Set((await db.select({ address: pages.address }).from(pages)).map((o) => o.address));
  const paid = new Set<string>();
  let n = 0;
  // An owner new since the last pass may have been paid before their page existed (onboarding funds the
  // account first): read that owner's history once; their own checkpoint marks it done.
  const known = new Set(
    (
      await db
        .select({ s: indexCheckpoints.stream })
        .from(indexCheckpoints)
        .where(like(indexCheckpoints.stream, "pay:qor%"))
    ).map((r) => r.s.slice(4)),
  );
  for (const owner of owners) {
    if (known.has(owner)) continue;
    const found = await indexPaymentsFor(db, owner, defaultSince);
    if (found > 0) paid.add(owner);
    n += found;
  }
  // Everything up to this height is in the search below once every page has been read.
  const horizon = (await latestBlock()).height;
  let maxHeight = from;
  let complete = false;
  for (let page = 1; page <= PAY_PAGES_PER_PASS; page++) {
    const { txs, total } = await searchTxs(
      `message.action='/cosmos.bank.v1beta1.MsgSend' AND tx.height>=${from.toString()}`,
      { page, limit: PAY_PAGE, orderBy: "ORDER_BY_ASC" },
    );
    for (const t of txs) {
      const msgs = (t.tx?.body?.messages ?? []) as unknown as MsgSendJson[];
      const to = new Set(msgs.map((m) => m.to_address).filter((a): a is string => !!a && owners.has(a)));
      for (const owner of to) {
        const found = await storePayments(db, owner, t);
        if (found > 0) paid.add(owner);
        n += found;
      }
      const h = BigInt(t.height);
      if (h > maxHeight) maxHeight = h;
    }
    if (page * PAY_PAGE >= total || txs.length === 0) {
      complete = true;
      break;
    }
  }
  // A finished scan moves on to the horizon, so quiet stretches are not searched again. The search includes
  // `from` itself, so that height is read again next pass; storing is idempotent.
  const next = complete && horizon > maxHeight ? horizon : maxHeight;
  await setCheckpoint(db, stream, next.toString());
  // Tell those owners' open dashboards; the payload names no payer and no amount.
  for (const owner of paid) await db.execute(sql`select pg_notify('mzk_events', ${`pay:${owner}`})`);
  return n;
}
