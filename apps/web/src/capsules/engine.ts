/**
 * Capsules on this device (spec 5.14, ARCHITECTURE 8e).
 *
 * Owner: a working copy sealed to the owner (files, recipients, timing);
 * guardians invited per capsule and confirmed with safety words; arming makes
 * a fresh seed per recipient, seals that recipient's content to it, splits the
 * seed into pieces sealed to each guardian, signs the plan and records its
 * hash on CapsuleVault. Guardian: accept, request (after a wait), and on
 * release re-seal pieces to recipients after checking the plan against the
 * chain. Recipient: gather pieces, rebuild the seed, open only their content.
 */
import {
  CapsuleAcceptSchema,
  CapsuleInviteSchema,
  CapsulePlanSchema,
  MODE_INDEX,
  Purpose,
  combineShares,
  encryptFile,
  fromHex,
  fromUtf8,
  openItem,
  planHash,
  planProblems,
  publicRecipient,
  randomBytes,
  sealItem,
  signRecord,
  splitSecret,
  toHex,
  utf8,
  verifyRecord,
  type CapsuleInvite,
  type CapsuleMode,
  type CapsulePlan,
  type FileFacts,
  type Signed,
} from "@mizuhiki/core";
import {
  cancelCapsuleOnChain,
  chainNow,
  checkInOnChain,
  createCapsuleOnChain,
  finalizeCapsule,
  pqKeyViaEvm,
  readCapsule,
  rejectCapsuleRequest,
  releaseCapsuleNow,
  requestCapsuleRelease,
  resolveOwner,
  setCapsuleGuardiansOnChain,
  type CapsuleOnChain,
} from "@mizuhiki/chain";
import { parseAddress } from "@qorechain/qoresign";
import { sealKeysFromSeed } from "@qorechain/qoreseal";
import type { Address, Hex } from "viem";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { cardOf } from "@/lib/send";
import { failureText } from "@/lib/failure";

export type Tokened = Account & { token: string };
const T = (a: Tokened) => ({ token: a.token });
const evmOf = (a: string) => parseAddress(a).hex as Address;
const hexId = (id: string): Hex => `0x${id}`;

// ---- the owner's working copy ----------------------------------------------------------------------

export interface DraftRecipient {
  address: string;
  name: string | null;
  message: string;
  /** fileIds from the capsule's files this recipient gets. */
  files: string[];
}
export interface CapsuleDraft {
  v: 1;
  id: string;
  label: string;
  mode: CapsuleMode;
  /** at-time: ISO date-time. */
  releaseAt: string | null;
  waitSeconds: number;
  quietSeconds: number;
  accessSeconds: number;
  deleteAfter: boolean;
  threshold: number;
  files: FileFacts[];
  recipients: DraftRecipient[];
}

export function newDraft(): CapsuleDraft {
  return {
    v: 1,
    id: toHex(randomBytes(32)),
    label: "",
    mode: "after-wait",
    releaseAt: null,
    waitSeconds: 14 * 86400,
    quietSeconds: Math.round(12 * 30.4375 * 86400),
    accessSeconds: 90 * 86400,
    deleteAfter: false,
    threshold: 1,
    files: [],
    recipients: [],
  };
}

export async function saveDraft(a: Tokened, d: CapsuleDraft): Promise<void> {
  const s = sealItem({
    purpose: Purpose.capsule(d.id),
    readers: [publicRecipient(a.keys.seal)],
    plaintext: utf8(JSON.stringify(d)),
    context: "draft",
    anonymous: true,
  });
  await api.put("/blobs", s.envelope);
  await api.put(
    "/owner/capsules",
    { id: d.id, label: d.label.trim() || "Untitled capsule", draftEnvelope: s.hash },
    T(a),
  );
}
export async function openDraft(a: Account, id: string, envelope: string): Promise<CapsuleDraft> {
  return JSON.parse(
    fromUtf8(
      openItem({
        purpose: Purpose.capsule(id),
        envelope: await api.bytes(`/blobs/${envelope}`),
        keys: a.keys.seal,
        context: "draft",
      }),
    ),
  ) as CapsuleDraft;
}

/** Encrypt a file here; only its key and facts go into the (sealed) working copy. */
export async function addFile(file: File, onProgress: (p: number) => void): Promise<FileFacts> {
  return encryptFile({
    source: file,
    name: file.name,
    type: file.type,
    maxBytes: 500 * 1024 * 1024,
    onChunk: async (c) => {
      await api.put("/blobs", c.bytes);
    },
    onProgress: (d, t) => onProgress(d / Math.max(1, t)),
  });
}

// ---- lists ----------------------------------------------------------------------------------------

export type GuardianStatus = "invited" | "accepted" | "confirmed" | "declined" | "removed";
export interface OwnedCapsule {
  id: string;
  label: string;
  state: "draft" | "armed" | "cancelled";
  draftEnvelope: string;
  plan: Signed<CapsulePlan> | null;
  armedTx: string | null;
  createdAt: string;
  updatedAt: string;
  guardians: { guardian: string; status: GuardianStatus; invite: Signed<CapsuleInvite>; accept: unknown }[];
  releases: { guardian: string; recipient: string; at: string }[];
}
export const ownedCapsules = async (a: Tokened) =>
  (await api.get<{ capsules: OwnedCapsule[] }>("/owner/capsules", T(a))).capsules;

export interface GuardedCapsule {
  id: string;
  owner: string;
  label: string;
  state: "draft" | "armed" | "cancelled";
  status: GuardianStatus;
  invite: Signed<CapsuleInvite>;
  plan: Signed<CapsulePlan> | null;
  released: { recipient: string; version: number }[];
}
export const guardedCapsules = async (a: Tokened) =>
  (await api.get<{ capsules: GuardedCapsule[] }>("/capsules/guarding", T(a))).capsules;

export interface CapsuleForMe {
  id: string;
  owner: string;
  label: string;
  state: "armed" | "cancelled";
  plan: Signed<CapsulePlan>;
  pieces: { guardian: string; envelope: string; version: number }[];
}
export const capsulesForMe = async (a: Tokened) =>
  (await api.get<{ capsules: CapsuleForMe[] }>("/capsules/for-me", T(a))).capsules;

// ---- guardians ------------------------------------------------------------------------------------

export async function inviteGuardian(
  a: Tokened,
  d: Pick<CapsuleDraft, "id" | "label">,
  guardian: string,
): Promise<void> {
  const body = CapsuleInviteSchema.parse({
    v: 1,
    type: "guardian-invite",
    capsule: d.id,
    owner: a.owner.address,
    guardian,
    label: d.label.trim() || "Untitled capsule",
    at: new Date().toISOString(),
  });
  const invite = signRecord({
    kind: "capsule",
    body,
    signer: a.owner.address,
    classical: a.keys.classical,
    pq: a.keys.pq,
  });
  await api.post(`/owner/capsules/${d.id}/guardians`, { invite }, T(a));
}
export const confirmGuardian = (a: Tokened, id: string, g: string) =>
  api.post(`/owner/capsules/${id}/guardians/${g}/confirm`, {}, T(a));
export const removeGuardian = (a: Tokened, id: string, g: string) =>
  api.del(`/owner/capsules/${id}/guardians/${g}`, T(a));
export const deleteDraft = (a: Tokened, id: string) => api.del(`/owner/capsules/${id}`, T(a));

export async function acceptGuarding(a: Tokened, c: GuardedCapsule): Promise<void> {
  const body = CapsuleAcceptSchema.parse({
    v: 1,
    type: "guardian-accept",
    capsule: c.id,
    owner: c.owner,
    guardian: a.owner.address,
    at: new Date().toISOString(),
  });
  const accept = signRecord({
    kind: "capsule",
    body,
    signer: a.owner.address,
    classical: a.keys.classical,
    pq: a.keys.pq,
  });
  await api.post(`/capsules/${c.id}/accept`, { accept }, T(a));
}
export const declineGuarding = (a: Tokened, id: string) => api.post(`/capsules/${id}/decline`, {}, T(a));

// ---- arming ---------------------------------------------------------------------------------------

/** What blocks arming, in plain words. */
export function armProblems(d: CapsuleDraft, confirmed: string[], armed: boolean): string[] {
  const out: string[] = [];
  if (!d.label.trim()) out.push("Give the capsule a name its guardians and recipients will see.");
  if (d.recipients.length === 0) out.push("Choose at least one recipient.");
  for (const r of d.recipients)
    if (!r.message.trim() && r.files.length === 0)
      out.push(`Give ${r.name ? `@${r.name}` : "each recipient"} a message or a file.`);
  if (confirmed.length === 0) out.push("Add at least one guardian, and confirm them after they accept.");
  if (d.threshold < 1 || d.threshold > Math.max(1, confirmed.length))
    out.push("Choose how many guardians must hand over their pieces.");
  if (!armed && d.mode === "at-time" && (!d.releaseAt || Date.parse(d.releaseAt) < Date.now() + 5 * 60_000))
    out.push("Choose a time at least five minutes from now.");
  return [...new Set(out)];
}

/** One recipient's piece from one guardian: the seed itself (one guardian, or any one is enough) or a Shamir share. */
interface Piece {
  v: 1;
  recipient: string;
  kind: "seed" | "share";
  value: string;
}

export type ArmStep = "content" | "pieces" | "chain" | "sign";

/**
 * Seal everything for the plan and record it on chain: a new capsule is created;
 * an armed one gets a new plan (new seeds, so removed guardians' pieces stop fitting).
 */
export async function arm(
  a: Tokened,
  d: CapsuleDraft,
  confirmed: string[],
  prior: Signed<CapsulePlan> | null,
  onStep: (s: ArmStep) => void,
): Promise<Hex> {
  const problems = armProblems(d, confirmed, prior !== null);
  if (problems.length) throw new Error(problems[0]);
  onStep("content");
  const guardianKeys = await Promise.all(
    confirmed.map(async (g) => ({ g, key: await resolveOwner(g, await cardOf(g)) })),
  );
  const recipients: CapsulePlan["recipients"] = [];
  const pieces: CapsulePlan["pieces"] = [];
  for (const r of d.recipients) {
    const seed = randomBytes(32);
    const files = d.files.filter((f) => r.files.includes(f.fileId));
    const content = sealItem({
      purpose: Purpose.capsule(d.id),
      readers: [publicRecipient(sealKeysFromSeed(seed))],
      plaintext: utf8(JSON.stringify({ v: 1, label: d.label, message: r.message, files, from: a.owner.address })),
      anonymous: true,
    });
    await api.put("/blobs", content.envelope);
    recipients.push({ address: r.address, content: content.hash, files: files.length });
    onStep("pieces");
    const values: Piece[] =
      d.threshold === 1 || confirmed.length === 1
        ? confirmed.map(() => ({ v: 1, recipient: r.address, kind: "seed", value: toHex(seed) }))
        : (await splitSecret(seed, confirmed.length, d.threshold)).shares.map((s) => ({
            v: 1,
            recipient: r.address,
            kind: "share",
            value: toHex(s),
          }));
    for (const [i, { g, key }] of guardianKeys.entries()) {
      const s = sealItem({
        purpose: Purpose.capsuleShare(d.id),
        readers: [key],
        plaintext: utf8(JSON.stringify(values[i])),
        context: r.address,
        anonymous: true,
      });
      await api.put("/blobs", s.envelope);
      pieces.push({ guardian: g, recipient: r.address, envelope: s.hash });
    }
  }
  const releaseAt = d.mode === "at-time" && d.releaseAt ? Math.floor(Date.parse(d.releaseAt) / 1000) : 0;
  const plan = CapsulePlanSchema.parse({
    v: 1,
    id: d.id,
    owner: a.owner.address,
    label: d.label.trim(),
    mode: prior?.body.mode ?? d.mode,
    releaseAt: prior?.body.releaseAt ?? releaseAt,
    waitSeconds: prior?.body.waitSeconds ?? (d.mode === "after-wait" ? d.waitSeconds : 0),
    quietSeconds: prior?.body.quietSeconds ?? (d.mode === "if-quiet" ? d.quietSeconds : 0),
    accessSeconds: prior?.body.accessSeconds ?? d.accessSeconds,
    guardians: confirmed,
    threshold: Math.min(d.threshold, confirmed.length),
    recipients,
    pieces,
    deleteAfter: d.deleteAfter,
    version: (prior?.body.version ?? 0) + 1,
    at: new Date().toISOString(),
  });
  const bad = planProblems(plan);
  if (bad.length) throw new Error(bad[0]);
  onStep("chain");
  const hash = planHash(plan);
  const txHash = prior
    ? await setCapsuleGuardiansOnChain(a.owner, hexId(d.id), confirmed.map(evmOf), plan.threshold, hash)
    : await createCapsuleOnChain(a.owner, {
        id: hexId(d.id),
        mode: MODE_INDEX[plan.mode],
        guardians: confirmed.map(evmOf),
        threshold: plan.threshold,
        releaseAt: BigInt(plan.releaseAt),
        waitSeconds: BigInt(plan.waitSeconds),
        quietSeconds: BigInt(plan.quietSeconds),
        accessSeconds: BigInt(plan.accessSeconds),
        planHash: hash,
      });
  onStep("sign");
  const record = signRecord({
    kind: "capsule",
    body: plan,
    signer: a.owner.address,
    classical: a.keys.classical,
    pq: a.keys.pq,
  });
  await api.put(`/owner/capsules/${d.id}/plan`, { plan: record, txHash }, T(a));
  return txHash;
}

// ---- owner actions on chain -----------------------------------------------------------------------

export const checkIn = (a: Account) => checkInOnChain(a.owner);
export const reject = (a: Account, id: string) => rejectCapsuleRequest(a.owner, hexId(id));
export const approveNow = (a: Account, id: string) => releaseCapsuleNow(a.owner, hexId(id));
export async function cancel(a: Tokened, id: string): Promise<Hex> {
  const tx = await cancelCapsuleOnChain(a.owner, hexId(id));
  await api.post(`/owner/capsules/${id}/cancelled`, {}, T(a));
  return tx;
}
export const requestRelease = (a: Account, id: string) => requestCapsuleRelease(a.owner, hexId(id));
export const chainState = (id: string) => readCapsule(hexId(id));
export { chainNow };

// ---- release ---------------------------------------------------------------------------------------

export type Phase = "armed" | "requested" | "due" | "released" | "expired" | "cancelled" | "none";

/** One word for where a capsule stands, from the chain and the chain's clock. */
export function phaseOf(c: CapsuleOnChain, now: bigint): Phase {
  if (c.status === "none") return "none";
  if (c.status === "cancelled") return "cancelled";
  if (c.status === "released") return now >= c.releasedAt + c.accessSeconds ? "expired" : "released";
  if (c.opensAt !== 0n && now >= c.opensAt) return "due";
  return c.status === "requested" ? "requested" : "armed";
}

/** Check a plan against the owner's key on chain and the hash CapsuleVault keeps. */
async function trustedPlan(plan: Signed<CapsulePlan>, chain: CapsuleOnChain): Promise<CapsulePlan> {
  const pq = await pqKeyViaEvm(plan.signer);
  if (!pq.registered || !pq.publicKey || !pq.possessionProven) throw new Error("The owner's key is not on QoreChain.");
  const body = verifyRecord(plan, { kind: "capsule", signer: plan.body.owner, pqPublicKey: pq.publicKey });
  if (planHash(body).toLowerCase() !== chain.planHash.toLowerCase())
    throw new Error("This plan is not the one recorded on QoreChain. Nothing was handed over.");
  if (!chain.owner || chain.owner.toLowerCase() !== evmOf(body.owner).toLowerCase())
    throw new Error("QoreChain names a different owner. Nothing was handed over.");
  return body;
}

/**
 * The guardian's part, run on its own whenever the dashboard is open: finalise a
 * release whose time has come, then re-seal this guardian's pieces to each
 * recipient. Returns how many pieces were handed over.
 */
/** Capsules this tab has seen finished (cancelled, expired, or every piece handed over): never read again. */
const finished = new Set<string>();

export async function guardianPass(
  a: Tokened,
  list: GuardedCapsule[],
): Promise<{ id: string; handed: number; why?: string }[]> {
  const out: { id: string; handed: number; why?: string }[] = [];
  for (const c of list) {
    if (c.state !== "armed" || !c.plan || c.status !== "confirmed" || finished.has(c.id)) continue;
    // Every piece of the current plan already handed over: nothing left to do, no chain read.
    const version = c.plan.body.version;
    const mine = c.plan.body.pieces.filter((x) => x.guardian === a.owner.address).length;
    if (mine > 0 && c.released.filter((r) => r.version === version).length >= mine) {
      finished.add(c.id);
      continue;
    }
    try {
      let chain = await readCapsule(hexId(c.id));
      const now = await chainNow();
      if (phaseOf(chain, now) === "due") {
        await finalizeCapsule(a.owner, hexId(c.id));
        chain = await readCapsule(hexId(c.id));
      }
      const ph = phaseOf(chain, await chainNow());
      if (ph === "cancelled" || ph === "expired") finished.add(c.id);
      if (ph !== "released") continue;
      const plan = await trustedPlan(c.plan, chain);
      const done = new Set(c.released.filter((r) => r.version === plan.version).map((r) => r.recipient));
      const items: { recipient: string; envelope: string }[] = [];
      for (const p of plan.pieces.filter((x) => x.guardian === a.owner.address && !done.has(x.recipient))) {
        const piece = openItem({
          purpose: Purpose.capsuleShare(c.id),
          envelope: await api.bytes(`/blobs/${p.envelope}`),
          keys: a.keys.seal,
          context: p.recipient,
        });
        const to = await resolveOwner(p.recipient, await cardOf(p.recipient));
        const s = sealItem({
          purpose: Purpose.capsuleShare(c.id),
          readers: [to],
          plaintext: piece,
          context: "release",
          anonymous: true,
        });
        await api.put("/blobs", s.envelope);
        items.push({ recipient: p.recipient, envelope: s.hash });
      }
      if (items.length) await api.post(`/capsules/${c.id}/release`, { version: plan.version, items }, T(a));
      out.push({ id: c.id, handed: items.length });
    } catch (e) {
      out.push({ id: c.id, handed: 0, why: failureText(e, "Not handed over.") });
    }
  }
  return out;
}

export interface Opened {
  label: string;
  message: string;
  files: FileFacts[];
  from: string;
}

/** Gather this recipient's pieces, rebuild their seed, and open only their content. */
export async function openCapsule(a: Tokened, c: CapsuleForMe): Promise<Opened> {
  const chain = await readCapsule(hexId(c.id));
  if (chain.status !== "released") throw new Error("It has not opened yet.");
  const plan = await trustedPlan(c.plan, chain);
  const mine = plan.recipients.find((r) => r.address === a.owner.address);
  if (!mine) throw new Error("This capsule is not for you.");
  const pieces: Piece[] = [];
  for (const p of c.pieces.filter((x) => x.version === plan.version))
    pieces.push(
      JSON.parse(
        fromUtf8(
          openItem({
            purpose: Purpose.capsuleShare(c.id),
            envelope: await api.bytes(`/blobs/${p.envelope}`),
            keys: a.keys.seal,
            context: "release",
          }),
        ),
      ) as Piece,
    );
  const direct = pieces.find((p) => p.kind === "seed" && p.recipient === a.owner.address);
  let seed: Uint8Array;
  if (direct) seed = fromHex(direct.value);
  else {
    const shares = pieces.filter((p) => p.kind === "share" && p.recipient === a.owner.address);
    if (shares.length < plan.threshold)
      throw new Error(`${shares.length} of ${plan.threshold} guardians have handed over their pieces so far.`);
    seed = await combineShares(
      shares.map((p) => fromHex(p.value)),
      plan.threshold,
    );
  }
  const plain = openItem({
    purpose: Purpose.capsule(c.id),
    envelope: await api.bytes(`/blobs/${mine.content}`),
    keys: sealKeysFromSeed(seed),
  });
  return JSON.parse(fromUtf8(plain)) as Opened;
}

/** Finalise a capsule whose time has come (anyone may). */
export const finalize = (a: Account, id: string) => finalizeCapsule(a.owner, hexId(id));
