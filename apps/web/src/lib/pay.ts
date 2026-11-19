/**
 * Pay me (spec 5.5), on the payer's device.
 *
 * The note is sealed here to the owner (and to the payer when they have
 * Mizuhiki keys), so its envelope hash is known before paying and goes into
 * the memo `mzk:pay:<ref>:<noteHash>`. Then:
 * - Mizuhiki wallet or QoreX: pay first, deliver the note once the transfer
 *   is confirmed (no note without a payment);
 * - manual: deliver the note first (we cannot know when they pay), then wait
 *   for the payment with this reference to appear.
 * A note that could not be delivered is kept on this device and offered again.
 */
import {
  Purpose,
  buildMemo,
  publicRecipient,
  randomBytes,
  sealItem,
  solvePowAsync,
  toBase64Url,
  fromBase64Url,
  utf8,
  type RecipientCard,
  type SealRecipient,
} from "@mizuhiki/core";
import {
  ChainError,
  NETWORK,
  balanceOf,
  denomBySymbol,
  fromBaseUnits,
  estimateTx,
  getTx,
  msgSend,
  resolveOwner,
  sendTx,
  toBaseUnits,
  type Denom,
} from "@mizuhiki/chain";
import { getQorexNative, type QorexNativeProvider } from "@qorechain/qorex-types";
import type { Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import { passRecipients } from "@/lib/passKeys";
import { idb } from "@/lib/idb";

export type PayToken = "fUSD" | "QOR";
export type PayMethod = "mizuhiki" | "qorex" | "manual";

export interface PayNotePayload {
  v: 1;
  kind: "paynote";
  note: string;
  amount: string;
  tip: string;
  token: PayToken;
  ref: string;
  from?: string;
}

export interface PreparedPayment {
  ref: string;
  memo: string;
  denom: Denom;
  /** Base units, amount plus tip. */
  units: bigint;
  /** Display amounts. */
  amount: string;
  tip: string;
  total: string;
  token: PayToken;
  note: { envelope: Uint8Array; hash: string; readers: number } | null;
}

const REF_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function newRef(): string {
  const b = randomBytes(10);
  return Array.from(b, (x) => REF_ALPHABET[x % REF_ALPHABET.length]).join("");
}

/** "12.5" + 15% → "14.375", exact in base units, trimmed. */
export function addTip(amount: string, tipPercent: number, decimals: number): { tip: string; total: string } {
  const base = toBaseUnits(amount, decimals);
  const tip = (base * BigInt(Math.round(tipPercent * 100))) / 10_000n;
  const fmt = (u: bigint) => {
    const s = u.toString().padStart(decimals + 1, "0");
    const whole = s.slice(0, -decimals);
    const frac = s.slice(-decimals).replace(/0+$/, "");
    return frac ? `${whole}.${frac}` : whole;
  };
  return { tip: fmt(tip), total: fmt(base + tip) };
}

export async function ownerRecipient(address: string, card: RecipientCard | null): Promise<SealRecipient> {
  const c = card ?? (await api.get<{ card: RecipientCard }>(`/cards/${address}`)).card;
  return resolveOwner(address, c);
}

export async function preparePayment(args: {
  owner: { address: string; card: RecipientCard | null };
  token: PayToken;
  amount: string;
  tipPercent: number;
  note: string;
  payer?: Account | undefined;
}): Promise<PreparedPayment> {
  const denom = denomBySymbol(args.token);
  if (!denom) throw new ChainError("REFUSED", "That token is not accepted here. Nothing was sent.");
  const { tip, total } = addTip(args.amount, args.tipPercent, denom.decimals);
  const units = toBaseUnits(total, denom.decimals);
  if (units <= 0n) throw new ChainError("REFUSED", "Enter an amount above zero. Nothing was sent.");
  const ref = newRef();
  let note: PreparedPayment["note"] = null;
  if (args.note.trim()) {
    const readers = [await ownerRecipient(args.owner.address, args.owner.card)];
    if (args.payer && args.payer.owner.address !== args.owner.address)
      readers.push(publicRecipient(args.payer.keys.seal));
    readers.push(...(await passRecipients(args.owner.address, "payments")));
    const payload: PayNotePayload = {
      v: 1,
      kind: "paynote",
      note: args.note.trim(),
      amount: args.amount,
      tip,
      token: args.token,
      ref,
      ...(args.payer ? { from: args.payer.owner.address } : {}),
    };
    const sealed = sealItem({
      purpose: Purpose.payNote,
      readers,
      plaintext: utf8(JSON.stringify(payload)),
      anonymous: true,
    });
    note = { envelope: sealed.envelope, hash: sealed.hash, readers: sealed.readers };
  }
  return {
    ref,
    memo: buildMemo("pay", ref, note?.hash),
    denom,
    units,
    amount: args.amount,
    tip,
    total,
    token: args.token,
    note,
  };
}

/** An invoice payment: amount, token and reference come from the signed invoice and cannot change. */
export function prepareInvoicePayment(inv: { id: string; total: bigint; token: PayToken }): PreparedPayment {
  const denom = denomBySymbol(inv.token);
  if (!denom) throw new ChainError("REFUSED", "This invoice asks for a token that is not accepted. Nothing was sent.");
  const total = fromBaseUnits(inv.total, denom.decimals);
  return {
    ref: inv.id,
    memo: buildMemo("inv", inv.id),
    denom,
    units: inv.total,
    amount: total,
    tip: "0",
    total,
    token: inv.token,
    note: null,
  };
}

// ---- the note: deliver, and keep it here until it is delivered ----------------

interface PendingNote {
  owner: string;
  ownerName: string;
  ref: string;
  hash: string;
  envelope: string;
  txHash?: string;
  at: string;
}
const PENDING_KEY = "pay:pending-notes";

async function pending(): Promise<PendingNote[]> {
  return (await idb.get<PendingNote[]>(PENDING_KEY).catch(() => undefined)) ?? [];
}
async function savePending(list: PendingNote[]): Promise<void> {
  await idb.set(PENDING_KEY, list).catch(() => undefined);
}
export async function pendingNotesFor(owner: string): Promise<PendingNote[]> {
  return (await pending()).filter((p) => p.owner === owner);
}
export async function rememberNote(p: PendingNote): Promise<void> {
  const list = (await pending()).filter((x) => x.hash !== p.hash);
  await savePending([...list, p]);
}
export async function forgetNote(hash: string): Promise<void> {
  await savePending((await pending()).filter((x) => x.hash !== hash));
}

export async function deliverNote(owner: string, ref: string, envelope: Uint8Array, hash: string): Promise<void> {
  const cfg = await api.get<{ powBits: number }>("/drop/config");
  const pow = await solvePowAsync(owner, hash, cfg.powBits);
  const r = await api.post<{ hash: string }>(`/drop/${owner}`, {
    envelope: toBase64Url(envelope),
    kind: "paynote",
    ref: `pay:${ref}`,
    chunks: [],
    pow,
  });
  if (r.hash !== hash)
    throw new ApiFailure(500, "MISMATCH", "The server stored something else than the sealed note.", "unknown");
  await forgetNote(hash);
}

export async function retryPending(p: PendingNote): Promise<void> {
  await deliverNote(p.owner, p.ref, fromBase64Url(p.envelope), p.hash);
}

// ---- paying -----------------------------------------------------------------

export type PayStage = "review" | "signing" | "submitted" | "confirmed" | "note" | "done";

export class PayFailure extends Error {
  readonly moved: "no" | "yes" | "unknown";
  readonly txHash: string | undefined;
  constructor(message: string, moved: "no" | "yes" | "unknown", txHash?: string) {
    super(message);
    this.moved = moved;
    this.txHash = txHash;
  }
}

function asFailure(e: unknown): PayFailure {
  if (e instanceof PayFailure) return e;
  if (e instanceof ChainError) return new PayFailure(e.message, e.moved, e.txHash);
  const msg = (e as Error).message;
  if (/reject|denied|cancel/i.test(msg)) return new PayFailure("You cancelled in the wallet. No money moved.", "no");
  return new PayFailure(msg.startsWith("QoreX") ? msg : "The payment could not be sent. No money moved.", "unknown");
}

export function qorex(): QorexNativeProvider | undefined {
  const q = getQorexNative();
  return q && q.capabilities.includes("signAndBroadcast") ? q : undefined;
}

/** What the Mizuhiki wallet would pay: balance check and the simulated network fee. */
export async function reviewMizuhiki(
  account: Account,
  to: string,
  p: PreparedPayment,
): Promise<{ fee: bigint | null; problem: string | null }> {
  const [balance, qor] = await Promise.all([
    balanceOf(account.owner.address, p.denom.denom),
    balanceOf(account.owner.address, "uqor"),
  ]);
  // Check the balance before simulating: a transfer larger than the balance fails simulation with a
  // generic "insufficient funds" that would otherwise read as a fee problem.
  if (balance < p.units)
    return {
      fee: null,
      problem: `Your Mizuhiki wallet has ${fromBaseUnits(balance, p.denom.decimals)} ${p.token}. Add funds or pay another way. Nothing was sent.`,
    };
  const { fee } = await estimateTx(account.owner, [msgSend(account.owner.address, to, p.denom.denom, p.units)], p.memo);
  const needQor = p.denom.denom === "uqor" ? p.units + fee : fee;
  if (qor < needQor)
    return {
      fee,
      problem:
        p.denom.denom === "uqor"
          ? `Your Mizuhiki wallet has ${fromBaseUnits(qor, 6)} QOR, not enough for this amount plus the ${fromBaseUnits(fee, 6)} QOR network fee. Nothing was sent.`
          : `Your Mizuhiki wallet needs ${fromBaseUnits(fee, 6)} test QOR for the network fee. Nothing was sent.`,
    };
  return { fee, problem: null };
}

export interface PaidResult {
  txHash: string;
  height: string;
  from: string;
  fee: string | null;
  noteDelivered: boolean | null;
}

async function afterPaid(args: {
  owner: string;
  ownerName: string;
  p: PreparedPayment;
  txHash: string;
  onStage: (s: PayStage) => void;
}): Promise<boolean | null> {
  if (!args.p.note) return null;
  args.onStage("note");
  const n = args.p.note;
  try {
    await deliverNote(args.owner, args.p.ref, n.envelope, n.hash);
    return true;
  } catch {
    await rememberNote({
      owner: args.owner,
      ownerName: args.ownerName,
      ref: args.p.ref,
      hash: n.hash,
      envelope: toBase64Url(n.envelope),
      txHash: args.txHash,
      at: new Date().toISOString(),
    });
    return false;
  }
}

export async function payWithMizuhiki(args: {
  account: Account;
  owner: string;
  ownerName: string;
  p: PreparedPayment;
  onStage: (s: PayStage, txHash?: string) => void;
}): Promise<PaidResult> {
  try {
    args.onStage("signing");
    const r = await sendTx(
      args.account.owner,
      [msgSend(args.account.owner.address, args.owner, args.p.denom.denom, args.p.units)],
      args.p.memo,
      {
        onStage: (st, h) => {
          if (st === "submitted") args.onStage("submitted", h);
          if (st === "confirmed") args.onStage("confirmed", h);
        },
      },
    );
    const noteDelivered = await afterPaid({
      owner: args.owner,
      ownerName: args.ownerName,
      p: args.p,
      txHash: r.txHash,
      onStage: args.onStage,
    });
    return {
      txHash: r.txHash,
      height: r.height.toString(),
      from: args.account.owner.address,
      fee: r.fee.toString(),
      noteDelivered,
    };
  } catch (e) {
    throw asFailure(e);
  }
}

export async function payWithQorex(args: {
  owner: string;
  ownerName: string;
  p: PreparedPayment;
  onStage: (s: PayStage, txHash?: string) => void;
}): Promise<PaidResult> {
  const q = qorex();
  if (!q) throw new PayFailure("QoreX was not found in this browser. No money moved.", "no");
  let txHash: string | undefined;
  try {
    await q.enable(NETWORK.chainId);
    const key = await q.getKey(NETWORK.chainId);
    const msg = msgSend(key.bech32Address, args.owner, args.p.denom.denom, args.p.units);
    args.onStage("signing");
    const r = await q.signAndBroadcast({
      chainId: NETWORK.chainId,
      messages: [msg],
      memo: args.p.memo,
    });
    txHash = r.txHash;
    args.onStage("submitted", r.txHash);
    if (r.code !== 0)
      throw new PayFailure(
        "The payment reached the network but failed. Only the network fee was spent.",
        "yes",
        r.txHash,
      );
    // Source of truth: read the committed transaction back from chain.
    const tx = await getTx(r.txHash);
    if (!tx || tx.code !== 0)
      throw new PayFailure(
        "The payment could not be confirmed on chain yet. Check the transaction before paying again.",
        "unknown",
        r.txHash,
      );
    args.onStage("confirmed", r.txHash);
    const noteDelivered = await afterPaid({
      owner: args.owner,
      ownerName: args.ownerName,
      p: args.p,
      txHash: r.txHash,
      onStage: args.onStage,
    });
    return { txHash: r.txHash, height: tx.height, from: key.bech32Address, fee: null, noteDelivered };
  } catch (e) {
    const f = asFailure(e);
    throw txHash && !f.txHash ? new PayFailure(f.message, f.moved === "no" ? "unknown" : f.moved, txHash) : f;
  }
}

/** Manual payment: deliver the note now, then the screen waits for the payment with this reference. */
export async function startManual(args: { owner: string; ownerName: string; p: PreparedPayment }): Promise<void> {
  if (!args.p.note) return;
  const n = args.p.note;
  try {
    await deliverNote(args.owner, args.p.ref, n.envelope, n.hash);
  } catch {
    await rememberNote({
      owner: args.owner,
      ownerName: args.ownerName,
      ref: args.p.ref,
      hash: n.hash,
      envelope: toBase64Url(n.envelope),
      at: new Date().toISOString(),
    });
  }
}

export async function findPayment(
  owner: string,
  ref: string,
): Promise<{ txHash: string; from: string; height: string; denom: string; amount: string } | null> {
  const r = await api.get<{
    payments: { txHash: string; from: string; height: string; denom: string; amount: string }[];
  }>(`/pay/${owner}/${ref}`);
  return r.payments[0] ?? null;
}

export { fromBase64Url };
