/**
 * CapsuleVault (spec 5.14, ARCHITECTURE 8e): reads and the owner's and
 * guardians' actions, each authorised by that account's ML-DSA-87 signature
 * inside the contract. `finalize` needs no authority and is called by whoever
 * opens a capsule whose time has come.
 */
import type { Address, Hex } from "viem";
import { capsuleVaultAbi } from "./abi";
import { CONTRACTS } from "./deployment";
import { Action, publicClient, signAction, writeContract, type CapsulePlan as ChainPlan } from "./evm";
import { ensureWindow, type Owner } from "./registry";

const vault = { address: CONTRACTS.vault, abi: capsuleVaultAbi } as const;

export const CAPSULE_STATUS = ["none", "armed", "requested", "released", "cancelled"] as const;
export type CapsuleStatus = (typeof CAPSULE_STATUS)[number];

export interface CapsuleOnChain {
  owner: Address | null;
  mode: 0 | 1 | 2;
  status: CapsuleStatus;
  threshold: number;
  releaseAt: bigint;
  waitSeconds: bigint;
  quietSeconds: bigint;
  accessSeconds: bigint;
  createdAt: bigint;
  requestedAt: bigint;
  releasedAt: bigint;
  requestedBy: Address | null;
  planHash: Hex;
  guardians: Address[];
  /** When it opens if nothing changes (0: no time running). */
  opensAt: bigint;
  /** The owner's last signed check-in (0: never). */
  lastCheckIn: bigint;
}

const zero = (a: Address) => (/^0x0{40}$/i.test(a) ? null : a);

export async function readCapsule(id: Hex): Promise<CapsuleOnChain> {
  const pub = publicClient();
  const [[c, guardians], opensAt] = await Promise.all([
    pub.readContract({ ...vault, functionName: "capsule", args: [id] }),
    pub.readContract({ ...vault, functionName: "opensAt", args: [id] }),
  ]);
  const owner = zero(c.owner);
  // Only "if I go quiet" capsules depend on the owner's check-ins.
  const lastCheckIn =
    owner && c.mode === 2 ? await pub.readContract({ ...vault, functionName: "lastCheckIn", args: [owner] }) : 0n;
  return {
    owner,
    mode: c.mode as 0 | 1 | 2,
    status: CAPSULE_STATUS[c.status] ?? "none",
    threshold: c.threshold,
    releaseAt: c.releaseAt,
    waitSeconds: c.waitSeconds,
    quietSeconds: c.quietSeconds,
    accessSeconds: c.accessSeconds,
    createdAt: c.createdAt,
    requestedAt: c.requestedAt,
    releasedAt: c.releasedAt,
    requestedBy: zero(c.requestedBy),
    planHash: c.planHash,
    guardians: [...guardians],
    opensAt,
    lastCheckIn,
  };
}

export async function lastCheckInOf(owner: Address): Promise<bigint> {
  return publicClient().readContract({ ...vault, functionName: "lastCheckIn", args: [owner] });
}

/** The chain's own clock (block timestamp), which decides every release. */
export async function chainNow(): Promise<bigint> {
  return (await publicClient().getBlock()).timestamp;
}

export async function createCapsuleOnChain(owner: Owner, plan: ChainPlan): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.vault, capsuleVaultAbi, Action.capsuleCreate(plan));
  return (
    await writeContract(owner, {
      ...vault,
      functionName: "create",
      args: [
        owner.evm,
        plan.id,
        plan.mode,
        plan.guardians,
        plan.threshold,
        plan.releaseAt,
        plan.waitSeconds,
        plan.quietSeconds,
        plan.accessSeconds,
        plan.planHash,
        sig,
      ],
    })
  ).txHash;
}

export async function setCapsuleGuardiansOnChain(
  owner: Owner,
  id: Hex,
  guardians: Address[],
  threshold: number,
  planHash: Hex,
): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(
    owner,
    CONTRACTS.vault,
    capsuleVaultAbi,
    Action.setGuardians(id, guardians, threshold, planHash),
  );
  return (
    await writeContract(owner, {
      ...vault,
      functionName: "setGuardians",
      args: [owner.evm, id, guardians, threshold, planHash, sig],
    })
  ).txHash;
}

export async function checkInOnChain(owner: Owner): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.vault, capsuleVaultAbi, Action.checkIn());
  return (await writeContract(owner, { ...vault, functionName: "checkIn", args: [owner.evm, sig] })).txHash;
}

export async function rejectCapsuleRequest(owner: Owner, id: Hex): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.vault, capsuleVaultAbi, Action.reject(id));
  return (await writeContract(owner, { ...vault, functionName: "reject", args: [owner.evm, id, sig] })).txHash;
}

export async function releaseCapsuleNow(owner: Owner, id: Hex): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.vault, capsuleVaultAbi, Action.releaseNow(id));
  return (await writeContract(owner, { ...vault, functionName: "releaseNow", args: [owner.evm, id, sig] })).txHash;
}

export async function cancelCapsuleOnChain(owner: Owner, id: Hex): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.vault, capsuleVaultAbi, Action.cancel(id));
  return (await writeContract(owner, { ...vault, functionName: "cancel", args: [owner.evm, id, sig] })).txHash;
}

export async function requestCapsuleRelease(guardian: Owner, id: Hex): Promise<Hex> {
  await ensureWindow(guardian, 1);
  const sig = await signAction(guardian, CONTRACTS.vault, capsuleVaultAbi, Action.request(id));
  return (await writeContract(guardian, { ...vault, functionName: "request", args: [guardian.evm, id, sig] })).txHash;
}

/** Record a release whose time has come; anyone may send it. */
export async function finalizeCapsule(sender: Owner, id: Hex): Promise<Hex> {
  await ensureWindow(sender, 1);
  return (await writeContract(sender, { ...vault, functionName: "finalize", args: [id] })).txHash;
}
