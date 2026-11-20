/**
 * Signed records: page manifests, sender signatures, room records, receipts.
 * A QoreSign hybrid message signature (secp256k1 + ML-DSA-87) over a domain
 * line and the record's canonical JSON. Verification is always against the
 * signer's ML-DSA-87 key as registered on chain.
 */
import {
  signMessage,
  verifyMessage,
  type ClassicalKey,
  type MessageSignature,
  type PqKeyPair,
} from "@qorechain/qoresign";
import { canonicalJson } from "./canonical";
import { MizuhikiError } from "./errors";
import { CHAIN_ID } from "./seal";

export type SignedKind =
  | "manifest"
  | "sender"
  | "room"
  | "receipt"
  | "pass"
  | "draft-index"
  | "form"
  | "product"
  | "invoice"
  | "snapshot"
  | "recovery"
  | "capsule"
  | "filerequest";

export interface Signed<T> {
  kind: SignedKind;
  signer: string;
  body: T;
  signature: MessageSignature;
}

export function signedBytes(kind: SignedKind, body: unknown): string {
  return `mizuhiki:${kind}:v1\n${canonicalJson(body)}`;
}

export function signRecord<T>(args: {
  kind: SignedKind;
  body: T;
  signer: string;
  classical: ClassicalKey;
  pq: PqKeyPair;
  chainId?: string;
}): Signed<T> {
  const signature = signMessage({
    chainId: args.chainId ?? CHAIN_ID,
    signer: args.signer,
    data: signedBytes(args.kind, args.body),
    classicalKey: args.classical,
    pqKey: args.pq,
  });
  return { kind: args.kind, signer: args.signer, body: args.body, signature };
}

/** Verify against the ML-DSA-87 key the caller read from the chain for `signer`. */
export function verifyRecord<T>(
  rec: Signed<T>,
  expect: { kind: SignedKind; signer?: string; pqPublicKey: Uint8Array; chainId?: string },
): T {
  if (rec.kind !== expect.kind) throw new MizuhikiError("SIGNATURE_INVALID", `expected a ${expect.kind} record`);
  if (expect.signer !== undefined && rec.signer !== expect.signer) {
    throw new MizuhikiError("SIGNATURE_INVALID", "This record was signed by a different account.");
  }
  try {
    verifyMessage({
      chainId: expect.chainId ?? CHAIN_ID,
      signer: rec.signer,
      data: signedBytes(rec.kind, rec.body),
      signature: rec.signature,
      pqPublicKey: expect.pqPublicKey,
      requirePq: true,
    });
  } catch (e) {
    throw new MizuhikiError("SIGNATURE_INVALID", "This signature does not match the owner's key on chain.", {
      cause: e,
    });
  }
  return rec.body;
}
