/**
 * The real on-chain setup behind "Getting your account ready" (spec 5.2 step 7).
 * Every step first reads the chain or the API, so a reload or a failure never
 * repeats a finished step or charges twice.
 */
import { signRecipientCard } from "@qorechain/qoreseal";
import { cardHash, signRecord, type Manifest } from "@mizuhiki/core";
import {
  DENOMS,
  NETWORK,
  balanceOf,
  cardHashHex,
  ensureWindow,
  keyState,
  registerKemKey,
  registerName,
  registerPqKey,
  resolveOnChain,
  setCardOnChain,
} from "@mizuhiki/chain";
import { api } from "@/lib/api";
import type { Account } from "@/account/AccountProvider";

export type SetupStep = "fund" | "pq" | "kem" | "card" | "window" | "name" | "publish";
export const SETUP_STEPS: { id: SetupStep; title: string; detail: string }[] = [
  {
    id: "fund",
    title: "Get test QOR",
    detail: "Network fees are paid in test QOR. Setup uses about 0.12; the faucet gives 100.",
  },
  {
    id: "pq",
    title: "Register your post-quantum signing key",
    detail: "ML-DSA-87. Proves every later action is yours.",
  },
  { id: "kem", title: "Publish your sealing key", detail: "ML-KEM-1024. Senders seal to it on their own device." },
  {
    id: "card",
    title: "Sign your recipient card",
    detail: "Ties your sealing keys to your account, so nobody can swap them.",
  },
  {
    id: "window",
    title: "Allow on-chain actions for 2 hours",
    detail: "Only Mizuhiki's two contracts, up to 20 actions. Signed with your post-quantum key.",
  },
  { id: "name", title: "Claim your name", detail: "Recorded on QoreChain in two steps so nobody can take it first." },
  { id: "publish", title: "Publish your page", detail: "Signed by you; every visitor checks the signature." },
];

/** Enough for the whole setup with a safety margin, in uqor. */
export const MIN_SETUP_UQOR = 200_000n;

export interface SetupHooks {
  token: () => Promise<string>;
  onStep: (step: SetupStep, state: "running" | "done", info?: { tx?: string; note?: string }) => void;
  /** Called while waiting for funds; return false to stop waiting. */
  onWaitingForFunds: (balanceUqor: bigint) => boolean;
  signal?: AbortSignal;
  /** Last chance to change the manifest before it is signed (the avatar upload needs a session). */
  beforePublish?: (m: Manifest) => Promise<Manifest>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    });
  });

export async function runSetup(
  account: Account,
  manifest: Manifest,
  hooks: SetupHooks,
): Promise<{ registerTx?: string; published?: Manifest }> {
  const { owner, keys } = account;
  const out: { registerTx?: string; published?: Manifest } = {};
  // Checked before every step that can send anything: an aborted run never sends a transaction.
  const live = () => hooks.signal?.throwIfAborted();

  // 1. funds
  hooks.onStep("fund", "running");
  for (;;) {
    const bal = await balanceOf(owner.address, DENOMS.QOR.denom);
    if (bal >= MIN_SETUP_UQOR) break;
    const state = await keyState(owner, keys.seal).catch(() => undefined);
    const named = (await resolveOnChain(manifest.name)).owner?.toLowerCase() === owner.evm.toLowerCase();
    if (state?.pq === "ours" && state.kem === "ours" && named) break; // already set up; publish needs no fee
    if (!hooks.onWaitingForFunds(bal)) throw new DOMException("aborted", "AbortError");
    await sleep(4000, hooks.signal);
  }
  hooks.onStep("fund", "done");

  live();
  // 2-3. keys
  let ks = await keyState(owner, keys.seal);
  if (ks.pq === "other" || ks.kem === "other")
    throw new Error("A different key is already registered for this account. Nothing was changed.");
  live();
  hooks.onStep("pq", "running");
  if (ks.pq === "missing") hooks.onStep("pq", "done", { tx: (await registerPqKey(owner)).txHash });
  else hooks.onStep("pq", "done", { note: "already registered" });
  live();
  hooks.onStep("kem", "running");
  ks = await keyState(owner, keys.seal);
  if (ks.kem === "missing") hooks.onStep("kem", "done", { tx: (await registerKemKey(owner, keys.seal)).txHash });
  else hooks.onStep("kem", "done", { note: "already registered" });

  live();
  // 4. card: signed here, verified by the server against the chain
  hooks.onStep("card", "running");
  const card = signRecipientCard({
    chainId: NETWORK.chainId,
    address: owner.address,
    keys: keys.seal,
    classicalKey: keys.classical,
    pqKey: keys.pq,
  });
  const hash = cardHashHex(cardHash(card));
  const token = await hooks.token();
  await api.put("/cards", { card }, { token });
  hooks.onStep("card", "done");

  // 5-6. window, then name + card hash on the registry
  const onChain = await resolveOnChain(manifest.name);
  const mine = onChain.owner?.toLowerCase() === owner.evm.toLowerCase();
  if (!mine || onChain.cardHash.toLowerCase() !== hash.toLowerCase()) {
    live();
    hooks.onStep("window", "running");
    const w = await ensureWindow(owner, 2);
    hooks.onStep("window", "done", { note: `${w.remainingTxs.toString()} actions left` });
    live();
    hooks.onStep("name", "running");
    if (!mine) {
      const r = await registerName(owner, manifest.name, hash);
      out.registerTx = r.registerTx;
      hooks.onStep("name", "done", { tx: r.registerTx });
    } else {
      hooks.onStep("name", "done", { tx: await setCardOnChain(owner, hash), note: "card updated" });
    }
  } else {
    hooks.onStep("window", "done", { note: "not needed" });
    hooks.onStep("name", "done", { note: "already yours" });
  }

  live();
  // 7. publish the signed page
  hooks.onStep("publish", "running");
  const existing = await api.get<{ page: { name: string; version: number } | null }>("/owner/page", {
    token: await hooks.token(),
  });
  if (existing.page?.name === manifest.name) {
    hooks.onStep("publish", "done", { note: "already published" });
    return out;
  }
  const final = hooks.beforePublish ? await hooks.beforePublish(manifest) : manifest;
  live();
  const record = signRecord({
    kind: "manifest",
    body: final,
    signer: owner.address,
    classical: keys.classical,
    pq: keys.pq,
  });
  await api.put("/pages", { record }, { token: await hooks.token() });
  out.published = final;
  hooks.onStep("publish", "done");
  return out;
}
