/**
 * Rooms on this device (spec 5.10, ARCHITECTURE 8a).
 *
 * - Keys: every epoch key this account may hold is rebuilt from the sealed
 *   distributions in the blob store (plus a shared-history envelope, if an
 *   admin chose "Share past messages"), opened with the account's own key.
 * - Messages: a QoreSign-signed RoomMessage sealed as a PrivateBatchCodec
 *   blob under the current epoch key. Readers check the signature against the
 *   author's ML-DSA key read from QoreChain.
 * - Membership changes: an admin's browser runs EpochKeyManager, seals the new
 *   key to the new member list, records the epoch on MizuhikiRegistry, then
 *   tells the relay. The chain refuses a stale epoch, so two admins cannot both win.
 */
import {
  CHAIN_ID,
  PERMISSIONS,
  Purpose,
  RoomBodySchema,
  ab,
  distributionHash,
  encryptFile,
  fromBase64Url,
  fromUtf8,
  linkKeys,
  membershipHash,
  newLinkSeed,
  nextBatchIndex,
  openItem,
  publicRecipient,
  randomBytes,
  roomContext,
  roomIdBytes32,
  safetyPhrase,
  sealItem,
  sha256Hex,
  signRoomMessage,
  toBase64Url,
  toHex,
  utf8,
  verifyRoomMessage,
  type FileFacts,
  type MemberEntry,
  type Permission,
  type RoomBody,
  type RoomMessage,
  type RoomType,
} from "@mizuhiki/core";
import { EpochKeyManager, openBatch, openEpochKey, sealBatch, type EpochKey } from "@qorechain/qoreseal";
import { parseAddress } from "@qorechain/qoresign";
import { derive } from "./derive";
import {
  cardHashOnChain,
  closeRoomOnChain,
  createRoomOnChain,
  pqKeyViaEvm,
  resolveOwner,
  rotateRoomOnChain,
  ROOM_ROLE,
  setRoleOnChain,
  transferRoomOnChain,
  ownerOfName,
} from "@mizuhiki/chain";
import type { Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import { cardOf } from "@/lib/send";
import { idb } from "@/lib/idb";

// ---- server shapes ------------------------------------------------------------------------

export type MemberStatus = "active" | "left" | "removed" | "blocked";
export type Role = "member" | "admin" | "owner";

export interface RoomListItem {
  id: string;
  epoch: number;
  role: Role;
  status: MemberStatus;
  muted: boolean;
  members: number;
  lastSeq: string;
  lastAt: string;
  unread: number;
  requests: number;
  needsRotation: boolean;
  createdAt: string;
}

export interface MemberRow {
  roomId: string;
  address: string;
  role: Role;
  permissions: Permission[];
  status: MemberStatus;
  joinedEpoch: number;
  /** Epoch of this person's first admission (kept across leaving and rejoining). */
  firstEpoch: number;
  lastEpoch: number | null;
  lastReadSeq: string;
  muted: boolean;
  joinedAt: string;
}

export interface EpochRow {
  epoch: number;
  distribution: string;
  membershipHash: string;
  txHash: string;
  by: string;
  reason: string;
  at: string;
}

export interface RoomDetail {
  id: string;
  epoch: number;
  owner: string;
  chainId?: string;
  me: MemberRow;
  members: MemberRow[];
  epochs: EpochRow[];
  settings: { approval: boolean; autoDeleteSeconds: number } | null;
  needsRotation?: boolean;
  closed: boolean;
}

export interface BatchRow {
  seq: string;
  hash: string;
  epoch: number;
  at: string;
  size: number;
  expiresAt: string | null;
}

export interface JoinRequest {
  roomId: string;
  address: string;
  inviteId: string;
  status: "pending" | "approved" | "declined";
  at: string;
}

export interface InviteRow {
  id: string;
  roomId: string;
  card: string;
  createdBy: string;
  primary: boolean;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  revoked: boolean;
  createdAt: string;
}

// ---- errors -------------------------------------------------------------------------------

export class RoomError extends Error {
  constructor(
    message: string,
    readonly code: string = "ROOM",
  ) {
    super(message);
    this.name = "RoomError";
  }
}

const evm = (a: string) => parseAddress(a).hex as `0x${string}`;
type Tokened = Account & { token: string };
const T = (account: Tokened) => ({ token: account.token });

/** The API needs a session token with every call; callers pass `withToken(account, await token())`. */
export const withToken = (account: Account, token: string): Tokened => ({ ...account, token });

// ---- sealed blobs -------------------------------------------------------------------------

/** Blobs are content-addressed and never change, so each is fetched once per tab. */
const blobCache = new Map<string, Promise<Uint8Array>>();
const BLOB_CACHE_MAX = 600;
export function blobBytes(hash: string): Promise<Uint8Array> {
  let p = blobCache.get(hash);
  if (!p) {
    p = api.bytes(`/blobs/${hash}`);
    p.catch(() => blobCache.delete(hash));
    blobCache.set(hash, p);
    if (blobCache.size > BLOB_CACHE_MAX) {
      const oldest = blobCache.keys().next().value;
      if (oldest !== undefined) blobCache.delete(oldest);
    }
  }
  return p;
}

// ---- keys ---------------------------------------------------------------------------------

const keyCache = new Map<string, Map<bigint, Uint8Array>>();
const fetchedAt = new Map<string, number>();

function cacheKey(account: Account, roomId: string): string {
  return `${account.owner.address}:${roomId}`;
}

/** Wraps a local storage key derived from the account's own sealing seed (never leaves the device). */
async function localKey(account: Account, label: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", ab(account.keys.seal.seed), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: ab(utf8(`mzk:room-cache:v1:${label}`)),
      info: ab(utf8(account.owner.address)),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function readLocal<T>(account: Account, name: string): Promise<T | undefined> {
  try {
    const stored = await idb.get<{ iv: Uint8Array; ct: Uint8Array }>(`room:${account.owner.address}:${name}`);
    if (!stored) return undefined;
    const k = await localKey(account, name);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(stored.iv) }, k, ab(stored.ct));
    return JSON.parse(fromUtf8(new Uint8Array(plain))) as T;
  } catch {
    return undefined;
  }
}

async function writeLocal(account: Account, name: string, value: unknown): Promise<void> {
  try {
    const k = await localKey(account, name);
    const iv = randomBytes(12);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, k, ab(utf8(JSON.stringify(value)))),
    );
    await idb.set(`room:${account.owner.address}:${name}`, { iv, ct });
  } catch {
    // A private window can refuse storage; rooms still work, just without the local copy.
  }
}

interface StoredKey {
  epoch: string;
  key: string;
}

/**
 * Every epoch key this account can hold for a room, oldest first. Opened from
 * the distributions sealed to this account and from shared history. Keys a
 * member already had are also kept locally (encrypted), so a removed member
 * still reads what they could read before.
 */
export interface KeysView {
  epochs: { epoch: number; hash: string }[];
  history: { hash: string }[];
  current: number;
}

export async function roomKeys(
  account: Tokened,
  roomId: string,
  refresh = false,
  given?: KeysView,
): Promise<Map<bigint, Uint8Array>> {
  const ck = cacheKey(account, roomId);
  const have = keyCache.get(ck) ?? new Map<bigint, Uint8Array>();
  const fresh = fetchedAt.get(ck);
  if (!given && !refresh && fresh && Date.now() - fresh < 30_000) return have;
  if (!keyCache.has(ck)) {
    const stored = (await readLocal<StoredKey[]>(account, `keys:${roomId}`)) ?? [];
    for (const s of stored) have.set(BigInt(s.epoch), fromBase64Url(s.key));
    keyCache.set(ck, have);
  }
  const r = given ?? (await api.get<KeysView>(`/rooms/${roomId}/keys`, T(account)));
  const before = have.size;
  for (const h of r.history) {
    try {
      const env = await blobBytes(h.hash);
      const list = JSON.parse(
        fromUtf8(openItem({ purpose: Purpose.roomHistory(roomId), envelope: env, keys: account.keys.seal })),
      ) as StoredKey[];
      for (const k of list) if (!have.has(BigInt(k.epoch))) have.set(BigInt(k.epoch), fromBase64Url(k.key));
    } catch {
      // Not sealed to this account, or damaged: skip it, and the messages of those epochs stay unreadable here.
    }
  }
  for (const e of r.epochs) {
    if (have.has(BigInt(e.epoch))) continue;
    try {
      const env = await blobBytes(e.hash);
      const k = openEpochKey({
        chainId: CHAIN_ID,
        purpose: Purpose.room(roomId),
        envelope: env,
        keys: account.keys.seal,
      });
      if (k.epoch !== BigInt(e.epoch)) continue; // a distribution must carry the epoch it is filed under
      have.set(k.epoch, k.key);
    } catch {
      // Not a reader of this epoch (joined later, or re-joined): nothing to open.
    }
  }
  fetchedAt.set(ck, Date.now());
  if (have.size !== before) {
    await writeLocal(
      account,
      `keys:${roomId}`,
      [...have.entries()].map(([epoch, key]) => ({ epoch: epoch.toString(), key: toBase64Url(key) })),
    );
  }
  return have;
}

const sortedKeys = (m: Map<bigint, Uint8Array>): EpochKey[] =>
  [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([epoch, key]) => ({ epoch, key }));

// ---- people -------------------------------------------------------------------------------

const nameCache = new Map<string, Promise<string | null>>();
export function nameOf(address: string): Promise<string | null> {
  let p = nameCache.get(address);
  if (!p) {
    p = api
      .get<{ name: string | null }>(`/names/of/${address}`)
      .then((r) => r.name)
      .catch(() => {
        // A failed lookup is not "no name": forget it so the next render asks again.
        nameCache.delete(address);
        return null;
      });
    nameCache.set(address, p);
  }
  return p;
}

export const shortAddress = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

const pqCache = new Map<string, Promise<Uint8Array | null>>();
function pqKey(address: string): Promise<Uint8Array | null> {
  let p = pqCache.get(address);
  if (!p) {
    p = pqKeyViaEvm(address)
      .then((k) => (k.registered && k.publicKey && k.possessionProven ? k.publicKey : null))
      .catch(() => {
        pqCache.delete(address);
        return null;
      });
    pqCache.set(address, p);
  }
  return p;
}

/** "Verify keys": six words both people compare. Built from the on-chain ML-DSA key and card hash. */
export async function safetyWords(address: string): Promise<string> {
  const [pq, card] = await Promise.all([pqKey(address), cardHashOnChain(evm(address))]);
  if (!pq) throw new RoomError("This account has no proven post-quantum key on QoreChain.");
  return safetyPhrase(pq, card);
}

export async function markVerified(account: Account, address: string, phrase: string): Promise<void> {
  const v = (await readLocal<Record<string, string>>(account, "verified")) ?? {};
  v[address] = phrase;
  await writeLocal(account, "verified", v);
}
export async function verifiedPhrases(account: Account): Promise<Record<string, string>> {
  return (await readLocal<Record<string, string>>(account, "verified")) ?? {};
}

async function recipientsOf(addresses: string[]) {
  const out: Record<string, Awaited<ReturnType<typeof resolveOwner>>> = {};
  for (const a of addresses) {
    try {
      out[a] = await resolveOwner(a, await cardOf(a));
    } catch (e) {
      const who = (await nameOf(a)) ?? shortAddress(a);
      throw new RoomError(`@${who} cannot be added: ${(e as Error).message}`, "NO_KEY");
    }
  }
  return out;
}

// ---- messages -----------------------------------------------------------------------------

export interface Line {
  seq: bigint;
  hash: string;
  epoch: number;
  at: string;
  expiresAt: string | null;
  /** Set when the message opened and its signature checked out. */
  msg?: { id: string; author: string; sentAt: string; body: RoomBody };
  /** Why it could not be shown. */
  problem?: "no-key" | "bad-signature" | "damaged" | "not-member";
}

const pending = new Map<string, Promise<unknown>>();

async function openLine(roomId: string, keys: Map<bigint, Uint8Array>, row: BatchRow): Promise<Line> {
  const base: Line = { seq: BigInt(row.seq), hash: row.hash, epoch: row.epoch, at: row.at, expiresAt: row.expiresAt };
  const key = keys.get(BigInt(row.epoch));
  if (!key) return { ...base, problem: "no-key" };
  let msg: RoomMessage;
  try {
    const blob = await blobBytes(row.hash);
    const opened = openBatch({ blob, keys: (e) => keys.get(e) });
    if (opened.context !== roomContext(roomId)) return { ...base, problem: "damaged" };
    msg = JSON.parse(fromUtf8(opened.data)) as RoomMessage;
  } catch {
    return { ...base, problem: "damaged" };
  }
  try {
    const pq = await pqKey(msg.signer);
    if (!pq) return { ...base, problem: "bad-signature" };
    const body = verifyRoomMessage(msg, { roomId, epoch: BigInt(row.epoch), pqPublicKey: pq });
    return { ...base, msg: { id: body.msgId, author: msg.signer, sentAt: body.sentAt, body: body.body } };
  } catch {
    return { ...base, problem: "bad-signature" };
  }
}

/** Opened lines are kept locally (encrypted), so reopening a room is instant and survives auto-delete on the server. */
export async function loadLines(
  account: Tokened,
  roomId: string,
  first?: { after: bigint; batches: BatchRow[]; more: boolean; keys: KeysView },
): Promise<Line[]> {
  const stored = (await readLocal<Array<Omit<Line, "seq"> & { seq: string }>>(account, `lines:${roomId}`)) ?? [];
  const lines = new Map<string, Line>(stored.map((l) => [l.hash, { ...l, seq: BigInt(l.seq) }]));
  let after = stored.reduce((m, l) => (BigInt(l.seq) > m ? BigInt(l.seq) : m), 0n);
  // Lines that failed for lack of a key are retried after the keys refresh.
  const retry = [...lines.values()].filter((l) => l.problem === "no-key");
  let keys = await roomKeys(account, roomId, false, first?.keys);
  // A page the caller already has (from /sync) is used only if it starts where the local copy ends.
  let prefetched = first && first.after === after ? { batches: first.batches, more: first.more } : undefined;
  for (;;) {
    const page =
      prefetched ??
      (await api.get<{ batches: BatchRow[]; more: boolean }>(`/rooms/${roomId}/batches?after=${after}`, T(account)));
    prefetched = undefined;
    for (const row of page.batches) {
      if (!keys.has(BigInt(row.epoch))) keys = await roomKeys(account, roomId, true);
      lines.set(row.hash, await openLine(roomId, keys, row));
      after = BigInt(row.seq);
    }
    if (!page.more) break;
  }
  for (const l of retry) {
    if (keys.has(BigInt(l.epoch))) {
      lines.set(
        l.hash,
        await openLine(roomId, keys, {
          seq: l.seq.toString(),
          hash: l.hash,
          epoch: l.epoch,
          at: l.at,
          size: 0,
          expiresAt: l.expiresAt,
        }),
      );
    }
  }
  const out = [...lines.values()].sort((a, b) => (a.seq < b.seq ? -1 : 1));
  await writeLocal(
    account,
    `lines:${roomId}`,
    out.map((l) => ({ ...l, seq: l.seq.toString() })),
  );
  return out;
}

/** Forget a line deleted for everyone (it disappears from the local copy too). */
export async function dropLocalLines(account: Tokened, roomId: string, hashes: string[]): Promise<void> {
  const stored = (await readLocal<Array<{ hash: string }>>(account, `lines:${roomId}`)) ?? [];
  const gone = new Set(hashes);
  await writeLocal(
    account,
    `lines:${roomId}`,
    stored.filter((l) => !gone.has(l.hash)),
  );
}

/** Delete token: derived from the account's own seed, so the author can delete from any device. */
async function deleteToken(account: Account, roomId: string, msgId: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", ab(account.keys.seal.seed), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", k, ab(utf8(`mzk:room-delete:${roomId}:${msgId}`))));
  return toHex(mac);
}

export const newMsgId = () => toBase64Url(randomBytes(12));

/**
 * Seal and send one message under the current epoch key. If the key changed
 * meanwhile (the server answers STALE_EPOCH), refresh the keys and seal again.
 */
export async function postMessage(
  account: Tokened,
  roomId: string,
  body: RoomBody,
  msgId = newMsgId(),
): Promise<{ seq: string; msgId: string; epoch: number }> {
  const parsed = RoomBodySchema.parse(body);
  // One send at a time per room keeps the order the person typed.
  const prev = pending.get(roomId) ?? Promise.resolve();
  const run = prev
    .catch(() => undefined)
    .then(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const keys = await roomKeys(account, roomId, attempt > 0);
        const all = sortedKeys(keys);
        const current = all[all.length - 1];
        if (!current) throw new RoomError("This device has no key for this room yet.", "NO_KEY");
        const signed = signRoomMessage({
          roomId,
          epoch: current.epoch,
          msgId,
          body: parsed,
          author: account.owner.address,
          classical: account.keys.classical,
          pq: account.keys.pq,
        });
        const sealed = sealBatch({
          epochKey: current,
          context: roomContext(roomId),
          batchIndex: nextBatchIndex(),
          data: utf8(JSON.stringify(signed)),
        });
        const up = await api.put<{ hash: string }>("/blobs", sealed.blob, T(account));
        const token = await deleteToken(account, roomId, msgId);
        try {
          const r = await api.post<{ seq: string; epoch: number }>(
            `/rooms/${roomId}/batches`,
            { hash: up.hash, deleteHash: sha256Hex(utf8(token)) },
            T(account),
          );
          return { seq: r.seq, msgId, epoch: r.epoch };
        } catch (e) {
          if (e instanceof ApiFailure && e.code === "STALE_EPOCH") continue;
          throw e;
        }
      }
      throw new RoomError("The room key kept changing. Try again in a moment.", "STALE");
    });
  pending.set(roomId, run);
  return run;
}

export async function deleteForEveryone(account: Tokened, roomId: string, line: Line): Promise<void> {
  const own = line.msg?.author === account.owner.address;
  const token = own && line.msg ? await deleteToken(account, roomId, line.msg.id) : undefined;
  await api.post(`/rooms/${roomId}/batches/${line.hash}/delete`, token ? { token } : {}, T(account));
  if (line.msg) await postMessage(account, roomId, { kind: "delete", target: line.msg.id });
  await dropLocalLines(account, roomId, [line.hash]);
}

/** Encrypt a file in pieces (ciphertext only leaves the device); its key travels inside the sealed room message. */
export async function sealRoomFile(account: Tokened, file: File, onProgress?: (p: number) => void): Promise<FileFacts> {
  const cfg = await api.get<{ chunkBytes: number; maxChunks: number }>("/drop/config");
  return encryptFile({
    source: file,
    name: file.name,
    type: file.type || "application/octet-stream",
    maxBytes: cfg.chunkBytes * cfg.maxChunks,
    onChunk: async (c) => {
      await api.put("/blobs", c.bytes, T(account));
    },
    ...(onProgress ? { onProgress: (d: number) => onProgress(d / Math.max(1, file.size)) } : {}),
  });
}

// ---- membership changes (admins) ----------------------------------------------------------

export type Step = "keys" | "seal" | "chain" | "relay" | "announce";
export const STEP_LABEL: Record<Step, string> = {
  keys: "Reading members' sealing keys from QoreChain",
  seal: "Sealing a new room key to the members",
  chain: "Recording the change on QoreChain",
  relay: "Sharing the sealed key",
  announce: "Telling the room",
};

const chainFriendly = (e: unknown): never => {
  const m = e instanceof Error ? e.message : String(e);
  if (/StaleEpoch/.test(m))
    throw new RoomError("Someone else changed this room at the same moment. Refresh and try again.", "STALE");
  if (/NotRoomAdmin/.test(m)) throw new RoomError("QoreChain says you are not an admin of this room.", "NOT_ADMIN");
  if (/insufficient|balance/i.test(m))
    throw new RoomError("Your account needs a little QOR for the network fee.", "FEE");
  throw e instanceof Error ? e : new RoomError(String(e));
};

export interface CreateArgs {
  name: string;
  description: string;
  type: RoomType;
  members: string[];
  approval: boolean;
  historyDefault: "share" | "hide";
  autoDeleteSeconds: number;
  restrictSaving: boolean;
  photo?: File | undefined;
}

export async function createRoom(
  account: Tokened,
  a: CreateArgs,
  onStep: (s: Step) => void = () => undefined,
): Promise<string> {
  const id = toHex(randomBytes(10));
  const others = [...new Set(a.members)].filter((m) => m !== account.owner.address);
  onStep("keys");
  const recipients = await recipientsOf([account.owner.address, ...others]);
  onStep("seal");
  const manager = new EpochKeyManager({ chainId: CHAIN_ID, purpose: Purpose.room(id), members: recipients });
  const envelope = manager.distribution();
  const up = await api.put<{ hash: string }>("/blobs", envelope, T(account));
  const members: MemberEntry[] = [
    { address: account.owner.address, role: "owner" },
    ...others.map((m) => ({ address: m, role: "member" as const })),
  ];
  onStep("chain");
  const txHash = await createRoomOnChain(
    account.owner,
    roomIdBytes32(id),
    membershipHash(id, 1n, members),
    distributionHash(envelope),
  ).catch(chainFriendly);
  onStep("relay");
  await api.post(
    "/rooms",
    { id, txHash, members, distribution: up.hash, approval: a.approval, autoDeleteSeconds: a.autoDeleteSeconds },
    T(account),
  );
  keyCache.set(cacheKey(account, id), new Map([[1n, manager.currentKey.key]]));
  await writeLocal(account, `keys:${id}`, [{ epoch: "1", key: toBase64Url(manager.currentKey.key) }]);
  onStep("announce");
  const photo = a.photo ? await sealRoomFile(account, a.photo) : undefined;
  await postMessage(account, id, { kind: "created", members: others });
  await postMessage(account, id, {
    kind: "info",
    name: a.name.trim(),
    description: a.description.trim(),
    type: a.type,
    ...(photo ? { photo: photo as unknown as Record<string, unknown> } : {}),
  });
  await postMessage(account, id, {
    kind: "settings",
    approval: a.approval,
    autoDeleteSeconds: a.autoDeleteSeconds,
    restrictSaving: a.restrictSaving,
    historyDefault: a.historyDefault,
  });
  return id;
}

export interface Change {
  add?: { address: string; history: "share" | "hide" }[];
  remove?: { address: string; blocked: boolean }[];
  /** Short reason recorded on chain (32 bytes max). */
  reason: string;
  /** Post no "rotated" note (the caller announces it). */
  quiet?: boolean;
}

/** Add or remove people: a new epoch key, sealed to the new member list, recorded on chain. */
export async function changeMembers(
  account: Tokened,
  roomId: string,
  change: Change,
  onStep: (s: Step) => void = () => undefined,
): Promise<number> {
  const detail = await getRoom(account, roomId);
  if (detail.me.role !== "owner" && detail.me.role !== "admin")
    throw new RoomError("Only admins can change who is in the room.", "NOT_ADMIN");
  const add = (change.add ?? []).filter(
    (x) => !detail.members.some((m) => m.address === x.address && m.status === "active"),
  );
  const remove = change.remove ?? [];
  const removing = new Set(remove.map((r) => r.address));
  const active = detail.members.filter((m) => m.status === "active" && !removing.has(m.address));
  for (const r of remove) {
    const m = detail.members.find((x) => x.address === r.address);
    if (m?.role === "owner") throw new RoomError("The owner cannot be removed.");
    if (m?.role === "admin" && detail.me.role !== "owner") throw new RoomError("Only the owner can remove an admin.");
  }
  const next: MemberEntry[] = [
    ...active.map((m) => ({ address: m.address, role: m.role })),
    ...add.map((x) => ({ address: x.address, role: "member" as const })),
  ];
  onStep("keys");
  const current = derive(await loadLines(account, roomId), detail.members, detail.epochs).info;
  const keys = await roomKeys(account, roomId, true);
  const history = sortedKeys(keys);
  const last = history[history.length - 1];
  if (!last || last.epoch !== BigInt(detail.epoch))
    throw new RoomError("This device does not hold the room's current key. Reopen the room and try again.", "NO_KEY");
  const recipients = await recipientsOf(next.map((m) => m.address));
  onStep("seal");
  const manager = new EpochKeyManager({
    chainId: CHAIN_ID,
    purpose: Purpose.room(roomId),
    members: recipients,
    history,
  });
  const rotation = manager.rotate();
  if (!rotation.envelope) throw new RoomError("A room needs at least one member.");
  const up = await api.put<{ hash: string }>("/blobs", rotation.envelope, T(account));
  const admitted: { address: string; history: string | null }[] = [];
  for (const x of add) {
    if (x.history === "share" && history.length > 0) {
      const sealed = sealItem({
        purpose: Purpose.roomHistory(roomId),
        readers: [recipients[x.address] as NonNullable<(typeof recipients)[string]>],
        plaintext: utf8(JSON.stringify(history.map((k) => ({ epoch: k.epoch.toString(), key: toBase64Url(k.key) })))),
      });
      const h = await api.put<{ hash: string }>("/blobs", sealed.envelope, T(account));
      admitted.push({ address: x.address, history: h.hash });
    } else admitted.push({ address: x.address, history: null });
  }
  onStep("chain");
  const rid = roomIdBytes32(roomId);
  for (const r of remove) {
    const m = detail.members.find((x) => x.address === r.address);
    if (m?.role === "admin")
      await setRoleOnChain(account.owner, rid, evm(r.address), ROOM_ROLE.none).catch(chainFriendly);
  }
  const epoch = rotation.epoch;
  const txHash = await rotateRoomOnChain(
    account.owner,
    rid,
    epoch,
    membershipHash(roomId, epoch, next),
    distributionHash(rotation.envelope),
    change.reason,
  ).catch(chainFriendly);
  onStep("relay");
  await api.post(
    `/rooms/${roomId}/epochs`,
    {
      epoch: Number(epoch),
      txHash,
      reason: change.reason,
      members: next,
      distribution: up.hash,
      admitted,
      removed: remove,
    },
    T(account),
  );
  keys.set(epoch, manager.currentKey.key);
  await writeLocal(
    account,
    `keys:${roomId}`,
    sortedKeys(keys).map((k) => ({ epoch: k.epoch.toString(), key: toBase64Url(k.key) })),
  );
  onStep("announce");
  // The room's name, photo and rules live in signed messages; re-post them under the new key so anyone
  // who joins without past messages still sees them. Derived views ignore a re-post that changes nothing.
  if (current.name) {
    await postMessage(account, roomId, {
      kind: "info",
      name: current.name,
      description: current.description,
      type: current.type,
      ...(current.photo ? { photo: current.photo as unknown as Record<string, unknown> } : {}),
    });
    await postMessage(account, roomId, {
      kind: "settings",
      approval: current.approval,
      autoDeleteSeconds: current.autoDeleteSeconds,
      restrictSaving: current.restrictSaving,
      historyDefault: current.historyDefault,
    });
  }
  for (const x of add) await postMessage(account, roomId, { kind: "added", member: x.address, history: x.history });
  for (const r of remove)
    await postMessage(account, roomId, { kind: "removed", member: r.address, blocked: r.blocked });
  if (add.length === 0 && remove.length === 0 && !change.quiet)
    await postMessage(account, roomId, { kind: "rotated", reason: change.reason });
  return Number(epoch);
}

/** After someone left: a new key they do not get. Admin devices do this when they open the room. */
export async function rotateAfterLeave(account: Tokened, roomId: string): Promise<number> {
  const detail = await getRoom(account, roomId);
  const gone = detail.members.filter((m) => m.status === "left" && m.lastEpoch === detail.epoch);
  const epoch = await changeMembers(account, roomId, { reason: "left", quiet: true });
  for (const g of gone) await postMessage(account, roomId, { kind: "rotated", reason: `left:${g.address}` });
  return epoch;
}

/** Let pending requests in automatically (rooms with approval off), using the room's default history choice. */
export async function admitWaiting(account: Tokened, roomId: string, history: "share" | "hide"): Promise<number> {
  const r = await api.get<{ requests: JoinRequest[] }>(`/rooms/${roomId}/requests`, T(account));
  if (r.requests.length === 0) return 0;
  await changeMembers(account, roomId, {
    add: r.requests.map((q) => ({ address: q.address, history })),
    reason: "joined",
  });
  return r.requests.length;
}

export async function setRole(
  account: Tokened,
  roomId: string,
  member: string,
  role: "member" | "admin",
  permissions: Permission[],
): Promise<void> {
  const detail = await getRoom(account, roomId);
  const target = detail.members.find((m) => m.address === member && m.status === "active");
  if (!target) throw new RoomError("That person is not in this room.");
  if (target.role !== role) {
    if (detail.me.role !== "owner") throw new RoomError("Only the owner can make or dismiss admins.");
    await setRoleOnChain(
      account.owner,
      roomIdBytes32(roomId),
      evm(member),
      role === "admin" ? ROOM_ROLE.admin : ROOM_ROLE.none,
    ).catch(chainFriendly);
  }
  await api.post(`/rooms/${roomId}/role`, { member, role, permissions }, T(account));
  await postMessage(account, roomId, { kind: "role", member, role, permissions });
}

export async function transferOwnership(account: Tokened, roomId: string, newOwner: string): Promise<void> {
  await transferRoomOnChain(account.owner, roomIdBytes32(roomId), evm(newOwner)).catch(chainFriendly);
  await api.post(`/rooms/${roomId}/transfer`, { newOwner }, T(account));
  await postMessage(account, roomId, { kind: "role", member: newOwner, role: "owner", permissions: [...PERMISSIONS] });
}

export async function deleteRoom(account: Tokened, roomId: string): Promise<void> {
  await closeRoomOnChain(account.owner, roomIdBytes32(roomId)).catch(chainFriendly);
  await api.post(`/rooms/${roomId}/close`, {}, T(account));
}

export async function leaveRoom(account: Tokened, roomId: string): Promise<void> {
  await postMessage(account, roomId, { kind: "left", member: account.owner.address }).catch(() => undefined);
  await api.post(`/rooms/${roomId}/leave`, {}, T(account));
}

export async function saveSettings(
  account: Tokened,
  roomId: string,
  s: { approval: boolean; autoDeleteSeconds: number; restrictSaving: boolean; historyDefault: "share" | "hide" },
): Promise<void> {
  await api.post(
    `/rooms/${roomId}/settings`,
    { approval: s.approval, autoDeleteSeconds: s.autoDeleteSeconds },
    T(account),
  );
  await postMessage(account, roomId, { kind: "settings", ...s });
}

export async function saveInfo(
  account: Tokened,
  roomId: string,
  info: { name: string; description: string; type: RoomType; photo?: FileFacts | undefined },
): Promise<void> {
  await postMessage(account, roomId, {
    kind: "info",
    name: info.name.trim(),
    description: info.description.trim(),
    type: info.type,
    ...(info.photo ? { photo: info.photo as unknown as Record<string, unknown> } : {}),
  });
}

// ---- reads --------------------------------------------------------------------------------

export const listRooms = (account: Tokened) =>
  api.get<{ rooms: RoomListItem[]; waiting: { roomId: string; at: string; status: "pending" | "declined" }[] }>(
    "/rooms",
    T(account),
  );
export const getRoom = (account: Tokened, roomId: string) => api.get<RoomDetail>(`/rooms/${roomId}`, T(account));

/** Where this device's copy of a room ends (the last sequence number it opened). */
export async function localEnd(account: Tokened, roomId: string): Promise<bigint> {
  const stored = (await readLocal<Array<{ seq: string }>>(account, `lines:${roomId}`)) ?? [];
  return stored.reduce((m, l) => (BigInt(l.seq) > m ? BigInt(l.seq) : m), 0n);
}

/** One refresh of an open room in one request (room, new batches, keys, join requests), then opened here. */
export async function syncRoom(
  account: Tokened,
  roomId: string,
): Promise<{ detail: RoomDetail; lines: Line[]; requests: JoinRequest[] }> {
  const after = await localEnd(account, roomId);
  const r = await api.get<{
    room: RoomDetail;
    batches: BatchRow[];
    more: boolean;
    keys: KeysView;
    requests: JoinRequest[];
  }>(`/rooms/${roomId}/sync?after=${after}`, T(account));
  const lines = await loadLines(account, roomId, { after, batches: r.batches, more: r.more, keys: r.keys });
  return { detail: r.room, lines, requests: r.requests };
}
export const getRequests = (account: Tokened, roomId: string) =>
  api.get<{ requests: JoinRequest[] }>(`/rooms/${roomId}/requests`, T(account));
export const declineRequest = (account: Tokened, roomId: string, address: string) =>
  api.patch(`/rooms/${roomId}/requests/${address}`, { status: "declined" }, T(account));
export const suggestMembers = (account: Tokened, roomId: string, addresses: string[]) =>
  api.post(`/rooms/${roomId}/requests`, { addresses }, T(account));
export const markRead = (account: Tokened, roomId: string, seq: bigint) =>
  api.post(`/rooms/${roomId}/read`, { seq: seq.toString() }, T(account));
export const setMuted = (account: Tokened, roomId: string, muted: boolean) =>
  api.patch(`/rooms/${roomId}/me`, { muted }, T(account));
export const unblock = (account: Tokened, roomId: string, address: string) =>
  api.del(`/rooms/${roomId}/blocked/${address}`, T(account));
export const forgetRoom = (account: Tokened, roomId: string) => api.del(`/rooms/${roomId}/me`, T(account));
export const cancelRequest = (account: Tokened, roomId: string) => api.del(`/rooms/${roomId}/requests/me`, T(account));

// ---- invites ------------------------------------------------------------------------------

export interface InviteCard {
  name: string;
  type: RoomType;
  description: string;
  invitedBy: string;
  photo?: FileFacts;
}

const inviteSecret = (seed: Uint8Array) => sha256Hex(new Uint8Array([...utf8("mzk:invite-secret:"), ...seed]));

/**
 * A new invite link. Its card (room name, photo, who invited) is sealed to a
 * key that lives only in the link's fragment; the server keeps the hash of a
 * secret derived from that key, so it can check a join without ever seeing it.
 */
export async function createInvite(
  account: Tokened,
  roomId: string,
  card: InviteCard,
  o: { primary: boolean; expiresAt: Date | null; maxUses: number | null },
): Promise<{ id: string; url: string }> {
  const id = toHex(randomBytes(10));
  const seed = newLinkSeed();
  const sealed = sealItem({
    purpose: Purpose.roomInvite(id),
    readers: [publicRecipient(linkKeys(seed))],
    plaintext: utf8(JSON.stringify(card)),
  });
  const up = await api.put<{ hash: string }>("/blobs", sealed.envelope, T(account));
  await api.post(
    `/rooms/${roomId}/invites`,
    {
      id,
      secretHash: sha256Hex(utf8(inviteSecret(seed))),
      card: up.hash,
      primary: o.primary,
      expiresAt: o.expiresAt?.toISOString() ?? null,
      maxUses: o.maxUses,
    },
    T(account),
  );
  return { id, url: inviteUrl(id, seed) };
}

export const inviteUrl = (id: string, seed: Uint8Array) =>
  `${window.location.origin}/join/${id}#k=${toBase64Url(seed)}`;

export const listInvites = (account: Tokened, roomId: string) =>
  api.get<{ invites: InviteRow[] }>(`/rooms/${roomId}/invites`, T(account));
export const revokeInvite = (account: Tokened, roomId: string, id: string) =>
  api.patch(`/rooms/${roomId}/invites/${id}`, { revoked: true }, T(account));

export interface InvitePreview {
  roomId: string;
  card: string;
  state: "ok" | "revoked" | "expired" | "used-up";
  approval: boolean;
  members: number;
  expiresAt: string | null;
  createdBy: string;
  you: string | null;
}

export async function openInvite(
  id: string,
  seedB64: string,
  token?: string,
): Promise<{ preview: InvitePreview; card: InviteCard }> {
  const preview = await api.get<InvitePreview>(`/invites/${id}`, token ? { token } : {});
  const seed = fromBase64Url(seedB64);
  const env = await blobBytes(preview.card);
  const card = JSON.parse(
    fromUtf8(openItem({ purpose: Purpose.roomInvite(id), envelope: env, keys: linkKeys(seed) })),
  ) as InviteCard;
  return { preview, card };
}

export async function joinWithInvite(
  token: string,
  id: string,
  seedB64: string,
): Promise<{ status: "member" | "pending"; roomId: string; approval?: boolean }> {
  return api.post(`/invites/${id}/join`, { secret: inviteSecret(fromBase64Url(seedB64)) }, { token });
}

// ---- people lookup and remembered room cards ------------------------------------------------

/** "@ana", "ana" or a qor1 address → the account, read from the registry on QoreChain. */
export async function lookupPerson(input: string): Promise<{ address: string; name: string | null } | null> {
  const raw = input.trim();
  if (/^qor1[02-9ac-hj-np-z]{38}$/.test(raw)) return { address: raw, name: await nameOf(raw) };
  const name = raw.replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(name)) return null;
  // Read from MizuhikiRegistry on QoreChain, never from our server's word for it (THREAT_MODEL A1).
  const owner = await ownerOfName(name);
  return owner ? { address: owner, name } : null;
}

/**
 * The invite card of a room this person asked to join, kept on this device so
 * the waiting row in the room list can show its name before they are let in.
 */
export async function rememberRoomCard(account: Account, roomId: string, card: InviteCard): Promise<void> {
  const all = (await readLocal<Record<string, InviteCard>>(account, "cards")) ?? {};
  all[roomId] = card;
  await writeLocal(account, "cards", all);
}
export async function roomCards(account: Account): Promise<Record<string, InviteCard>> {
  return (await readLocal<Record<string, InviteCard>>(account, "cards")) ?? {};
}

/** A short summary per room (name, photo, last line) kept on this device for the room list. */
export interface RoomSummary {
  lastSeq: string;
  name: string;
  type: RoomType;
  photo: FileFacts | null;
  preview: { author: string; text: string } | null;
}
export async function readSummaries(account: Account): Promise<Record<string, RoomSummary>> {
  return (await readLocal<Record<string, RoomSummary>>(account, "summaries")) ?? {};
}
export async function writeSummaries(account: Account, s: Record<string, RoomSummary>): Promise<void> {
  await writeLocal(account, "summaries", s);
}

// ---- invite links made on this device -------------------------------------------------------

/**
 * A link's full URL holds its key in the fragment, which the server never sees,
 * so only the device that made a link can show it again. Kept here, encrypted.
 */
export async function rememberInviteUrl(account: Account, inviteId: string, url: string): Promise<void> {
  const all = (await readLocal<Record<string, string>>(account, "invite-urls")) ?? {};
  all[inviteId] = url;
  await writeLocal(account, "invite-urls", all);
}
export async function inviteUrls(account: Account): Promise<Record<string, string>> {
  return (await readLocal<Record<string, string>>(account, "invite-urls")) ?? {};
}
