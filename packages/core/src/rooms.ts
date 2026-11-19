/**
 * Rooms (spec 5.10): what travels inside a room's sealed batches, and the
 * public hashes recorded on chain. See ARCHITECTURE.md section 8a.
 *
 * The epoch key is shared by every member, so the AES layer alone proves only
 * "a member wrote this". Every message therefore carries its author's QoreSign
 * hybrid signature (kind "room") inside the encrypted payload; readers check it
 * against the author's ML-DSA key on chain.
 */
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { ClassicalKey, PqKeyPair } from "@qorechain/qoresign";
import { canonicalJson } from "./canonical";
import { toHex, utf8 } from "./bytes";
import { signRecord, verifyRecord, type Signed } from "./signed";

export const ROOM_TYPES = ["deal", "payroll", "team", "family"] as const;
export type RoomType = (typeof ROOM_TYPES)[number];

/** Template defaults (spec: Deal = approval required, hidden history; Payroll = auditor key on). */
export const ROOM_TEMPLATES: Record<
  RoomType,
  { label: string; approval: boolean; history: "share" | "hide"; auditor: boolean; blurb: string }
> = {
  deal: {
    label: "Deal",
    approval: true,
    history: "hide",
    auditor: false,
    blurb: "For a deal with a client or partner. New people need approval and don't see earlier messages.",
  },
  payroll: {
    label: "Payroll",
    approval: true,
    history: "hide",
    auditor: true,
    blurb:
      "For pay runs and payslips. New people need approval and don't see earlier messages. An accountant can be given a pass to read it.",
  },
  team: {
    label: "Team",
    approval: true,
    history: "share",
    auditor: false,
    blurb: "For a small team. New members can be shown the history.",
  },
  family: {
    label: "Family",
    approval: false,
    history: "share",
    auditor: false,
    blurb: "For family. Invites join without waiting for approval.",
  },
};

export const PERMISSIONS = ["send", "files", "add", "info", "pin"] as const;
export type Permission = (typeof PERMISSIONS)[number];
export const PERMISSION_LABEL: Record<Permission, string> = {
  send: "Send messages",
  files: "Send files",
  add: "Add members",
  info: "Change room info",
  pin: "Pin messages",
};

export const roomContext = (roomId: string): string => `mzk:room:${roomId}`;

const addr = z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/);

/** The message kinds that travel in a room. System kinds are signed by the admin who made the change. */
export const RoomBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string().min(1).max(8000),
    replyTo: id.optional(),
    mentions: z.array(addr).max(50).default([]),
  }),
  z.object({
    kind: z.literal("file"),
    file: z.record(z.string(), z.unknown()),
    caption: z.string().max(2000).default(""),
    replyTo: id.optional(),
  }),
  z.object({ kind: z.literal("reaction"), target: id, emoji: z.string().max(16), on: z.boolean() }),
  z.object({ kind: z.literal("pin"), target: id, on: z.boolean() }),
  z.object({ kind: z.literal("delete"), target: id }),
  z.object({
    kind: z.literal("info"),
    name: z.string().max(80),
    description: z.string().max(500).default(""),
    /** The room photo as sealed file facts (its key travels only inside the room). */
    photo: z.record(z.string(), z.unknown()).optional(),
    type: z.enum(ROOM_TYPES),
  }),
  z.object({
    kind: z.literal("settings"),
    approval: z.boolean(),
    autoDeleteSeconds: z.number().int().min(0).max(31_536_000),
    restrictSaving: z.boolean(),
    /** History choice used when invites admit people automatically (approval off). */
    historyDefault: z.enum(["share", "hide"]),
  }),
  z.object({ kind: z.literal("created"), members: z.array(addr).max(200) }),
  z.object({ kind: z.literal("added"), member: addr, history: z.enum(["share", "hide"]) }),
  z.object({ kind: z.literal("removed"), member: addr, blocked: z.boolean().default(false) }),
  z.object({ kind: z.literal("left"), member: addr }),
  z.object({
    kind: z.literal("role"),
    member: addr,
    role: z.enum(["member", "admin", "owner"]),
    permissions: z.array(z.enum(PERMISSIONS)).default([...PERMISSIONS]),
  }),
  z.object({ kind: z.literal("rotated"), reason: z.string().max(60) }),
]);
export type RoomBody = z.infer<typeof RoomBodySchema>;

export interface RoomMessageBody {
  roomId: string;
  epoch: string;
  msgId: string;
  sentAt: string;
  body: RoomBody;
}
export type RoomMessage = Signed<RoomMessageBody>;

export function signRoomMessage(args: {
  roomId: string;
  epoch: bigint;
  msgId: string;
  body: RoomBody;
  author: string;
  classical: ClassicalKey;
  pq: PqKeyPair;
}): RoomMessage {
  return signRecord({
    kind: "room",
    body: {
      roomId: args.roomId,
      epoch: args.epoch.toString(),
      msgId: args.msgId,
      sentAt: new Date().toISOString(),
      body: RoomBodySchema.parse(args.body),
    },
    signer: args.author,
    classical: args.classical,
    pq: args.pq,
  });
}

/**
 * Check one opened message: shape, room and epoch match the batch it came in,
 * and the author's signature against their ML-DSA key (fetched by the caller from chain).
 * Throws on any mismatch; returns the parsed body.
 */
export function verifyRoomMessage(
  msg: RoomMessage,
  expect: { roomId: string; epoch: bigint; pqPublicKey: Uint8Array },
): RoomMessageBody {
  const body = verifyRecord(msg, { kind: "room", signer: msg.signer, pqPublicKey: expect.pqPublicKey });
  if (body.roomId !== expect.roomId) throw new Error("This message belongs to another room.");
  if (body.epoch !== expect.epoch.toString())
    throw new Error("This message claims a different key epoch than the one that sealed it.");
  return { ...body, body: RoomBodySchema.parse(body.body) };
}

export interface MemberEntry {
  address: string;
  role: "member" | "admin" | "owner";
}

/**
 * The on-chain membershipHash: SHA-256 of the room id, the epoch and the sorted member addresses.
 * Roles are not part of it: they change without a new key and are recorded on chain on their own
 * (`roleOf`, and the room's owner), so any device can re-check the current member list at any time.
 */
export function membershipHash(
  roomId: string,
  epoch: bigint,
  members: ReadonlyArray<{ address: string }>,
): `0x${string}` {
  const sorted = members.map((m) => m.address).sort();
  return `0x${toHex(sha256(utf8(canonicalJson({ roomId, epoch: epoch.toString(), members: sorted }))))}`;
}

/** SHA-256 of a sealed epoch-key envelope: the on-chain distributionHash. */
export const distributionHash = (envelope: Uint8Array): `0x${string}` => `0x${toHex(sha256(envelope))}`;

/** Room id as stored on chain (bytes32) from the app's string id. */
export const roomIdBytes32 = (roomId: string): `0x${string}` => `0x${toHex(sha256(utf8(`mzk:room:${roomId}`)))}`;

/**
 * "Verify keys": six words from SHA-256 of the member's ML-DSA public key and
 * card hash. Both people read them aloud or side by side; a match means the
 * keys this device uses are the keys that person registered.
 */
export function safetyPhrase(pqPublicKey: Uint8Array, cardHash: string): string {
  const h = sha256(new Uint8Array([...pqPublicKey, ...utf8(cardHash)]));
  const words: string[] = [];
  for (let i = 0; i < 6; i++) {
    const n = ((h[i * 2] ?? 0) << 3) | ((h[i * 2 + 1] ?? 0) >> 5); // 11 bits
    words.push(wordlist[n] ?? "?");
  }
  return words.join(" ");
}

/** Batch index unique per sender: milliseconds × 1000 + a random 0..999. */
export function nextBatchIndex(): bigint {
  return BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
}
