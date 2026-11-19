/**
 * Spare key and recovery on this device (spec 5.13, ARCHITECTURE 8d).
 *
 * Owner: contacts (signed invite; confirmed after six safety words), pieces of
 * the phrase made here and sealed to each contact, a test run, the offline
 * reader key, cancel. Contact: accept or decline, answer a request by opening
 * their piece and re-sealing it to the new device's one-time key. New device:
 * a one-time key kept in this browser, the request, and rebuilding the phrase.
 */
import {
  Purpose,
  RecoveryAcceptSchema,
  RecoveryInviteSchema,
  combinePhrase,
  deriveAccount,
  fromBase64Url,
  fromHex,
  fromUtf8,
  keyWords,
  openItem,
  randomBytes,
  sealItem,
  seedToWords,
  sha256Hex,
  signRecord,
  splitPhrase,
  toBase64Url,
  toHex,
  utf8,
  wordsToSeed,
  type RecoveryInvite,
  type Signed,
} from "@mizuhiki/core";
import { resolveOwner } from "@mizuhiki/chain";
import { generateSealKeys, sealKeysFromSeed, type SealKeyPair } from "@qorechain/qoreseal";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { idb } from "@/lib/idb";
import { cardOf } from "@/lib/send";
import { purposeFor, type InboxRow } from "@/inbox/model";

export type Tokened = Account & { token: string };
const T = (a: Tokened) => ({ token: a.token });

export { pieceState, strangerRequests } from "./model";
export type { ContactRow, ContactStatus, Mine, OfflineKeyRow, RequestRow, RequestStatus } from "./model";
import type { ContactStatus, Mine, OfflineKeyRow, RequestRow } from "./model";

export class RecoveryError extends Error {}

// ---- owner ----------------------------------------------------------------------------------------

export const loadMine = (a: Tokened) => api.get<Mine>("/owner/recovery", T(a));

export async function inviteContact(a: Tokened, contact: string, note: string): Promise<void> {
  const body = RecoveryInviteSchema.parse({
    v: 1,
    type: "contact-invite",
    owner: a.owner.address,
    contact,
    note: note.trim(),
    at: new Date().toISOString(),
  });
  const invite = signRecord({
    kind: "recovery",
    body,
    signer: a.owner.address,
    classical: a.keys.classical,
    pq: a.keys.pq,
  });
  await api.post("/owner/recovery/contacts", { invite }, T(a));
}
export const confirmContact = (a: Tokened, contact: string) =>
  api.post(`/owner/recovery/contacts/${contact}/confirm`, {}, T(a));
export const removeContact = (a: Tokened, contact: string) => api.del(`/owner/recovery/contacts/${contact}`, T(a));

/**
 * Split the phrase here into one piece per confirmed contact and seal each to
 * that contact's key on chain. The phrase never leaves this device.
 */
export async function sealPieces(
  a: Tokened,
  m: Mine,
  threshold: number,
  onStep: (done: number, total: number) => void = () => undefined,
): Promise<number> {
  const confirmed = m.contacts.filter((c) => c.status === "confirmed");
  if (confirmed.length < 2) throw new RecoveryError("Confirm at least two contacts first.");
  if (threshold < 2 || threshold > confirmed.length)
    throw new RecoveryError("Choose how many pieces are needed: at least 2, and no more than your contacts.");
  const version = m.settings.version + 1;
  const set = await splitPhrase(a.keys.phrase, confirmed.length, threshold);
  const pieces: { contact: string; envelope: string }[] = [];
  for (const [i, c] of confirmed.entries()) {
    onStep(i, confirmed.length);
    const to = await resolveOwner(c.contact, await cardOf(c.contact));
    const share = set.shares[i];
    if (!share) throw new RecoveryError("A piece is missing. Nothing was changed.");
    const s = sealItem({
      purpose: Purpose.recoveryShare(String(version)),
      readers: [to],
      plaintext: share,
      context: c.contact,
      anonymous: true,
    });
    await api.put("/blobs", s.envelope);
    pieces.push({ contact: c.contact, envelope: s.hash });
  }
  onStep(confirmed.length, confirmed.length);
  await api.put("/owner/recovery/pieces", { version, threshold, pieces }, T(a));
  return version;
}

export const markSheet = (a: Tokened, which: "sheet" | "offlineSheet") =>
  api.post("/owner/recovery/marks", { [which]: true }, T(a));
export const cancelRequest = (a: Tokened, id: string) => api.post(`/owner/recovery/requests/${id}/cancel`, {}, T(a));

// ---- one-time keys (test runs and new devices) -----------------------------------------------------

interface OneTime {
  keys: SealKeyPair;
  secret: string;
  recipient: { mlkem: string; x25519: string };
  secretHash: string;
}
function oneTime(seed?: Uint8Array): OneTime {
  const keys = seed ? sealKeysFromSeed(seed) : generateSealKeys();
  const secret = toBase64Url(randomBytes(32));
  return {
    keys,
    secret,
    recipient: { mlkem: toHex(keys.mlkemPublicKey), x25519: toHex(keys.x25519PublicKey) },
    secretHash: sha256Hex(utf8(secret)),
  };
}

/** The words a contact compares before answering: from the one-time key of the request. */
export const requestWords = (r: { recipient: { mlkem: string; x25519: string } }) =>
  keyWords({ mlkemPublicKey: fromHex(r.recipient.mlkem), x25519PublicKey: fromHex(r.recipient.x25519) });

export interface PublicRequest extends RequestRow {
  name: string | null;
  pieces: string[];
}
const getRequest = (id: string, secret: string) =>
  api.get<PublicRequest>(`/recovery/requests/${id}`, { headers: { "x-recovery-secret": secret } });

/** Open the released pieces with the one-time key and rebuild the phrase. */
async function rebuild(r: PublicRequest, keys: SealKeyPair): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const h of r.pieces)
    parts.push(openItem({ purpose: Purpose.recoveryAnswer(r.id), envelope: await api.bytes(`/blobs/${h}`), keys }));
  return combinePhrase(parts, r.threshold);
}

export interface TestRun {
  id: string;
  words: string;
  one: OneTime;
}
export async function startTest(a: Tokened): Promise<TestRun> {
  const one = oneTime();
  const { id } = await api.post<{ id: string }>(
    "/owner/recovery/test",
    { recipient: one.recipient, secretHash: one.secretHash },
    T(a),
  );
  return { id, words: requestWords(one), one };
}
/** Poll a test run; when enough contacts answered, rebuild and compare with this device's phrase (never shown). */
export async function checkTest(
  a: Tokened,
  run: TestRun,
): Promise<{ request: PublicRequest; result: "waiting" | "passed" | "failed" }> {
  const r = await getRequest(run.id, run.one.secret);
  if (r.status !== "ready") return { request: r, result: "waiting" };
  const ok = await rebuild(r, run.one.keys).then(
    (phrase) => phrase === a.keys.phrase,
    () => false,
  );
  if (ok) await api.post("/owner/recovery/marks", { tested: run.id }, T(a));
  return { request: r, result: ok ? "passed" : "failed" };
}

// ---- contact --------------------------------------------------------------------------------------

export interface Helping {
  owners: {
    owner: string;
    status: ContactStatus;
    invite: Signed<RecoveryInvite>;
    piece: string | null;
    pieceVersion: number | null;
    updatedAt: string;
  }[];
  requests: (RequestRow & { answeredByMe: boolean })[];
}
export const loadHelping = (a: Tokened) => api.get<Helping>("/recovery/helping", T(a));

export async function acceptHelp(a: Tokened, owner: string): Promise<void> {
  const body = RecoveryAcceptSchema.parse({
    v: 1,
    type: "contact-accept",
    owner,
    contact: a.owner.address,
    at: new Date().toISOString(),
  });
  const accept = signRecord({
    kind: "recovery",
    body,
    signer: a.owner.address,
    classical: a.keys.classical,
    pq: a.keys.pq,
  });
  await api.post(`/recovery/helping/${owner}/accept`, { accept }, T(a));
}
export const declineHelp = (a: Tokened, owner: string) => api.post(`/recovery/helping/${owner}/decline`, {}, T(a));

/** Open this contact's piece and re-seal it to the request's one-time key. The piece is never shown. */
export async function answerRequest(a: Tokened, h: Helping, r: RequestRow): Promise<void> {
  const mine = h.owners.find((o) => o.owner === r.owner && o.pieceVersion === r.version && o.piece);
  if (!mine?.piece) throw new RecoveryError("You do not hold a current piece for this person.");
  const piece = openItem({
    purpose: Purpose.recoveryShare(String(r.version)),
    envelope: await api.bytes(`/blobs/${mine.piece}`),
    keys: a.keys.seal,
    context: a.owner.address,
  });
  const s = sealItem({
    purpose: Purpose.recoveryAnswer(r.id),
    readers: [{ mlkemPublicKey: fromHex(r.recipient.mlkem), x25519PublicKey: fromHex(r.recipient.x25519) }],
    plaintext: piece,
    anonymous: true,
  });
  await api.put("/blobs", s.envelope);
  await api.post(`/recovery/requests/${r.id}/answer`, { envelope: s.hash }, T(a));
}

// ---- new device -----------------------------------------------------------------------------------

const PENDING = "recovery-pending";
export interface Pending {
  id: string;
  owner: string;
  who: string;
  secret: string;
  seed: string;
  threshold: number;
}

/** Start a recovery for an @name or address; the one-time key stays in this browser until it is done. */
export async function startRecovery(who: string): Promise<Pending> {
  const one = oneTime();
  const r = await api.post<{ id: string; owner: string; threshold: number }>("/recovery/requests", {
    who: who.trim(),
    recipient: one.recipient,
    secretHash: one.secretHash,
  });
  const p: Pending = {
    id: r.id,
    owner: r.owner,
    who: who.trim().replace(/^@/, ""),
    secret: one.secret,
    seed: toBase64Url(one.keys.seed),
    threshold: r.threshold,
  };
  await idb.set(PENDING, JSON.stringify(p));
  return p;
}
export async function pendingRecovery(): Promise<Pending | null> {
  try {
    const raw = await idb.get<string>(PENDING);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}
export async function forgetRecovery(): Promise<void> {
  await idb.del(PENDING);
}
export const pendingWords = (p: Pending) => requestWords(oneTime(fromBase64Url(p.seed)));
export const pollRecovery = (p: Pending) => getRequest(p.id, p.secret);

/** Rebuild the phrase from the released pieces and check it belongs to the account being recovered. */
export async function finishRecovery(p: Pending, r: PublicRequest): Promise<string> {
  if (r.status !== "ready") throw new RecoveryError("The pieces are not released yet.");
  let phrase: string;
  try {
    phrase = await rebuild(r, sealKeysFromSeed(fromBase64Url(p.seed)));
  } catch {
    throw new RecoveryError(
      "The pieces did not fit together. Ask your contacts to answer again, or use your spare-key sheet.",
    );
  }
  if (deriveAccount(phrase).address.bech32 !== p.owner)
    throw new RecoveryError("The rebuilt phrase belongs to a different account. Nothing was restored.");
  return phrase;
}
export async function markDone(p: Pending): Promise<void> {
  await api.post(`/recovery/requests/${p.id}/done`, {}, { headers: { "x-recovery-secret": p.secret } });
  await forgetRecovery();
}

// ---- offline reader -------------------------------------------------------------------------------

/** Make a new offline reader key: its words are shown once, for the sheet. */
export async function enableOffline(a: Tokened): Promise<{ words: string }> {
  const seed = randomBytes(32);
  const keys = sealKeysFromSeed(seed);
  await api.put(
    "/owner/recovery/offline",
    {
      key: { mlkem: toHex(keys.mlkemPublicKey), x25519: toHex(keys.x25519PublicKey), since: new Date().toISOString() },
    },
    T(a),
  );
  return { words: seedToWords(seed) };
}
export const disableOffline = (a: Tokened) => api.put("/owner/recovery/offline", { key: null }, T(a));

/** Re-seal the owner's inbox items from before the offline key existed to it, from this device. */
export async function copyOlderToOffline(
  a: Tokened,
  key: OfflineKeyRow,
  onStep: (done: number, total: number) => void = () => undefined,
): Promise<number> {
  const rows: InboxRow[] = [];
  for (const box of ["inbox", "archived"] as const) {
    let before: string | undefined;
    for (;;) {
      const page = (
        await api.get<{ rows: InboxRow[] }>(
          `/owner/inbox?box=${box}&limit=200${before ? `&before=${encodeURIComponent(before)}` : ""}`,
          T(a),
        )
      ).rows;
      rows.push(...page);
      if (page.length < 200) break;
      before = page[page.length - 1]?.at;
    }
  }
  const { sources } = await api.get<{ sources: string[] }>("/owner/recovery/offline/items", T(a));
  const have = new Set(sources);
  const since = Date.parse(key.since);
  const todo = rows.filter(
    (r) => r.type === "envelope" && r.envelope && purposeFor(r) && Date.parse(r.at) < since && !have.has(r.envelope),
  );
  const reader = { mlkemPublicKey: fromHex(key.mlkem), x25519PublicKey: fromHex(key.x25519) };
  const out: { source: string; kind: string; ref: string | null; envelope: string; itemAt: string }[] = [];
  for (const [i, r] of todo.entries()) {
    onStep(i, todo.length);
    const purpose = purposeFor(r);
    if (!purpose || !r.envelope) continue;
    try {
      const plain = openItem({ purpose, envelope: await api.bytes(`/blobs/${r.envelope}`), keys: a.keys.seal });
      const s = sealItem({
        purpose: Purpose.offlineCopy,
        readers: [reader],
        plaintext: utf8(
          JSON.stringify({ v: 1, kind: r.kind, ref: r.ref, at: r.at, item: JSON.parse(fromUtf8(plain)) as unknown }),
        ),
        context: r.envelope,
        anonymous: true,
      });
      await api.put("/blobs", s.envelope);
      out.push({ source: r.envelope, kind: r.kind, ref: r.ref, envelope: s.hash, itemAt: r.at });
    } catch {
      // An item this device cannot open (not sealed to the owner) is left out.
    }
  }
  onStep(todo.length, todo.length);
  for (let i = 0; i < out.length; i += 200)
    await api.post("/owner/recovery/offline/items", { items: out.slice(i, i + 200) }, T(a));
  return out.length;
}

export interface OfflineList {
  owner: string;
  live: { source: string; kind: string; ref: string | null; envelope: string; at: string }[];
  copies: { source: string; kind: string; ref: string | null; envelope: string; at: string }[];
}
/** Prove the offline key by opening the server's challenge, then fetch what it may read. */
export async function offlineItems(who: string, words: string): Promise<{ keys: SealKeyPair; list: OfflineList }> {
  const keys = sealKeysFromSeed(wordsToSeed(words));
  const ch = await api.post<{ id: string; owner: string; challenge: string }>("/recovery/offline/challenge", {
    who: who.trim(),
  });
  let nonce: string;
  try {
    nonce = fromUtf8(
      openItem({ purpose: Purpose.offlineChallenge, envelope: fromBase64Url(ch.challenge), keys, context: ch.id }),
    );
  } catch {
    throw new RecoveryError("Those words do not open this account's offline reader. Check each word and its order.");
  }
  const list = await api.post<OfflineList>("/recovery/offline/items", { id: ch.id, nonce });
  return { keys, list };
}
