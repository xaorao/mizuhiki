/**
 * The EVM authorisation window (spec 4.10). Opened once per session from the
 * native lane with the post-quantum key, scoped to our contracts only, with a
 * transaction cap and a fee budget. Opening advances the EVM nonce, so every
 * EVM transaction is signed after the open (sdk pqc/evm-window.ts).
 */
import type { EvmWindow } from "@qorechain/sdk";
import { chainRest } from "./config";
import { recentBlockSeconds, timedFetch, type RestOpts } from "./rest";
import { sendTx, type EncodedMsg, type SendOpts, type SendResult, type Signer } from "./native";

export type { EvmWindow };

/**
 * The SDK is loaded when a window is first read, opened or closed, never at start: its message registry pulls in
 * CosmJS and every hash algorithm it ships (about 2.7 MB), which every page would otherwise download.
 */
let sdk:
  | Promise<{
      mod: typeof import("@qorechain/sdk");
      reg: ReturnType<typeof import("@qorechain/sdk").qorechainRegistry>;
    }>
  | undefined;
const loadSdk = () =>
  (sdk ??= import("@qorechain/sdk").then(
    (mod) => ({ mod, reg: mod.qorechainRegistry() }),
    (e: unknown) => {
      sdk = undefined;
      throw e;
    },
  ));
const encode = async (m: { typeUrl: string; value: unknown }): Promise<EncodedMsg> => ({
  typeUrl: m.typeUrl,
  value: (await loadSdk()).reg.encode(m),
});

export interface WindowPlan {
  minutes: number;
  maxTxs: number;
  /** Fee budget in uqor: value plus the maximum fee of every admitted transaction. */
  maxValueUqor: bigint;
  /** Contracts the window may call. Empty means any target, which also allows contract creation (deploy only). */
  targets: string[];
}

/** Default session plan: 2 hours, 20 actions, our contracts only (spec 4.10). */
export function sessionPlan(targets: string[], perTxFeeUqor: bigint): WindowPlan {
  return { minutes: 120, maxTxs: 20, maxValueUqor: perTxFeeUqor * 20n, targets };
}

export async function blocksFor(minutes: number, o: RestOpts = {}): Promise<number> {
  const [secs, { mod }] = await Promise.all([recentBlockSeconds(o).catch(() => 1.3), loadSdk()]);
  const blocks = Math.ceil((minutes * 60) / Math.max(0.5, secs));
  return Math.min(Number(mod.MAX_EVM_WINDOW_BLOCKS), Math.max(1, blocks));
}

export async function readWindow(address: string, o: RestOpts = {}): Promise<EvmWindow> {
  const { mod } = await loadSdk();
  return mod.fetchEvmWindow({ rest: o.rest ?? chainRest(), fetch: o.fetch ?? timedFetch, address });
}

export async function openWindow(
  signer: Signer,
  plan: WindowPlan,
  o: SendOpts = {},
): Promise<{ result: SendResult; window: EvmWindow }> {
  const blocks = await blocksFor(plan.minutes, o);
  const { mod } = await loadSdk();
  const msg = mod.openEvmWindowMsg({
    sender: signer.address,
    blocks,
    maxTxs: plan.maxTxs,
    maxValue: plan.maxValueUqor,
    ...(plan.targets.length > 0 ? { allowedTargets: plan.targets } : {}),
  });
  const result = await sendTx(signer, [await encode(msg)], "mzk:window", o);
  return { result, window: await readWindow(signer.address, o) };
}

export async function closeWindow(signer: Signer, o: SendOpts = {}): Promise<SendResult> {
  const { mod } = await loadSdk();
  return sendTx(signer, [await encode(mod.closeEvmWindowMsg(signer.address))], "mzk:window-close", o);
}

/** Is the stored window usable for `txs` more transactions to these targets? */
export function windowCovers(w: EvmWindow, targets: string[], txs = 1, feeUqor = 0n): boolean {
  if (!w.found || !w.live) return false;
  if (w.remainingTxs < BigInt(txs) || w.remainingValue < feeUqor) return false;
  if (w.allowedTargets.length === 0) return true;
  const allowed = new Set(w.allowedTargets.map((t) => t.toLowerCase()));
  return targets.every((t) => allowed.has(t.toLowerCase()));
}
