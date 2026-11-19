/** One-time key registration on chain: ML-DSA-87 (classical-only, as the chain requires), then ML-KEM-1024 (hybrid). */
import { buildRegisterPqKeyMessage, toHex } from "@qorechain/qoresign";
import { fetchPqKeyStatus } from "@qorechain/qoresign/network";
import { buildRegisterKemKeyMessage, type SealKeyPair } from "@qorechain/qoreseal";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { NETWORK, chainRest } from "./config";
import { ChainError } from "./errors";
import { sendTx, type SendOpts, type SendResult, type Signer } from "./native";
import type { RestOpts } from "./rest";

export interface KeyState {
  pq: "missing" | "ours" | "other";
  possessionProven: boolean;
  kem: "missing" | "ours" | "other";
}

export async function keyState(signer: Signer, seal: SealKeyPair, o: RestOpts = {}): Promise<KeyState> {
  const rest = o.rest ?? chainRest();
  const pq = await fetchPqKeyStatus({ rest, address: signer.address });
  const kem = await fetchKemKey({ rest, address: signer.address });
  const pqState = !pq.registered
    ? "missing"
    : pq.publicKey && toHex(pq.publicKey) === toHex(signer.pq.publicKey)
      ? "ours"
      : "other";
  const kemState = !kem.registered
    ? "missing"
    : kem.publicKey && toHex(kem.publicKey) === toHex(seal.mlkemPublicKey)
      ? "ours"
      : "other";
  return { pq: pqState, possessionProven: pq.possessionProven === true, kem: kemState };
}

export async function registerPqKey(signer: Signer, o: SendOpts = {}): Promise<SendResult> {
  const msg = buildRegisterPqKeyMessage({
    chainId: NETWORK.chainId,
    account: signer.address,
    pqKey: signer.pq,
    classicalPublicKey: signer.classical.publicKey,
  });
  return sendTx(signer, [msg], "mzk:register-pq", { ...o, mode: "classicalOnly" });
}

export async function registerKemKey(signer: Signer, seal: SealKeyPair, o: SendOpts = {}): Promise<SendResult> {
  const msg = buildRegisterKemKeyMessage({ sender: signer.address, mlkemPublicKey: seal.mlkemPublicKey });
  return sendTx(signer, [msg], "mzk:register-kem", o);
}

/** Bring both keys to "ours", skipping what is already done. Refuses if a different key is registered. */
export async function ensureKeys(
  signer: Signer,
  seal: SealKeyPair,
  o: SendOpts & { onStep?: (step: "pq" | "kem", r: SendResult | "already") => void } = {},
): Promise<KeyState> {
  let s = await keyState(signer, seal, o);
  if (s.pq === "other" || s.kem === "other") {
    throw new ChainError("REFUSED", "A different key is already registered for this account. Nothing was changed.");
  }
  // Register first, then report: an optional call (`onStep?.(…)`) would skip
  // evaluating its arguments when no callback is given.
  const pqResult = s.pq === "missing" ? await registerPqKey(signer, o) : "already";
  o.onStep?.("pq", pqResult);
  const kemResult = s.kem === "missing" ? await registerKemKey(signer, seal, o) : "already";
  o.onStep?.("kem", kemResult);
  s = await keyState(signer, seal, o);
  if (s.pq !== "ours" || s.kem !== "ours") {
    throw new ChainError(
      "NOT_COMMITTED",
      "The keys were sent but the network does not show them yet. Try again in a moment.",
      { moved: "unknown" },
    );
  }
  return s;
}
