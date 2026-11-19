/**
 * Proof that a document existed (spec 5.15): its SHA-256 is anchored in
 * MizuhikiRegistry with the owner's ML-DSA authorisation. Everything a
 * certificate shows is read from chain here: the anchor record (`anchorOf`)
 * and the transaction that wrote it (the `Anchored` log in that one block).
 */
import { hexToString, type Address, type Hex } from "viem";
import { parseAddress } from "@qorechain/qoresign";
import { mizuhikiRegistryAbi } from "./abi";
import { CONTRACTS } from "./deployment";
import { Action, bytes32Text, publicClient, signAction, writeContract } from "./evm";
import { ensureWindow, type Owner } from "./registry";
import { ChainError } from "./errors";

const reg = { address: CONTRACTS.registry, abi: mizuhikiRegistryAbi } as const;

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

/** The anchor for a hash, or null if nobody anchored it. */
export async function readAnchor(sha256Hex: string): Promise<AnchorRecord | null> {
  const contentHash = toContentHash(sha256Hex);
  const [by, at, blockNumber, kind] = await publicClient().readContract({
    ...reg,
    functionName: "anchorOf",
    args: [contentHash],
  });
  if (at === 0n) return null;
  return {
    contentHash,
    by,
    byAddress: bech32Of(by),
    at: new Date(Number(at) * 1000),
    blockNumber,
    kind: hexToString(kind, { size: 32 }).replace(/\0+$/, ""),
  };
}

/** The transaction that wrote an anchor: the Anchored log for this hash in the anchor's block. */
export async function anchorTx(a: AnchorRecord): Promise<Hex | null> {
  const logs = await publicClient().getContractEvents({
    ...reg,
    eventName: "Anchored",
    args: { contentHash: a.contentHash },
    fromBlock: a.blockNumber,
    toBlock: a.blockNumber,
  });
  return logs[0]?.transactionHash ?? null;
}

/**
 * Anchor a document hash for this owner. If it is already anchored, nothing is
 * sent and the existing record comes back (`fresh: false`).
 */
export async function anchorDocument(
  owner: Owner,
  sha256Hex: string,
  kind: AnchorKind,
  onStep?: (step: "window" | "sign" | "send") => void,
): Promise<{ record: AnchorRecord; txHash: Hex | null; fresh: boolean }> {
  const existing = await readAnchor(sha256Hex);
  if (existing) return { record: existing, txHash: await anchorTx(existing), fresh: false };
  const contentHash = toContentHash(sha256Hex);
  const k = bytes32Text(kind);
  onStep?.("window");
  await ensureWindow(owner, 1);
  onStep?.("sign");
  const sig = await signAction(owner, CONTRACTS.registry, mizuhikiRegistryAbi, Action.anchor(contentHash, k));
  onStep?.("send");
  const { txHash } = await writeContract(owner, {
    ...reg,
    functionName: "anchor",
    args: [owner.evm, contentHash, k, sig],
  });
  const record = await readAnchor(sha256Hex);
  if (!record)
    throw new ChainError("FAILED_IN_BLOCK", "The anchor transaction went through but no anchor was recorded.", {
      moved: "yes",
      txHash,
    });
  return { record, txHash, fresh: true };
}
