/**
 * Native-lane transactions signed on this device: secp256k1 + ML-DSA-87 hybrid
 * (QoreSign), SIGN_MODE_DIRECT, simulated before signing, then confirmed by
 * polling the committed transaction. Adapted from the proven spike
 * (spikes/chain/lib.mjs, spec section 10).
 */
import { AuthInfo, Fee, SignerInfo, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx";
import { SignMode } from "cosmjs-types/cosmos/tx/signing/v1beta1/signing";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { signHybrid, type ClassicalKey, type PqKeyPair, type SignBytesVersion } from "@qorechain/qoresign";
import {
  resolveSignBytesVersion,
  simulateTx,
  submitWithSignBytesFallback,
  broadcastTx,
} from "@qorechain/qoresign/network";
import { NETWORK, chainRest } from "./config";
import { ChainError, explainRefusal } from "./errors";
import { accountInfo, timedFetch, waitForTx, type RestOpts, type TxResponse } from "./rest";

export interface EncodedMsg {
  typeUrl: string;
  value: Uint8Array;
}

export interface Signer {
  address: string;
  classical: ClassicalKey;
  pq: PqKeyPair;
}

export interface SendResult {
  txHash: string;
  height: bigint;
  gasUsed: bigint;
  fee: bigint;
  tx: TxResponse;
}

function protoBytesField(field: number, bytes: Uint8Array): Uint8Array {
  const out = [(field << 3) | 2];
  let n = bytes.length;
  while (n > 127) {
    out.push((n & 127) | 128);
    n >>= 7;
  }
  out.push(n);
  return Uint8Array.from([...out, ...bytes]);
}

function ethPubAny(publicKey: Uint8Array) {
  return { typeUrl: "/cosmos.evm.crypto.v1.ethsecp256k1.PubKey", value: protoBytesField(1, publicKey) };
}

export function encodeBody(messages: EncodedMsg[], memo = ""): Uint8Array {
  if (new TextEncoder().encode(memo).length > 256)
    throw new ChainError("REFUSED", "The memo is longer than 256 bytes.");
  return TxBody.encode(TxBody.fromPartial({ messages, memo })).finish();
}

function authInfo(pub: Uint8Array, sequence: bigint, gasLimit: bigint): Uint8Array {
  const fee = (gasLimit * BigInt(Math.round(NETWORK.minGasPrice * 10)) + 9n) / 10n;
  return AuthInfo.encode(
    AuthInfo.fromPartial({
      signerInfos: [
        SignerInfo.fromPartial({
          publicKey: ethPubAny(pub),
          modeInfo: { single: { mode: SignMode.SIGN_MODE_DIRECT } },
          sequence,
        }),
      ],
      fee: Fee.fromPartial({ amount: [{ denom: "uqor", amount: fee.toString() }], gasLimit }),
    }),
  ).finish();
}

export const feeFor = (gasLimit: bigint): bigint =>
  (gasLimit * BigInt(Math.round(NETWORK.minGasPrice * 10)) + 9n) / 10n;

export function msgSend(from: string, to: string, denom: string, amount: bigint): EncodedMsg {
  return {
    typeUrl: "/cosmos.bank.v1beta1.MsgSend",
    value: MsgSend.encode({
      fromAddress: from,
      toAddress: to,
      amount: [{ denom, amount: amount.toString() }],
    }).finish(),
  };
}

// One send at a time per account, so sequence numbers never collide.
const queues = new Map<string, Promise<unknown>>();
function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  queues.set(key, next);
  return next;
}

export interface SendOpts extends RestOpts {
  /** "classicalOnly" only for MsgRegisterPQCKeyV2, which the chain requires to be classical. */
  mode?: "hybrid" | "classicalOnly";
  onStage?: (stage: "simulating" | "signing" | "submitted" | "confirmed", txHash?: string) => void;
}

export function sendTx(signer: Signer, messages: EncodedMsg[], memo = "", o: SendOpts = {}): Promise<SendResult> {
  return serial(signer.address, async () => {
    const rest = o.rest ?? chainRest();
    const mode = o.mode ?? "hybrid";
    const acct = await accountInfo(signer.address, o);
    if (!acct.exists) {
      throw new ChainError(
        "NO_ACCOUNT",
        "This account has no test QOR yet, so it cannot pay the network fee. Nothing was sent.",
      );
    }
    const bodyBytes = encodeBody(messages, memo);
    const version: SignBytesVersion = await resolveSignBytesVersion({
      rest,
      fetch: timedFetch,
      chainId: NETWORK.chainId,
    });
    const sign = (gas: bigint, v: SignBytesVersion) =>
      signHybrid({
        chainId: NETWORK.chainId,
        accountNumber: acct.accountNumber,
        bodyBytes,
        authInfoBytes: authInfo(signer.classical.publicKey, acct.sequence, gas),
        classicalKey: signer.classical,
        pqKey: signer.pq,
        mode,
        signBytesVersion: v,
      }).txBytes;
    o.onStage?.("simulating");
    let gasLimit: bigint;
    try {
      gasLimit = (await simulateTx({ rest, fetch: timedFetch, txBytes: sign(400_000n, version) })).suggestedGasLimit;
    } catch (e) {
      const d = (e as { details?: { codespace?: string; code?: number; log?: string } }).details;
      const r = explainRefusal(d?.codespace ?? "", d?.code ?? 0, d?.log ?? String(e));
      throw new ChainError(r.code === "REFUSED" ? "SIMULATION_FAILED" : r.code, r.message, {
        detail: d?.log ?? String(e),
      });
    }
    o.onStage?.("signing");
    const res =
      mode === "hybrid"
        ? await submitWithSignBytesFallback({
            rest,
            chainId: NETWORK.chainId,
            signBytesVersion: version,
            sign: (v) => sign(gasLimit, v),
          })
        : await broadcastTx({ rest, txBytes: sign(gasLimit, version) });
    if (res.code !== 0) {
      const r = explainRefusal(res.codespace, res.code, res.log);
      throw new ChainError(r.code, r.message, { detail: res.log });
    }
    o.onStage?.("submitted", res.txhash);
    const tx = await waitForTx(res.txhash, o);
    if (tx.code !== 0) {
      throw new ChainError(
        "FAILED_IN_BLOCK",
        "The network accepted this step but it failed. Only the network fee was spent.",
        {
          moved: "yes",
          txHash: res.txhash,
          detail: tx.raw_log ?? "",
        },
      );
    }
    o.onStage?.("confirmed", res.txhash);
    return { txHash: res.txhash, height: BigInt(tx.height), gasUsed: BigInt(tx.gas_used), fee: feeFor(gasLimit), tx };
  });
}

/**
 * The network fee a transaction would cost, by simulating it signed (nothing
 * is broadcast). Used to show the fee on a review screen before paying.
 */
export async function estimateTx(
  signer: Signer,
  messages: EncodedMsg[],
  memo = "",
  o: RestOpts = {},
): Promise<{ gasLimit: bigint; fee: bigint }> {
  const rest = o.rest ?? chainRest();
  const acct = await accountInfo(signer.address, o);
  if (!acct.exists)
    throw new ChainError("NO_ACCOUNT", "This account has no test QOR yet, so it cannot pay the network fee.");
  const bodyBytes = encodeBody(messages, memo);
  const version = await resolveSignBytesVersion({ rest, fetch: timedFetch, chainId: NETWORK.chainId });
  const { txBytes } = signHybrid({
    chainId: NETWORK.chainId,
    accountNumber: acct.accountNumber,
    bodyBytes,
    authInfoBytes: authInfo(signer.classical.publicKey, acct.sequence, 400_000n),
    classicalKey: signer.classical,
    pqKey: signer.pq,
    mode: "hybrid",
    signBytesVersion: version,
  });
  try {
    const gasLimit = (await simulateTx({ rest, fetch: timedFetch, txBytes })).suggestedGasLimit;
    return { gasLimit, fee: feeFor(gasLimit) };
  } catch (e) {
    const d = (e as { details?: { codespace?: string; code?: number; log?: string } }).details;
    const r = explainRefusal(d?.codespace ?? "", d?.code ?? 0, d?.log ?? String(e));
    throw new ChainError(r.code === "REFUSED" ? "SIMULATION_FAILED" : r.code, r.message, {
      detail: d?.log ?? String(e),
    });
  }
}
