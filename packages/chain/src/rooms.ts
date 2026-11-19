/**
 * Room records on MizuhikiRegistry (spec 5.10). Every call is authorised by the
 * acting account's ML-DSA-87 signature inside the contract; membership and
 * distribution hashes are computed by the caller (see packages/core/src/rooms.ts).
 */
import type { Address, Hex } from "viem";
import { mizuhikiRegistryAbi } from "./abi";
import { CONTRACTS } from "./deployment";
import { Action, bytes32Text, publicClient, signAction, writeContract } from "./evm";
import { ensureWindow, type Owner } from "./registry";

const reg = { address: CONTRACTS.registry, abi: mizuhikiRegistryAbi } as const;

export const ROOM_ROLE = { none: 0, member: 1, admin: 2, owner: 3 } as const;
export type RoomRoleName = keyof typeof ROOM_ROLE;

export interface RoomOnChain {
  owner: Address | null;
  epoch: bigint;
  membershipHash: Hex;
  distributionHash: Hex;
  closed: boolean;
}

export async function readRoom(roomId: Hex): Promise<RoomOnChain> {
  const [owner, epoch, membershipHash, distributionHash, closed] = await publicClient().readContract({
    ...reg,
    functionName: "rooms",
    args: [roomId],
  });
  return { owner: /^0x0{40}$/i.test(owner) ? null : owner, epoch, membershipHash, distributionHash, closed };
}

export async function roleOnChain(roomId: Hex, member: Address): Promise<number> {
  return await publicClient().readContract({ ...reg, functionName: "roleOf", args: [roomId, member] });
}

export async function createRoomOnChain(
  owner: Owner,
  roomId: Hex,
  membershipHash: Hex,
  distributionHash: Hex,
): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(
    owner,
    CONTRACTS.registry,
    mizuhikiRegistryAbi,
    Action.createRoom(roomId, membershipHash, distributionHash),
  );
  return (
    await writeContract(owner, {
      ...reg,
      functionName: "createRoom",
      args: [owner.evm, roomId, membershipHash, distributionHash, sig],
    })
  ).txHash;
}

export async function rotateRoomOnChain(
  actor: Owner,
  roomId: Hex,
  newEpoch: bigint,
  membershipHash: Hex,
  distributionHash: Hex,
  reason: string,
): Promise<Hex> {
  await ensureWindow(actor, 1);
  const r = bytes32Text(reason.slice(0, 32));
  const sig = await signAction(
    actor,
    CONTRACTS.registry,
    mizuhikiRegistryAbi,
    Action.rotateRoom(roomId, newEpoch, membershipHash, distributionHash, r),
  );
  return (
    await writeContract(actor, {
      ...reg,
      functionName: "rotateRoom",
      args: [actor.evm, roomId, newEpoch, membershipHash, distributionHash, r, sig],
    })
  ).txHash;
}

export async function setRoleOnChain(actor: Owner, roomId: Hex, member: Address, role: number): Promise<Hex> {
  await ensureWindow(actor, 1);
  const sig = await signAction(actor, CONTRACTS.registry, mizuhikiRegistryAbi, Action.setRole(roomId, member, role));
  return (await writeContract(actor, { ...reg, functionName: "setRole", args: [actor.evm, roomId, member, role, sig] }))
    .txHash;
}

export async function transferRoomOnChain(owner: Owner, roomId: Hex, newOwner: Address): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.registry, mizuhikiRegistryAbi, Action.transferRoom(roomId, newOwner));
  return (
    await writeContract(owner, { ...reg, functionName: "transferRoom", args: [owner.evm, roomId, newOwner, sig] })
  ).txHash;
}

export async function closeRoomOnChain(owner: Owner, roomId: Hex): Promise<Hex> {
  await ensureWindow(owner, 1);
  const sig = await signAction(owner, CONTRACTS.registry, mizuhikiRegistryAbi, Action.closeRoom(roomId));
  return (await writeContract(owner, { ...reg, functionName: "closeRoom", args: [owner.evm, roomId, sig] })).txHash;
}

/** The card hash an account registered on chain ("Verify keys" uses it with the ML-DSA key). */
export async function cardHashOnChain(evm: Address): Promise<Hex> {
  return publicClient().readContract({ ...reg, functionName: "cardHashOf", args: [evm] });
}
