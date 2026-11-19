/**
 * Invoices on the owner's device (spec 5.6).
 *
 * Two sealed copies per invoice:
 * - the invoice itself, sealed under `mzk:inv:<id>` with the invoice number as
 *   bound context, to the owner, to a per-invoice link key (its seed travels in
 *   the link's fragment) and to the payer when they are a Mizuhiki account;
 * - a private copy for the owner only: the editable document, the memo to self
 *   and the link seed (so the owner can share the link again from any device).
 * The owner signs {id, envelope}; payers check it against the owner's key on chain.
 * Status is worked out here: Paid only when on-chain payments with memo
 * `mzk:inv:<id>` in the invoice's token add up to its total.
 */
import { z } from "zod";
import {
  Purpose,
  fromBase64Url,
  fromUtf8,
  linkKeys,
  newLinkSeed,
  openItem,
  publicRecipient,
  randomBytes,
  sealItem,
  signRecord,
  toBase64Url,
  utf8,
  type FileFacts,
  type RecipientCard,
  type SealRecipient,
} from "@mizuhiki/core";
import { denomBySymbol, fromBaseUnits, resolveOwner, toBaseUnits } from "@mizuhiki/chain";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { SITE_URL } from "@/lib/site";

export const DUE_PRESETS = ["receipt", "none", "date", "10", "15", "30", "45", "60", "90"] as const;
export type DuePreset = (typeof DUE_PRESETS)[number];
export const DUE_LABEL: Record<DuePreset, string> = {
  receipt: "On receipt",
  none: "No due date",
  date: "On a date",
  "10": "In 10 days",
  "15": "In 15 days",
  "30": "In 30 days",
  "45": "In 45 days",
  "60": "In 60 days",
  "90": "In 90 days",
};

const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;
const QTY = /^\d{1,7}(\.\d{1,2})?$/;

export const ItemSchema = z.object({
  id: z.string(),
  name: z.string().max(120),
  qty: z.string().regex(QTY),
  price: z.string().regex(AMOUNT),
  description: z.string().max(1000).default(""),
});
export type Item = z.infer<typeof ItemSchema>;

export const InvoiceDocSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  number: z.string().regex(/^\d{1,8}$/),
  issued: z.string(),
  from: z.object({
    address: z.string(),
    name: z.string().nullable(),
    displayName: z.string().max(80),
    business: z.string().max(120).default(""),
  }),
  billTo: z.object({
    kind: z.enum(["name", "address", "link"]),
    name: z.string().max(40).default(""),
    address: z.string().default(""),
    business: z.string().max(120).default(""),
    label: z.string().max(120).default(""),
  }),
  items: z.array(ItemSchema).max(50),
  discount: z
    .string()
    .regex(/^(\d{1,12}(\.\d{1,6})?)?$/)
    .default(""),
  other: z
    .string()
    .regex(/^(\d{1,12}(\.\d{1,6})?)?$/)
    .default(""),
  otherLabel: z.string().max(60).default(""),
  token: z.enum(["fUSD", "QOR"]),
  due: z.object({ preset: z.enum(DUE_PRESETS), date: z.string().default("") }),
  message: z.string().max(2000).default(""),
  attachments: z.array(z.custom<FileFacts>()).max(5).default([]),
});
export type InvoiceDoc = z.infer<typeof InvoiceDocSchema>;

export interface PrivateCopy {
  v: 1;
  doc: InvoiceDoc;
  memo: string;
  /** base64url link seed, present once sent. */
  linkSeed?: string;
}

export interface InvoiceRecord {
  id: string;
  envelope: string | null;
  privateEnvelope: string;
  state: "draft" | "sent" | "cancelled";
  archived: boolean;
  viewedAt: string | null;
  recordedPaidAt: string | null;
  createdAt: string;
  sentAt: string | null;
  payments: { txHash: string; from: string; denom: string; amount: string; at: string }[];
}

export const decimalsOf = (token: "fUSD" | "QOR"): number => denomBySymbol(token)?.decimals ?? 6;

/** Line and invoice totals in exact base units. */
export function totals(doc: Pick<InvoiceDoc, "items" | "discount" | "other" | "token">): {
  lines: bigint[];
  subtotal: bigint;
  discount: bigint;
  other: bigint;
  total: bigint;
} {
  const d = decimalsOf(doc.token);
  const lines = doc.items.map((it) => {
    if (!AMOUNT.test(it.price) || !QTY.test(it.qty)) return 0n;
    return (toBaseUnits(it.price, d) * toBaseUnits(it.qty, 2)) / 100n;
  });
  const subtotal = lines.reduce((a, b) => a + b, 0n);
  const discount = doc.discount && AMOUNT.test(doc.discount) ? toBaseUnits(doc.discount, d) : 0n;
  const other = doc.other && AMOUNT.test(doc.other) ? toBaseUnits(doc.other, d) : 0n;
  const total = subtotal - discount + other;
  return { lines, subtotal, discount, other, total: total < 0n ? 0n : total };
}

export const money = (units: bigint, token: "fUSD" | "QOR"): string =>
  `${fromBaseUnits(units, decimalsOf(token))} ${token}`;

export function dueDate(doc: Pick<InvoiceDoc, "due" | "issued">, sentAt?: string | null): Date | null {
  const base = new Date(sentAt ?? doc.issued);
  switch (doc.due.preset) {
    case "none":
      return null;
    case "receipt":
      return base;
    case "date":
      return doc.due.date ? new Date(`${doc.due.date}T23:59:59`) : null;
    default: {
      const d = new Date(base);
      d.setDate(d.getDate() + Number(doc.due.preset));
      return d;
    }
  }
}

export type Status = "draft" | "due" | "overdue" | "partly" | "paid" | "recorded" | "cancelled";
export const STATUS_LABEL: Record<Status, string> = {
  draft: "Draft",
  due: "Due",
  overdue: "Overdue",
  partly: "Partly paid",
  paid: "Paid",
  recorded: "Paid (recorded, unverified)",
  cancelled: "Cancelled",
};

export function paidUnits(doc: InvoiceDoc, payments: InvoiceRecord["payments"]): bigint {
  const denom = denomBySymbol(doc.token)?.denom;
  return payments.filter((p) => p.denom === denom).reduce((a, p) => a + BigInt(p.amount), 0n);
}

export function statusOf(
  doc: InvoiceDoc,
  rec: Pick<InvoiceRecord, "state" | "payments" | "recordedPaidAt" | "sentAt">,
  now = new Date(),
): Status {
  if (rec.state === "cancelled") return "cancelled";
  if (rec.state === "draft") return "draft";
  const { total } = totals(doc);
  const paid = paidUnits(doc, rec.payments);
  if (total > 0n && paid >= total) return "paid";
  if (rec.recordedPaidAt) return "recorded";
  if (paid > 0n) return "partly";
  const due = dueDate(doc, rec.sentAt);
  // "On receipt" is due at once but only overdue after a day's grace.
  if (due && now.getTime() > due.getTime() + (doc.due.preset === "receipt" ? 86400_000 : 0)) return "overdue";
  return "due";
}

export function newInvoiceId(): string {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from(randomBytes(14), (x) => a[x % a.length]).join("");
}

export function blankDoc(
  account: Account,
  owner: { name: string | null; displayName: string },
  number: string,
): InvoiceDoc {
  return {
    v: 1,
    id: newInvoiceId(),
    number,
    issued: new Date().toISOString(),
    from: { address: account.owner.address, name: owner.name, displayName: owner.displayName, business: "" },
    billTo: { kind: "link", name: "", address: "", business: "", label: "" },
    items: [{ id: crypto.randomUUID(), name: "", qty: "1", price: "", description: "" }],
    discount: "",
    other: "",
    otherLabel: "",
    token: "fUSD",
    due: { preset: "receipt", date: "" },
    message: "",
    attachments: [],
  };
}

export const numberLabel = (n: string): string => `#${n.padStart(4, "0")}`;

/** Problems that stop Send, in plain words; empty when the invoice can go. */
export function sendProblems(doc: InvoiceDoc): string[] {
  const p: string[] = [];
  if (doc.items.length === 0) p.push("Add at least one item.");
  doc.items.forEach((it, i) => {
    if (!it.name.trim()) p.push(`Item ${i + 1} needs a name.`);
    if (!AMOUNT.test(it.price)) p.push(`Item ${i + 1} needs a price.`);
    if (!QTY.test(it.qty) || Number(it.qty) <= 0) p.push(`Item ${i + 1} needs a quantity above zero.`);
  });
  if (totals(doc).total <= 0n) p.push("The total must be above zero.");
  if (doc.billTo.kind === "name" && !doc.billTo.address) p.push("Pick a Mizuhiki @name to bill, or send it as a link.");
  if (doc.billTo.kind === "address" && !/^qor1[02-9ac-hj-np-z]{38}$/.test(doc.billTo.address))
    p.push("That is not a QoreChain address.");
  if (doc.due.preset === "date" && !doc.due.date) p.push("Pick the due date.");
  return p;
}

// ---- sealing ------------------------------------------------------------------

const privateContext = "private";

export function sealPrivate(account: Account, copy: PrivateCopy): { envelope: Uint8Array; hash: string } {
  const s = sealItem({
    purpose: Purpose.invoice(copy.doc.id),
    readers: [publicRecipient(account.keys.seal)],
    plaintext: utf8(JSON.stringify(copy)),
    context: privateContext,
    anonymous: true,
  });
  return { envelope: s.envelope, hash: s.hash };
}

export function openPrivate(account: Account, id: string, envelope: Uint8Array): PrivateCopy {
  return JSON.parse(
    fromUtf8(openItem({ purpose: Purpose.invoice(id), envelope, keys: account.keys.seal, context: privateContext })),
  ) as PrivateCopy;
}

async function payerRecipient(address: string): Promise<SealRecipient | null> {
  try {
    const { card } = await api.get<{ card: RecipientCard }>(`/cards/${address}`);
    return await resolveOwner(address, card);
  } catch {
    return null; // not a Mizuhiki account: the link key is how they read it
  }
}

export interface SealedInvoice {
  envelope: Uint8Array;
  hash: string;
  readers: number;
  linkSeed: Uint8Array;
  sig: ReturnType<typeof signRecord<{ id: string; envelope: string }>>;
}

export async function sealInvoice(account: Account, doc: InvoiceDoc, linkSeed = newLinkSeed()): Promise<SealedInvoice> {
  const readers: SealRecipient[] = [publicRecipient(account.keys.seal), publicRecipient(linkKeys(linkSeed))];
  if (doc.billTo.address && doc.billTo.address !== account.owner.address) {
    const r = await payerRecipient(doc.billTo.address);
    if (r) readers.push(r);
  }
  const s = sealItem({
    purpose: Purpose.invoice(doc.id),
    readers,
    plaintext: utf8(JSON.stringify(doc)),
    context: doc.number,
    anonymous: true,
  });
  const sig = signRecord({
    kind: "invoice",
    body: { id: doc.id, envelope: s.hash },
    signer: account.owner.address,
    classical: account.keys.classical,
    pq: account.keys.pq,
  });
  return { envelope: s.envelope, hash: s.hash, readers: s.readers, linkSeed, sig };
}

export function invoiceLink(id: string, number: string, seed: Uint8Array | string): string {
  const k = typeof seed === "string" ? seed : toBase64Url(seed);
  return `${SITE_URL}/i/${id}#k=${k}&n=${number}`;
}

export function parseFragment(hash: string): { seed: Uint8Array; number: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const k = p.get("k");
  const n = p.get("n");
  if (!k || !n || !/^\d{1,8}$/.test(n)) return null;
  try {
    const seed = fromBase64Url(k);
    return seed.length === 32 ? { seed, number: n } : null;
  } catch {
    return null;
  }
}

export function openWithLink(id: string, number: string, seed: Uint8Array, envelope: Uint8Array): InvoiceDoc {
  const doc = InvoiceDocSchema.parse(
    JSON.parse(fromUtf8(openItem({ purpose: Purpose.invoice(id), envelope, keys: linkKeys(seed), context: number }))),
  );
  if (doc.id !== id || doc.number !== number) throw new Error("This invoice does not match its link.");
  return doc;
}
