/**
 * Proof that a document existed (spec 5.15): its SHA-256 is anchored on QoreChain with the owner's ML-DSA
 * authorisation. New anchors go to AnchorBook, which keeps one record per account per fingerprint, so nobody
 * who learns a fingerprint can anchor it first and block its author (security review M2). Anchors made in
 * MizuhikiRegistry before AnchorBook existed stay valid and are read alongside. Everything a certificate shows
 * is read from chain here: the records and the transactions that wrote them.
 */
import { hexToString, type Address, type Hex } from "viem";
import { parseAddress } from "@qorechain/qoresign";
import { anchorBookAbi, mizuhikiRegistryAbi } from "./abi";
import { CONTRACTS } from "./deployment";
import { Action, bytes32Text, publicClient, signAction, writeContract } from "./evm";
import { ensureWindow, type Owner } from "./registry";
import { ChainError } from "./errors";

const reg = { address: CONTRACTS.registry, abi: mizuhikiRegistryAbi } as const;
const book = { address: CONTRACTS.anchorBook, abi: anchorBookAbi } as const;
const PAGE = 50n;

export const ANCHOR_KINDS = ["file", "invoice", "document"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export interface AnchorRecord {
  contentHash: Hex;
  /** EVM form of the anchoring account. */
  by: Address;
  /** Bech32 form of the same account. */
  byAddress: string;
  at: Date;
  blockNumber: bigint;
  kind: string;
  /** Which contract holds it: AnchorBook, or the registry for anchors made before AnchorBook. */
  contract: "book" | "registry";
}

export const toContentHash = (sha256Hex: string): Hex => {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex))
    throw new ChainError("REFUSED", "That is not a SHA-256 hash. Nothing was sent.");
  return `0x${sha256Hex}`;
};

function bech32Of(evm: Address): string {
  return parseAddress(evm).bech32;
}

export function evmOf(address: string): Address {
  return parseAddress(address).hex as Address;
}

const kindText = (kind: Hex): string => hexToString(kind, { size: 32 }).replace(/\0+$/, "");

function record(
  contentHash: Hex,
  by: Address,
  at: bigint,
  blockNumber: bigint,
  kind: Hex,
  contract: AnchorRecord["contract"],
): AnchorRecord {
  return {
    contentHash,
    by,
    byAddress: bech32Of(by),
    at: new Date(Number(at) * 1000),
    blockNumber,
    kind: kindText(kind),
    contract,
  };
}

async function legacyAnchor(contentHash: Hex): Promise<AnchorRecord | null> {
  const [by, at, blockNumber, kind] = await publicClient().readContract({
    ...reg,
    functionName: "anchorOf",
    args: [contentHash],
  });
  return at === 0n ? null : record(contentHash, by, at, blockNumber, kind, "registry");
}

/** Every anchor of this fingerprint, earliest first (both contracts). Empty if nobody anchored it. */
export async function readAnchors(sha256Hex: string): Promise<AnchorRecord[]> {
  const contentHash = toContentHash(sha256Hex);
  const pub = publicClient();
  const [legacy, count] = await Promise.all([
    legacyAnchor(contentHash),
    pub.readContract({ ...book, functionName: "anchorCount", args: [contentHash] }),
  ]);
  const out: AnchorRecord[] = legacy ? [legacy] : [];
  for (let offset = 0n; offset < count; offset += PAGE) {
    const [by, at, blockNumber, kind] = await pub.readContract({
      ...book,
      functionName: "anchorsOf",
      args: [contentHash, offset, PAGE],
    });
    by.forEach((a, i) => {
      const [t, b, k] = [at[i], blockNumber[i], kind[i]];
      if (t !== undefined && b !== undefined && k !== undefined) out.push(record(contentHash, a, t, b, k, "book"));
    });
  }
  return out.sort((x, y) => (x.blockNumber === y.blockNumber ? 0 : x.blockNumber < y.blockNumber ? -1 : 1));
}

/** The earliest anchor of this fingerprint, or null if nobody anchored it. */
export async function readAnchor(sha256Hex: string): Promise<AnchorRecord | null> {
  return (await readAnchors(sha256Hex))[0] ?? null;
}

/** This account's own anchor of a fingerprint, in either contract, or null. */
export async function readAnchorBy(sha256Hex: string, account: Address): Promise<AnchorRecord | null> {
  const contentHash = toContentHash(sha256Hex);
  const [at, blockNumber, kind] = await publicClient().readContract({
    ...book,
    functionName: "anchorOf",
    args: [contentHash, account],
  });
  if (at !== 0n) return record(contentHash, account, at, blockNumber, kind, "book");
  const legacy = await legacyAnchor(contentHash);
  return legacy && legacy.by.toLowerCase() === account.toLowerCase() ? legacy : null;
}

/** The transaction that wrote an anchor: its Anchored log, in the anchor's own block and contract. */
export async function anchorTx(a: AnchorRecord): Promise<Hex | null> {
  const where = { args: { contentHash: a.contentHash, by: a.by }, fromBlock: a.blockNumber, toBlock: a.blockNumber };
  const logs =
    a.contract === "book"
      ? await publicClient().getContractEvents({ ...book, eventName: "Anchored", ...where })
      : await publicClient().getContractEvents({ ...reg, eventName: "Anchored", ...where });
  return logs[0]?.transactionHash ?? null;
}

/**
 * Anchor a document hash for this owner. If this owner anchored it already, nothing is sent and that record
 * comes back (`fresh: false`). Someone else's earlier anchor never stops it.
 */
export async function anchorDocument(
  owner: Owner,
  sha256Hex: string,
  kind: AnchorKind,
  onStep?: (step: "window" | "sign" | "send") => void,
): Promise<{ record: AnchorRecord; txHash: Hex | null; fresh: boolean }> {
  const existing = await readAnchorBy(sha256Hex, owner.evm);
  if (existing) return { record: existing, txHash: await anchorTx(existing), fresh: false };
  const contentHash = toContentHash(sha256Hex);
  const k = bytes32Text(kind);
  onStep?.("window");
  await ensureWindow(owner, 1);
  onStep?.("sign");
  const sig = await signAction(owner, CONTRACTS.anchorBook, anchorBookAbi, Action.anchor(contentHash, k));
  onStep?.("send");
  const { txHash } = await writeContract(owner, {
    ...book,
    functionName: "anchor",
    args: [owner.evm, contentHash, k, sig],
  });
  const written = await readAnchorBy(sha256Hex, owner.evm);
  if (!written)
    throw new ChainError("FAILED_IN_BLOCK", "The anchor transaction went through but no anchor was recorded.", {
      moved: "yes",
      txHash,
    });
  return { record: written, txHash, fresh: true };
}
