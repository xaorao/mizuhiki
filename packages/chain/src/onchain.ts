/**
 * What the proof page shows, read from QoreChain by whoever runs it: our contracts' code and deploy
 * transactions, a transaction's ML-DSA-87 layer checked against the signer's registered key, and the most
 * recent activity on our contracts. Nothing here comes from our own database.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeEventLog, type Address, type Hex, type Log } from "viem";
import { anchorBookAbi, capsuleVaultAbi, mizuhikiRegistryAbi } from "./abi";
import { chainRest, NETWORK } from "./config";
import { CONTRACTS } from "./deployment";
import { publicClient } from "./evm";
import { pqKeyViaEvm } from "./recipients";
import { ownerOfName } from "./registry";
import { timedFetch, type Fetch } from "./rest";

// ---- contracts ------------------------------------------------------------------------------------

export type ContractKey = "registry" | "vault" | "anchorBook";

export interface ContractFacts {
  key: ContractKey;
  address: Address;
  /** Bytes of runtime code at the address now (0 would mean nothing is deployed there). */
  codeBytes: number;
  deployTx: Hex;
  /** Block the deploy transaction was committed in, and whether it succeeded, from its receipt. */
  deployBlock: bigint;
  deployOk: boolean;
}

const DEPLOYS: { key: ContractKey; address: Address; tx: Hex }[] = [
  { key: "registry", address: CONTRACTS.registry, tx: CONTRACTS.registryTx },
  { key: "vault", address: CONTRACTS.vault, tx: CONTRACTS.vaultTx },
  { key: "anchorBook", address: CONTRACTS.anchorBook, tx: CONTRACTS.anchorBookTx },
];

export async function contractFacts(): Promise<ContractFacts[]> {
  const pub = publicClient();
  return Promise.all(
    DEPLOYS.map(async (d) => {
      const [code, receipt] = await Promise.all([
        pub.getCode({ address: d.address }),
        pub.getTransactionReceipt({ hash: d.tx }),
      ]);
      return {
        key: d.key,
        address: d.address,
        codeBytes: code ? (code.length - 2) / 2 : 0,
        deployTx: d.tx,
        deployBlock: receipt.blockNumber,
        // The receipt must also name the contract it created at this address.
        deployOk: receipt.status === "success" && receipt.contractAddress?.toLowerCase() === d.address.toLowerCase(),
      };
    }),
  );
}

// ---- one native-lane transaction ------------------------------------------------------------------

export interface TxCheck {
  hash: string;
  height: bigint;
  /** True when the transaction succeeded (code 0). */
  ok: boolean;
  /** Message type URLs, as committed. */
  messages: string[];
  /** "pqc" (hybrid, ML-DSA-87 layer), "enrollment" (registers the key itself), "classical" (EVM lane). */
  tier: string;
  layer: { present: boolean; verified?: boolean; signBytesVersion?: string; reason?: string };
}

/**
 * Read a committed transaction and check its ML-DSA-87 layer against the key its signer has registered on
 * chain, here. The exact committed bytes come from the RPC node through `rpcBase` and are hashed to the id
 * asked for before anything is trusted: QoreSign's `inspectTransaction` does not tie the bytes it is given to
 * the hash, so a relay could otherwise answer with a different transaction by the same signer.
 */
export async function checkTx(hash: string, o: { rest?: string; rpcBase: string }): Promise<TxCheck | undefined> {
  const want = hash.replace(/^0x/, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(want)) throw new Error("That is not a transaction id.");
  const SWAPPED = "The relay answered with a different transaction than the one asked for.";
  const relay = { swapped: false };
  const fetchChecked: Fetch = async (url, init) => {
    const res = await timedFetch(url, init);
    const where = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (!where.includes("/tx?hash=")) return res;
    const body = (await res.clone().json()) as { result?: { tx?: unknown } };
    const tx = body.result?.tx;
    if (typeof tx === "string") {
      const bytes = Uint8Array.from(atob(tx), (c) => c.charCodeAt(0));
      if (bytesToHex(sha256(bytes)).toUpperCase() !== want) {
        relay.swapped = true;
        throw new Error(SWAPPED);
      }
    }
    return res;
  };
  const { inspectTransaction } = await import("@qorechain/qoresign/network");
  let t: Awaited<ReturnType<typeof inspectTransaction>>;
  try {
    t = await inspectTransaction({
      rest: o.rest ?? chainRest(),
      rpc: o.rpcBase,
      txhash: want,
      chainId: NETWORK.chainId,
      fetch: fetchChecked,
    });
  } catch (e) {
    // QoreSign reports a failed fetch as its own generic error; keep the real reason.
    if (relay.swapped) throw new Error(SWAPPED, { cause: e });
    throw e;
  }
  if (!t) return undefined;
  return {
    hash: want,
    height: t.height,
    ok: t.code === 0,
    messages: t.messages.map((m) => m.typeUrl),
    tier: t.tier,
    layer: {
      present: t.pqLayer.present,
      ...(t.pqLayer.verified !== undefined ? { verified: t.pqLayer.verified } : {}),
      ...(t.pqLayer.signBytesVersion ? { signBytesVersion: t.pqLayer.signBytesVersion } : {}),
      ...(t.pqLayer.reason ? { reason: t.pqLayer.reason } : {}),
    },
  };
}

// ---- recent activity on our contracts -------------------------------------------------------------

export type ActivityKind = "name" | "anchor" | "room" | "publish" | "capsule" | "checkin";

export interface Activity {
  kind: ActivityKind;
  event: string;
  contract: ContractKey;
  block: bigint;
  txHash: Hex;
  /** Only public fields: a claimed name, the account, a fingerprint or id, never content. */
  name?: string;
  account?: Address;
  ref?: Hex;
}

const KIND: Record<string, ActivityKind> = {
  NameClaimed: "name",
  NameReleased: "name",
  Anchored: "anchor",
  RoomCreated: "room",
  RoomEpoch: "room",
  RoomClosed: "room",
  Published: "publish",
  CapsuleCreated: "capsule",
  GuardiansSet: "capsule",
  ReleaseRequested: "capsule",
  Released: "capsule",
  Cancelled: "capsule",
  CheckedIn: "checkin",
};
const KINDS = [...new Set(Object.values(KIND))];
const CHUNK = 5_000n;

function decode(log: Log): Activity | undefined {
  const a = log.address.toLowerCase();
  const contract: ContractKey =
    a === CONTRACTS.registry.toLowerCase() ? "registry" : a === CONTRACTS.vault.toLowerCase() ? "vault" : "anchorBook";
  const abi = contract === "registry" ? mizuhikiRegistryAbi : contract === "vault" ? capsuleVaultAbi : anchorBookAbi;
  let d: { eventName: string; args: unknown };
  try {
    d = decodeEventLog({ abi, data: log.data, topics: log.topics });
  } catch {
    return undefined;
  }
  const kind = KIND[d.eventName];
  if (!kind || log.transactionHash === null || log.blockNumber === null) return undefined;
  const args = d.args as Record<string, unknown>;
  const account = (args.owner ?? args.by ?? args.guardian) as Address | undefined;
  const ref = (args.contentHash ?? args.roomId ?? args.id) as Hex | undefined;
  return {
    kind,
    event: d.eventName,
    contract,
    block: log.blockNumber,
    txHash: log.transactionHash,
    ...(typeof args.name === "string" ? { name: args.name } : {}),
    ...(account ? { account } : {}),
    ...(ref ? { ref } : {}),
  };
}

/**
 * The latest `perKind` events of each kind, newest first, scanning back from the chain head in chunks of
 * 5,000 blocks until every kind is filled, the deploy block is reached, or `maxChunks` chunks were read.
 */
export async function recentActivity(o: { perKind?: number; maxChunks?: number } = {}): Promise<{
  items: Activity[];
  head: bigint;
  scannedFrom: bigint;
}> {
  const per = o.perKind ?? 4;
  const pub = publicClient();
  const head = await pub.getBlockNumber();
  const floor = CONTRACTS.deployBlock;
  const found = new Map<ActivityKind, Activity[]>(KINDS.map((k) => [k, []]));
  let to = head;
  let chunks = 0;
  while (to >= floor && chunks < (o.maxChunks ?? 12) && KINDS.some((k) => (found.get(k)?.length ?? 0) < per)) {
    const from = to - CHUNK + 1n > floor ? to - CHUNK + 1n : floor;
    const logs = await pub.getLogs({
      address: [CONTRACTS.registry, CONTRACTS.vault, CONTRACTS.anchorBook],
      fromBlock: from,
      toBlock: to,
    });
    for (const log of [...logs].reverse()) {
      const a = decode(log);
      const list = a ? found.get(a.kind) : undefined;
      if (a && list && list.length < per) list.push(a);
    }
    to = from - 1n;
    chunks++;
  }
  const items = [...found.values()].flat().sort((x, y) => (x.block === y.block ? 0 : x.block > y.block ? -1 : 1));
  return { items, head, scannedFrom: to + 1n };
}

// ---- an account's keys ----------------------------------------------------------------------------

export interface AccountKeysOnChain {
  /** The account a name points to, read from MizuhikiRegistry (null when nobody holds it). */
  owner: string | null;
  signing: { registered: boolean; possessionProven: boolean; bytes: number; fingerprint: string | null };
  sealing: {
    registered: boolean;
    algorithm: string | null;
    bytes: number;
    fingerprint: string | null;
    height: bigint | null;
  };
}

const fingerprint = (key: Uint8Array): string => bytesToHex(sha256(key)).slice(0, 16).toUpperCase();

/**
 * Who holds `name`, and that account's ML-DSA-87 signing key (from QoreChain's key-status precompile, with its
 * proof of possession) and ML-KEM sealing key (from the chain's PQC module), as fingerprints.
 */
export async function nameKeys(name: string): Promise<AccountKeysOnChain> {
  const owner = await ownerOfName(name);
  if (!owner)
    return {
      owner: null,
      signing: { registered: false, possessionProven: false, bytes: 0, fingerprint: null },
      sealing: { registered: false, algorithm: null, bytes: 0, fingerprint: null, height: null },
    };
  const { fetchKemKey } = await import("@qorechain/qoreseal/network");
  const [pq, kem] = await Promise.all([
    pqKeyViaEvm(owner),
    fetchKemKey({ rest: chainRest(), fetch: timedFetch, address: owner }),
  ]);
  return {
    owner,
    signing: {
      registered: pq.registered,
      possessionProven: pq.possessionProven,
      bytes: pq.publicKey?.length ?? 0,
      fingerprint: pq.publicKey ? fingerprint(pq.publicKey) : null,
    },
    sealing: {
      registered: kem.registered,
      algorithm: kem.algorithmName ?? null,
      bytes: kem.publicKey?.length ?? 0,
      fingerprint: kem.publicKey ? fingerprint(kem.publicKey) : null,
      height: kem.registeredHeight ?? null,
    },
  };
}

/** How an EVM transaction ended, read from its receipt: used to show refused calls (reverted) as they happened. */
export async function evmOutcome(
  hash: `0x${string}`,
): Promise<{ status: "success" | "reverted"; block: bigint; from: string; to: string | null }> {
  const r = await publicClient().getTransactionReceipt({ hash });
  return { status: r.status, block: r.blockNumber, from: r.from, to: r.to };
}
