/**
 * Resolve a page owner as a sealing recipient, from the visitor's browser,
 * without trusting Mizuhiki's server for the part that matters:
 *  - the owner's ML-DSA-87 key is read straight from QoreChain's EVM
 *    precompile (pqcKeyStatus, the EVM endpoint allows browsers);
 *  - the card's signature is checked against that key;
 *  - the ML-KEM-1024 key (relayed REST read) must hash to the value inside the
 *    signed card, so a relay that swaps it is caught.
 */
import { parseAddress } from "@qorechain/qoresign";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { verifyRecipientCard, type RecipientCard, type SealRecipient } from "@qorechain/qoreseal";
import { NETWORK, chainRest } from "./config";
import { ChainError } from "./errors";
import { hexToBytes } from "viem";
import { publicClient } from "./evm";
import { timedFetch } from "./rest";

const KEY_STATUS = "0x0000000000000000000000000000000000000a02" as const;
const keyStatusAbi = [
  {
    type: "function",
    name: "pqcKeyStatus",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }],
  },
] as const;

/** The ML-DSA-87 key registered for an account, read through the EVM precompile. */
export async function pqKeyViaEvm(
  address: string,
): Promise<{ registered: boolean; publicKey?: Uint8Array; possessionProven: boolean }> {
  const evm = parseAddress(address).hex as `0x${string}`;
  const [registered, alg, key, proven] = await publicClient().readContract({
    address: KEY_STATUS,
    abi: keyStatusAbi,
    functionName: "pqcKeyStatus",
    args: [evm],
  });
  if (!registered || alg !== 1 || key === "0x") return { registered: false, possessionProven: false };
  return { registered: true, publicKey: hexToBytes(key), possessionProven: proven };
}

export async function resolveOwner(address: string, card: RecipientCard): Promise<SealRecipient> {
  const [pq, kem] = await Promise.all([
    pqKeyViaEvm(address),
    fetchKemKey({ rest: chainRest(), fetch: timedFetch, address }),
  ]);
  if (!pq.registered || !pq.publicKey || !pq.possessionProven) {
    throw new ChainError("REFUSED", "This page's owner has not finished setting up their keys. Nothing was sent.");
  }
  if (!kem.registered || !kem.publicKey)
    throw new ChainError("REFUSED", "This page's owner has no sealing key on QoreChain yet. Nothing was sent.");
  try {
    return verifyRecipientCard({
      card,
      chainId: NETWORK.chainId,
      address,
      pqPublicKey: pq.publicKey,
      mlkemPublicKey: kem.publicKey,
    });
  } catch {
    throw new ChainError("REFUSED", "This page's sealing key does not match the key on QoreChain. Nothing was sent.");
  }
}
