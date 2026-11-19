/**
 * Passes on this device (spec 5.12, ARCHITECTURE 8c).
 *
 * Owner: signs an invite whose boundary is written in plain words; after the
 * holder accepts, compares six safety words read from the holder's key on
 * QoreChain, then hands over only what the scope needs:
 *   period  - a scoped seal key of its own (phrase index 2,000,000 + n); its public
 *             half is listed in the signed page so senders seal to it, its seed is
 *             sealed to the holder;
 *   room    - the holder joins the room read-only, with past messages;
 *   form    - the holder becomes a reader of the form's answers;
 *   product - the product key is sealed to the holder.
 * Older items in scope (and invoices, which only the owner seals) are opened here
 * and re-sealed to the holder: "Bring up to date".
 *
 * Holder: accepts with a signature from their own key, then opens what the pass
 * covers with the pass key or their own key.
 */
import {
  PERIOD_KIND_LABEL,
  PassInviteSchema,
  Purpose,
  boundaryText,
  fromBase64Url,
  fromUtf8,
  openContent,
  openItem,
  randomBytes,
  sealItem,
  signRecord,
  toBase64Url,
  utf8,
  verifyRecord,
  type Content,
  type FormDef,
  type PassAccept,
  type PassInvite,
  type PassScope,
  type PeriodKind,
  type Signed,
} from "@mizuhiki/core";
import { pqKeyViaEvm, resolveOwner } from "@mizuhiki/chain";
import { deriveSealKeys, sealKeysFromSeed, type SealKeyPair } from "@qorechain/qoreseal";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { cardOf } from "@/lib/send";
import { forgetPassKeys } from "@/lib/passKeys";
import { openRowWith, parseOpened, purposeFor, type Opened } from "@/inbox/model";
import { openPrivate, type InvoiceDoc, type InvoiceRecord } from "@/invoices/model";

export type Tokened = Account & { token: string };
export type PassStatus = "invited" | "accepted" | "active" | "expired" | "revoked" | "declined";

export interface PassView {
  id: string;
  owner: string;
  holder: string;
  invite: Signed<PassInvite>;
  accept: Signed<PassAccept> | null;
  status: PassStatus;
  keyEnvelope: string | null;
  expiresAt: string | null;
  createdAt: string;
  acceptedAt: string | null;
  confirmedAt: string | null;
  revokedAt: string | null;
  resealed?: number;
}

export class PassError extends Error {}

const newId = () => `pass_${toBase64Url(randomBytes(12))}`;

// ---- lists ---------------------------------------------------------------------------------------

export async function ownedPasses(a: Tokened): Promise<{ passes: PassView[]; nextKeyIndex: number }> {
  return api.get("/owner/passes", { token: a.token });
}
export async function heldPasses(a: Tokened): Promise<PassView[]> {
  return (await api.get<{ passes: PassView[] }>("/passes/mine", { token: a.token })).passes;
}
export async function getPass(a: Tokened, id: string): Promise<PassView> {
  return api.get(`/passes/${encodeURIComponent(id)}`, { token: a.token });
}

export { periodKeysOf } from "./model";

// ---- owner: invite -------------------------------------------------------------------------------

export interface NewPass {
  holder: string;
  scope:
    | { kind: "period"; from: string; until: string; kinds: PeriodKind[] }
    | { kind: "room"; roomId: string; label: string }
    | { kind: "form"; formId: string; label: string }
    | { kind: "product"; productId: string; label: string };
  expiresAt: string | null;
  note: string;
}

export function scopeOf(input: NewPass["scope"], keyIndex: number): PassScope {
  return input.kind === "period" ? { ...input, keyIndex } : input;
}

export async function createPass(a: Tokened, input: NewPass): Promise<PassView> {
  const { nextKeyIndex } = await ownedPasses(a);
  const scope = scopeOf(input.scope, nextKeyIndex);
  const body = PassInviteSchema.parse({
    v: 1,
    type: "invite",
    id: newId(),
    owner: a.owner.address,
    holder: input.holder,
    scope,
    expiresAt: input.expiresAt,
    boundary: boundaryText(scope, input.expiresAt),
    note: input.note.trim(),
    createdAt: new Date().toISOString(),
  });
  const invite = signRecord({ kind: "pass", body, signer: a.owner.address, classical: a.keys.classical, pq: a.keys.pq });
  await api.post("/passes", { invite }, { token: a.token });
  return getPass(a, body.id);
}

// ---- holder: accept or decline -------------------------------------------------------------------

export async function acceptPass(a: Tokened, p: PassView): Promise<void> {
  const body: PassAccept = { v: 1, type: "accept", id: p.id, holder: a.owner.address, at: new Date().toISOString() };
  const accept = signRecord({ kind: "pass", body, signer: a.owner.address, classical: a.keys.classical, pq: a.keys.pq });
  await api.post(`/passes/${p.id}/accept`, { accept }, { token: a.token });
}
export async function declinePass(a: Tokened, p: PassView): Promise<void> {
  await api.post(`/passes/${p.id}/decline`, {}, { token: a.token });
}

// ---- owner: confirm, revoke, bring up to date ----------------------------------------------------

export type ConfirmStep = "keys" | "seal" | "room" | "form" | "page" | "catchup";

/**
 * After the safety words matched. `hooks` connect the parts of the product a
 * scope touches; each is the same code those screens use.
 */
export interface ConfirmHooks {
  /** Re-sign the page so senders seal new items to the pass key (period passes). */
  publishPassKeys: () => Promise<void>;
  addRoomReader: (roomId: string, holder: string) => Promise<void>;
  removeRoomReader: (roomId: string, holder: string) => Promise<void>;
  setFormReader: (formId: string, holder: string, on: boolean) => Promise<void>;
  productKey: (productId: string) => Promise<{ key: string; content: string | null }>;
}

async function holderRecipient(holder: string) {
  return resolveOwner(holder, await cardOf(holder));
}

export async function confirmPass(a: Tokened, p: PassView, hooks: ConfirmHooks, onStep: (s: ConfirmStep) => void = () => undefined): Promise<void> {
  const scope = p.invite.body.scope;
  let keyEnvelope: string | null = null;
  if (scope.kind === "period" || scope.kind === "product") {
    onStep("keys");
    const to = await holderRecipient(p.holder);
    const secret =
      scope.kind === "period"
        ? { seed: toBase64Url(deriveSealKeys({ mnemonic: a.keys.phrase, index: scope.keyIndex }).seed) }
        : await hooks.productKey(scope.productId);
    onStep("seal");
    const s = sealItem({ purpose: Purpose.pass(p.id), readers: [to], plaintext: utf8(JSON.stringify(secret)), context: "key", anonymous: true });
    await api.put("/blobs", s.envelope);
    keyEnvelope = s.hash;
  }
  if (scope.kind === "room") {
    onStep("room");
    await hooks.addRoomReader(scope.roomId, p.holder);
  }
  if (scope.kind === "form") {
    onStep("form");
    await hooks.setFormReader(scope.formId, p.holder, true);
  }
  await api.post(`/passes/${p.id}/confirm`, { keyEnvelope }, { token: a.token });
  if (scope.kind === "period") {
    onStep("page");
    forgetPassKeys(a.owner.address);
    await hooks.publishPassKeys();
  }
  if (scope.kind === "period" || scope.kind === "form") {
    onStep("catchup");
    await bringUpToDate(a, { ...p, status: "active" });
  }
}

export async function revokePass(a: Tokened, p: PassView, hooks: ConfirmHooks): Promise<void> {
  const scope = p.invite.body.scope;
  await api.post(`/passes/${p.id}/revoke`, {}, { token: a.token });
  const was = p.status === "active" || p.status === "expired";
  if (scope.kind === "room" && was) await hooks.removeRoomReader(scope.roomId, p.holder);
  if (scope.kind === "form" && was) await hooks.setFormReader(scope.formId, p.holder, false);
  if (scope.kind === "period") {
    forgetPassKeys(a.owner.address);
    await hooks.publishPassKeys();
  }
}

interface ItemsView {
  resealed: { source: string; kind: string; envelope: string; itemAt: string }[];
  live: { source: string; kind: string; envelope: string; itemAt: string; ref: string | null }[];
  status: PassStatus;
}

/** A re-sealed copy: the original item's plaintext, sealed to the holder under the pass's purpose. */
interface CopyBody {
  v: 1;
  kind: string;
  ref: string | null;
  at: string;
  /** The original plaintext, as JSON. */
  item: unknown;
}

function windowOf(p: PassView): { from: number; until: number } {
  const s = p.invite.body.scope;
  const ends = [s.kind === "period" ? Date.parse(s.until) : Infinity, p.expiresAt ? Date.parse(p.expiresAt) : Infinity, p.revokedAt ? Date.parse(p.revokedAt) : Infinity];
  return { from: s.kind === "period" ? Date.parse(s.from) : 0, until: Math.min(...ends) };
}

async function sealCopies(a: Tokened, p: PassView, items: { source: string; kind: string; ref: string | null; at: string; item: unknown }[]): Promise<number> {
  if (items.length === 0) return 0;
  const to = await holderRecipient(p.holder);
  const out: { source: string; kind: string; envelope: string; itemAt: string }[] = [];
  for (const i of items) {
    const body: CopyBody = { v: 1, kind: i.kind, ref: i.ref, at: i.at, item: i.item };
    const s = sealItem({ purpose: Purpose.pass(p.id), readers: [to], plaintext: utf8(JSON.stringify(body)), context: i.source, anonymous: true });
    await api.put("/blobs", s.envelope);
    out.push({ source: i.source, kind: i.kind, envelope: s.hash, itemAt: i.at });
  }
  for (let i = 0; i < out.length; i += 200) await api.post(`/passes/${p.id}/items`, { items: out.slice(i, i + 200) }, { token: a.token });
  return out.length;
}

/**
 * Re-seal what the holder cannot open yet: items from before the pass, items a
 * sender's browser did not seal to the pass key, and the owner's invoices.
 */
export async function bringUpToDate(a: Tokened, p: PassView): Promise<{ added: number; covered: number }> {
  const scope = p.invite.body.scope;
  if (scope.kind !== "period" && scope.kind !== "form") return { added: 0, covered: 0 };
  const items = await api.get<ItemsView>(`/passes/${p.id}/items`, { token: a.token });
  const have = new Set(items.resealed.map((r) => r.source));
  const passKeys = scope.kind === "period" ? deriveSealKeys({ mnemonic: a.keys.phrase, index: scope.keyIndex }) : null;
  const todo: { source: string; kind: string; ref: string | null; at: string; item: unknown }[] = [];
  let direct = 0;
  for (const row of items.live) {
    if (have.has(row.source)) continue;
    const purpose = purposeFor(row);
    if (!purpose) continue;
    const bytes = await api.bytes(`/blobs/${row.envelope}`);
    if (passKeys) {
      try {
        openItem({ purpose, envelope: bytes, keys: passKeys });
        direct++;
        continue;
      } catch {
        // Not sealed to the pass key: re-seal from the owner's copy below.
      }
    }
    try {
      const plain = openItem({ purpose, envelope: bytes, keys: a.keys.seal });
      todo.push({ source: row.source, kind: row.kind, ref: row.ref, at: row.itemAt, item: JSON.parse(fromUtf8(plain)) });
    } catch {
      // Not sealed to the owner either (cannot happen for their own inbox); leave it out.
    }
  }
  if (scope.kind === "period" && scope.kinds.includes("invoices")) {
    const w = windowOf(p);
    const { invoices } = await api.get<{ invoices: (InvoiceRecord & { sentAt?: string | null })[] }>("/owner/invoices", { token: a.token });
    for (const rec of invoices) {
      if (rec.state === "draft" || rec.state === "cancelled" || !rec.sentAt) continue;
      const t = Date.parse(rec.sentAt);
      if (t < w.from || t >= w.until || have.has(`invoice:${rec.id}`)) continue;
      try {
        const copy = openPrivate(a, rec.id, await api.bytes(`/blobs/${rec.privateEnvelope}`));
        todo.push({ source: `invoice:${rec.id}`, kind: "invoice", ref: `inv:${rec.id}`, at: rec.sentAt, item: copy.doc });
      } catch {
        // An invoice this device cannot open is skipped; the count below says what is covered.
      }
    }
  }
  const added = await sealCopies(a, p, todo);
  return { added, covered: items.resealed.length + added + direct };
}

/** After an invoice is sent: a copy for each live period pass that covers invoices (best effort; "Bring up to date" repeats it). */
export async function copyInvoiceToPasses(a: Tokened, doc: InvoiceDoc, sentAt: string): Promise<void> {
  const { passes } = await ownedPasses(a);
  const t = Date.parse(sentAt);
  for (const p of passes) {
    const s = p.invite.body.scope;
    if (p.status !== "active" || s.kind !== "period" || !s.kinds.includes("invoices")) continue;
    const w = windowOf(p);
    if (t < w.from || t >= w.until) continue;
    await sealCopies(a, p, [{ source: `invoice:${doc.id}`, kind: "invoice", ref: `inv:${doc.id}`, at: sentAt, item: doc }]);
  }
}

/** "Add a reader" on one inbox item: re-seal it to a pass that covers its kind. */
export async function addItemToPass(a: Tokened, p: PassView, row: { hash: string; kind: string; ref: string | null; at: string; envelope: string }): Promise<void> {
  const purpose = purposeFor(row);
  if (!purpose) throw new PassError("This kind of item cannot be shared with a pass.");
  const plain = openItem({ purpose, envelope: await api.bytes(`/blobs/${row.envelope}`), keys: a.keys.seal });
  await sealCopies(a, p, [{ source: row.hash, kind: row.kind, ref: row.ref, at: row.at, item: JSON.parse(fromUtf8(plain)) }]);
}

// ---- holder: open ---------------------------------------------------------------------------------

export type PassItem =
  | { source: string; kind: "invoice"; at: string; doc: InvoiceDoc }
  | { source: string; kind: string; at: string; opened: Opened }
  | { source: string; kind: string; at: string; error: string };

/** The period key's seed or the product key, opened with the holder's own key. */
export async function passSecret(a: Account, p: PassView): Promise<Record<string, unknown> | null> {
  if (!p.keyEnvelope) return null;
  const plain = openItem({ purpose: Purpose.pass(p.id), envelope: await api.bytes(`/blobs/${p.keyEnvelope}`), keys: a.keys.seal, context: "key" });
  return JSON.parse(fromUtf8(plain)) as Record<string, unknown>;
}

export async function periodKeys(a: Account, p: PassView): Promise<SealKeyPair | null> {
  const s = await passSecret(a, p);
  return typeof s?.seed === "string" ? sealKeysFromSeed(fromBase64Url(s.seed)) : null;
}

export async function openPassItems(a: Tokened, p: PassView): Promise<PassItem[]> {
  const items = await api.get<ItemsView>(`/passes/${p.id}/items`, { token: a.token });
  // Live items are sealed to the period key, or (a form pass) to the holder as one of the form's readers.
  const kind = p.invite.body.scope.kind;
  const keys = kind === "period" ? await periodKeys(a, p) : kind === "form" ? a.keys.seal : null;
  const out: PassItem[] = [];
  const copied = new Set<string>();
  for (const r of items.resealed) {
    copied.add(r.source);
    try {
      const plain = openItem({ purpose: Purpose.pass(p.id), envelope: await api.bytes(`/blobs/${r.envelope}`), keys: a.keys.seal, context: r.source });
      const body = JSON.parse(fromUtf8(plain)) as CopyBody;
      if (body.kind === "invoice") out.push({ source: r.source, kind: "invoice", at: body.at, doc: body.item as InvoiceDoc });
      else {
        const purpose = purposeFor({ kind: body.kind, ref: body.ref });
        out.push({ source: r.source, kind: body.kind, at: body.at, opened: parseOpened({ kind: body.kind, ref: body.ref, at: body.at }, purpose ?? "", utf8(JSON.stringify(body.item))) });
      }
    } catch {
      out.push({ source: r.source, kind: r.kind, at: r.itemAt, error: "This item could not be opened on this device." });
    }
  }
  if (keys)
    for (const r of items.live) {
      if (copied.has(r.source)) continue;
      try {
        out.push({ source: r.source, kind: r.kind, at: r.itemAt, opened: await openRowWith(keys, { kind: r.kind, ref: r.ref, envelope: r.envelope, at: r.itemAt }) });
      } catch {
        out.push({ source: r.source, kind: r.kind, at: r.itemAt, error: "Not shared with this pass yet. The owner can bring the pass up to date." });
      }
    }
  return out.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

/** A product pass: the product's content page, opened with the key sealed to the holder. */
export async function openPassProduct(a: Account, p: PassView): Promise<Content | null> {
  const s = await passSecret(a, p);
  if (typeof s?.key !== "string" || typeof s.content !== "string") return null;
  const scope = p.invite.body.scope;
  if (scope.kind !== "product") return null;
  return openContent(fromBase64Url(s.key), scope.productId, await api.bytes(`/blobs/${s.content}`));
}

/** A form's questions, for labelling answers the holder opens; checked against the owner's key on chain. */
export async function formDefFor(owner: string, formId: string): Promise<FormDef> {
  const { record } = await api.get<{ record: Signed<FormDef> }>(`/forms/id/${encodeURIComponent(formId)}`);
  const pq = await pqKeyViaEvm(owner);
  if (!pq.registered || !pq.publicKey || !pq.possessionProven) throw new PassError("The owner's key is not on QoreChain.");
  return verifyRecord(record, { kind: "form", signer: owner, pqPublicKey: pq.publicKey });
}

// ---- words ---------------------------------------------------------------------------------------

export const scopeKindLabel = (s: PassScope): string =>
  s.kind === "period" ? s.kinds.map((k) => PERIOD_KIND_LABEL[k]).join(", ") : s.kind === "room" ? `Room: ${s.label}` : s.kind === "form" ? `Form: ${s.label}` : `Product: ${s.label}`;
