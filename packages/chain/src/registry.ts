/**
 * MizuhikiRegistry actions as the app performs them: each one signs the
 * action with the owner's ML-DSA-87 key, then sends it from the owner's own
 * EVM account inside the session window.
 */
import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { Action, nameHash, publicClient, signAction, writeContract } from "./evm";
import { mizuhikiRegistryAbi } from "./abi";
import { CONTRACTS } from "./deployment";
import { ChainError } from "./errors";
import { closeWindow, openWindow, readWindow, windowCovers, type EvmWindow } from "./window";
import type { Signer } from "./native";

export type Owner = Signer & { evm: Address };
const reg = { address: CONTRACTS.registry, abi: mizuhikiRegistryAbi } as const;

/** Fee budget per registry action, in uqor: ~300k gas used; the window counts gas limit x fee cap. */
export const PER_ACTION_UQOR = 150_000n;

/** Make sure a window is open that covers `txs` more actions on our contracts; open one if not. */
export async function ensureWindow(owner: Owner, txs = 1, onOpen?: (w: EvmWindow) => void): Promise<EvmWindow> {
  const targets = [CONTRACTS.registry, CONTRACTS.vault, CONTRACTS.anchorBook];
  const w = await readWindow(owner.address);
  if (windowCovers(w, targets, txs, PER_ACTION_UQOR * BigInt(txs))) return w;
  if (w.found && w.live) await closeWindow(owner);
  const opened = await openWindow(owner, { minutes: 120, maxTxs: 20, maxValueUqor: PER_ACTION_UQOR * 20n, targets });
  onOpen?.(opened.window);
  return opened.window;
}

export function commitmentFor(name: string, owner: Address, secret: Hex): Hex {
  return keccak256(
    encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "bytes32" }], [name, owner, secret]),
  );
}

export const cardHashHex = (hexNoPrefix: string): Hex => `0x${hexNoPrefix}`;

/** Commit, wait for a newer block, then register name + card in one signed action. */
export async function registerName(
  owner: Owner,
  name: string,
  cardHash: Hex,
  onStage?: (s: "commit" | "wait" | "register", tx?: Hex) => void,
): Promise<{ commitTx: Hex; registerTx: Hex }> {
  const [existing] = await publicClient().readContract({ ...reg, functionName: "resolve", args: [name] });
  if (!/^0x0{40}$/i.test(existing)) {
    if (existing.toLowerCase() === owner.evm.toLowerCase())
      throw new ChainError("REFUSED", `@${name} is already yours.`);
    throw new ChainError("CONTRACT_REVERT", "That name was just taken. Nothing was charged.", { detail: "NameTaken" });
  }
  const secretBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(secretBytes);
  const secret = toHex(secretBytes);
  onStage?.("commit");
  const c = await writeContract(owner, {
    ...reg,
    functionName: "commit",
    args: [commitmentFor(name, owner.evm, secret)],
  });
  onStage?.("wait", c.txHash);
  const pub = publicClient();
  for (let i = 0; i < 40; i++) {
    if ((await pub.getBlockNumber()) > c.blockNumber) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  onStage?.("register");
  const sig = await signAction(
    owner,
    CONTRACTS.registry,
    mizuhikiRegistryAbi,
    Action.register(nameHash(name), cardHash),
  );
  const r = await writeContract(owner, {
    ...reg,
    functionName: "register",
    args: [owner.evm, name, cardHash, secret, sig],
  });
  return { commitTx: c.txHash, registerTx: r.txHash };
}

export async function setCardOnChain(owner: Owner, cardHash: Hex): Promise<Hex> {
  const sig = await signAction(owner, CONTRACTS.registry, mizuhikiRegistryAbi, Action.setCard(cardHash));
  return (await writeContract(owner, { ...reg, functionName: "setCard", args: [owner.evm, cardHash, sig] })).txHash;
}

export async function resolveOnChain(name: string): Promise<{ owner: Address | undefined; cardHash: Hex }> {
  const [o, c] = await publicClient().readContract({ ...reg, functionName: "resolve", args: [name] });
  return { owner: /^0x0{40}$/i.test(o) ? undefined : o, cardHash: c };
}

export async function primaryNameOf(owner: Address): Promise<Hex> {
  return publicClient().readContract({ ...reg, functionName: "primaryName", args: [owner] });
}

/**
 * Claim another name for an account that already has one (commit, wait a block, claim), as in sign-up but
 * without changing the card. `makePrimary` makes it the account's main name at once.
 */
export async function claimNameOnChain(
  owner: Owner,
  name: string,
  makePrimary: boolean,
  onStage?: (s: "commit" | "wait" | "claim", tx?: Hex) => void,
): Promise<{ commitTx: Hex; claimTx: Hex }> {
  const [existing] = await publicClient().readContract({ ...reg, functionName: "resolve", args: [name] });
  if (!/^0x0{40}$/i.test(existing)) {
    if (existing.toLowerCase() === owner.evm.toLowerCase())
      throw new ChainError("REFUSED", `@${name} is already yours.`);
    throw new ChainError("CONTRACT_REVERT", "That name is taken. Nothing was charged.", { detail: "NameTaken" });
  }
  await ensureWindow(owner, 2);
  const secretBytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(secretBytes);
  const secret = toHex(secretBytes);
  onStage?.("commit");
  const c = await writeContract(owner, {
    ...reg,
    functionName: "commit",
    args: [commitmentFor(name, owner.evm, secret)],
  });
  onStage?.("wait", c.txHash);
  const pub = publicClient();
  for (let i = 0; i < 40; i++) {
    if ((await pub.getBlockNumber()) > c.blockNumber) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  onStage?.("claim");
  const sig = await signAction(
    owner,
    CONTRACTS.registry,
    mizuhikiRegistryAbi,
    Action.claimName(nameHash(name), makePrimary),
  );
  const r = await writeContract(owner, {
    ...reg,
    functionName: "claimName",
    args: [owner.evm, name, makePrimary, secret, sig],
  });
  return { commitTx: c.txHash, claimTx: r.txHash };
}

export async function setPrimaryNameOnChain(owner: Owner, name: string): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.registry, mizuhikiRegistryAbi, Action.setPrimaryName(nameHash(name)));
  return (await writeContract(owner, { ...reg, functionName: "setPrimaryName", args: [owner.evm, name, sig] })).txHash;
}

export async function releaseNameOnChain(owner: Owner, name: string): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.registry, mizuhikiRegistryAbi, Action.releaseName(nameHash(name)));
  return (await writeContract(owner, { ...reg, functionName: "releaseName", args: [owner.evm, name, sig] })).txHash;
}
