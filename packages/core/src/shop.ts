/**
 * Shop (spec 5.11, ARCHITECTURE 8b): the public product record, the sealed
 * content page, order references that bind the buyer's key, the one total
 * function every party uses, and the delivery payload.
 */
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalJson } from "./canonical";
import { ab, fromBase64Url, fromUtf8, randomBytes, toBase64Url, toHex, utf8 } from "./bytes";
import { MizuhikiError } from "./errors";
import { TOKENS } from "./manifest";

export const PRODUCT_KINDS = ["file", "course", "report", "bundle", "call", "commission", "tip"] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export const KIND_INFO: Record<ProductKind, { group: "Products" | "Services"; label: string; line: string }> = {
  file: { group: "Products", label: "Digital file", line: "Any set of files to download or stream." },
  course: {
    group: "Products",
    label: "Course or tutorial",
    line: "Sell a single lesson or a whole course, page by page.",
  },
  report: { group: "Products", label: "Report or dataset", line: "Sealed to each buyer, so only they can open it." },
  bundle: { group: "Products", label: "Bundle", line: "Two or more of your products for one price." },
  call: { group: "Services", label: "Booking or call", line: "Let people book a time with you." },
  commission: {
    group: "Services",
    label: "Commission with deposit",
    line: "A deposit now, the rest when the work is done.",
  },
  tip: { group: "Services", label: "Tip jar", line: "Let people support you with any amount." },
};

export type ShopToken = (typeof TOKENS)[number];
/** Must match DENOMS in packages/chain/src/config.ts (checked by a unit test). */
export const TOKEN_DECIMALS: Record<ShopToken, number> = { fUSD: 6, QOR: 6 };

const id = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/);
const amount = z.string().regex(/^\d{1,40}$/); // base units
const addr = z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);

export const VersionSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(""),
  /** Added to the base price, base units. */
  extra: amount.default("0"),
  /** Most purchases of this version, or null for no limit. */
  max: z.number().int().min(1).max(1_000_000).nullable().default(null),
});
export type Version = z.infer<typeof VersionSchema>;

export const WeeklyHours = z.object({
  /** 0 = Sunday. */
  day: z.number().int().min(0).max(6),
  /** Minutes from midnight in the seller's time zone. */
  from: z.number().int().min(0).max(1440),
  to: z.number().int().min(0).max(1440),
});

export const ProductDefSchema = z.object({
  v: z.literal(1),
  id,
  owner: addr,
  /** The owner's page name (the product lives at /@name/p/<slug>). */
  name: z.string().min(3).max(30),
  slug: z.string().regex(/^[a-z0-9-]{1,48}$/),
  kind: z.enum(PRODUCT_KINDS),
  title: z.string().min(1).max(120),
  /** Plain text with paragraphs; **bold**, *italic* and [links](https://…) are rendered. */
  description: z.string().max(8000).default(""),
  covers: z
    .array(z.object({ hash, type: z.string().max(60) }))
    .max(8)
    .default([]),
  thumbnail: z
    .object({ hash, type: z.string().max(60) })
    .nullable()
    .default(null),
  cta: z.enum(["I want this!", "Buy this", "Pay", "Book a time", "Support"]).default("I want this!"),
  summary: z.string().max(200).default(""),
  details: z
    .array(z.object({ k: z.string().min(1).max(40), v: z.string().max(80) }))
    .max(12)
    .default([]),
  price: z.object({
    token: z.enum(TOKENS),
    amount,
    /** Pay what you want: the buyer chooses, at least `min` (suggestion shown). */
    pwyw: z.object({ min: amount, suggested: amount }).nullable().default(null),
  }),
  versions: z.array(VersionSchema).max(12).default([]),
  limits: z
    .object({
      maxSales: z.number().int().min(1).max(1_000_000).nullable().default(null),
      quantity: z.boolean().default(false),
      showSales: z.boolean().default(false),
    })
    .default({ maxSales: null, quantity: false, showSales: false }),
  refund: z
    .object({ days: z.number().int().min(1).max(365), finePrint: z.string().max(500).default("") })
    .nullable()
    .default(null),
  tips: z.boolean().default(false),
  discountField: z.enum(["available", "never"]).default("available"),
  receipt: z
    .object({ button: z.string().min(1).max(26).default("View content"), message: z.string().max(1000).default("") })
    .default({ button: "View content", message: "" }),
  /** "seller": the seller's own device delivers. "instant": the delivery agent can, and can read the content. */
  delivery: z.enum(["seller", "instant"]).default("seller"),
  agent: addr.nullable().default(null),
  booking: z
    .object({
      minutes: z.number().int().min(10).max(480),
      timezone: z.string().min(1).max(64),
      hours: z.array(WeeklyHours).max(42),
      place: z.string().max(200),
    })
    .nullable()
    .default(null),
  commission: z
    .object({ depositPercent: z.number().int().min(10).max(90) })
    .nullable()
    .default(null),
  bundle: z
    .object({ productIds: z.array(id).min(2).max(20) })
    .nullable()
    .default(null),
  /** SHA-256 of the sealed content blob (the content page encrypted with the product key). */
  content: hash.nullable().default(null),
  version: z.number().int().min(1),
  updatedAt: z.string(),
});
export type ProductDef = z.infer<typeof ProductDefSchema>;

// ---- content page -----------------------------------------------------------------------

export const ContentBlockSchema = z.discriminatedUnion("t", [
  z.object({ t: z.literal("text"), text: z.string().max(20_000) }),
  z.object({ t: z.literal("heading"), text: z.string().max(200) }),
  // Only web links: a "javascript:" or "data:" link in a content page must never be clickable.
  z.object({ t: z.literal("link"), url: z.url({ protocol: /^https?$/ }).max(2000), label: z.string().max(120) }),
  z.object({ t: z.literal("file"), file: z.record(z.string(), z.unknown()) }),
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;
export const ContentSchema = z.object({
  v: z.literal(1),
  pages: z
    .array(z.object({ id, title: z.string().max(120), blocks: z.array(ContentBlockSchema).max(400) }))
    .min(1)
    .max(60),
});
export type Content = z.infer<typeof ContentSchema>;

export const newProductKey = (): Uint8Array => randomBytes(32);

const CONTENT_MAGIC = "mzk:content:v1";

/** Encrypt the content page under the product key (AES-256-GCM, the product id bound as data). */
export async function sealContent(key: Uint8Array, productId: string, content: Content): Promise<Uint8Array> {
  const parsed = ContentSchema.parse(content);
  const k = await crypto.subtle.importKey("raw", ab(key), "AES-GCM", false, ["encrypt"]);
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: ab(iv), additionalData: ab(utf8(`${CONTENT_MAGIC}|${productId}`)) },
      k,
      ab(utf8(canonicalJson(parsed))),
    ),
  );
  const out = new Uint8Array(1 + 12 + ct.length);
  out[0] = 1;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

export async function openContent(key: Uint8Array, productId: string, blob: Uint8Array): Promise<Content> {
  if (blob[0] !== 1 || blob.length < 13 + 16)
    throw new MizuhikiError("TAMPERED", "This content is damaged.", { dataState: "unreadable-here" });
  const k = await crypto.subtle.importKey("raw", ab(key), "AES-GCM", false, ["decrypt"]);
  try {
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: ab(blob.subarray(1, 13)), additionalData: ab(utf8(`${CONTENT_MAGIC}|${productId}`)) },
      k,
      ab(blob.subarray(13)),
    );
    return ContentSchema.parse(JSON.parse(fromUtf8(new Uint8Array(pt))));
  } catch (e) {
    throw new MizuhikiError("TAMPERED", "This content does not open with its key.", {
      dataState: "unreadable-here",
      cause: e,
    });
  }
}

// ---- orders -----------------------------------------------------------------------------

/** Who the purchase is sealed to: a Mizuhiki account (its card, checked on chain) or a buyer key made at checkout. */
export const RecipientSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("account"), address: addr }),
  z.object({
    kind: z.literal("key"),
    mlkem: z
      .string()
      .regex(/^[0-9a-f]+$/)
      .max(4000),
    x25519: z.string().regex(/^[0-9a-f]{64}$/),
  }),
]);
export type OrderRecipient = z.infer<typeof RecipientSchema>;

export const OrderLineSchema = z.object({
  productId: id,
  /** The product record version the buyer saw; delivery uses the price rules of this version. */
  productVersion: z.number().int().min(1),
  versionId: id.nullable().default(null),
  quantity: z.number().int().min(1).max(100).default(1),
  /** Pay what you want or a tip jar: the buyer's chosen amount per item, base units. */
  chosen: amount.nullable().default(null),
  /** A call: the start of the booked slot (ISO, UTC). */
  slot: z.iso.datetime().nullable().default(null),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderRequestSchema = z.object({
  v: z.literal(1),
  seller: addr,
  token: z.enum(TOKENS),
  lines: z.array(OrderLineSchema).min(1).max(20),
  recipient: RecipientSchema,
  /** A gift: the buyer pays, the recipient (another account) receives. */
  gift: z.boolean().default(false),
  /** A tip on top of the order, base units. */
  tip: amount.default("0"),
  discountCode: z.string().max(40).nullable().default(null),
  /** SHA-256 of the buyer's review secret (verified-purchase reviews). */
  reviewHash: hash,
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
});
export type OrderRequest = z.infer<typeof OrderRequestSchema>;

/** The order reference: the first 22 base64url characters of SHA-256 of the canonical request. */
export function orderRef(req: OrderRequest): string {
  return toBase64Url(sha256(utf8(canonicalJson(OrderRequestSchema.parse(req))))).slice(0, 22);
}

/** Commission orders pay twice: the deposit with the order reference, the rest with `<ref>-2`. Refunds use `<ref>-r`. */
export const balanceRef = (ref: string) => `${ref}-2`;
export const refundRef = (ref: string) => `${ref}-r`;

export interface Discount {
  /** Percent off (1–100) or a fixed amount off per order, base units of the order's token. */
  percent: number | null;
  amountOff: string | null;
  /** Products it applies to; empty = all. */
  productIds: string[];
}

export interface TotalLine {
  productId: string;
  title: string;
  version: string | null;
  quantity: number;
  unit: bigint;
  subtotal: bigint;
}

export interface Total {
  lines: TotalLine[];
  subtotal: bigint;
  discount: bigint;
  tip: bigint;
  total: bigint;
  /** For commissions: what is paid now, and what is left for later. */
  dueNow: bigint;
  dueLater: bigint;
}

export class PriceError extends MizuhikiError {
  constructor(message: string) {
    super("INVALID_INPUT", message, { dataState: "nothing-changed" });
  }
}

/**
 * The one total. The buyer's browser shows it, the server records it, and the
 * deliverer checks the payment against it. Products must be the records the
 * lines name (same id and version).
 */
export function orderTotal(req: OrderRequest, products: ProductDef[], discount: Discount | null): Total {
  const lines: TotalLine[] = [];
  let depositShare = 0n;
  for (const line of req.lines) {
    const p = products.find((x) => x.id === line.productId);
    if (!p) throw new PriceError("A product in this order is no longer available.");
    if (p.version !== line.productVersion)
      throw new PriceError(`“${p.title}” changed since you opened it. Review the new price.`);
    if (p.owner !== req.seller) throw new PriceError("Everything in one order must come from the same seller.");
    if (p.price.token !== req.token) throw new PriceError("Everything in one order must be paid in the same token.");
    if (!p.limits.quantity && line.quantity !== 1) throw new PriceError(`“${p.title}” is sold one at a time.`);
    if (p.kind === "call" && !line.slot) throw new PriceError("Pick a time for the call.");
    const v = line.versionId ? p.versions.find((x) => x.id === line.versionId) : null;
    if (line.versionId && !v) throw new PriceError(`That option of “${p.title}” is no longer offered.`);
    if (!line.versionId && p.versions.length > 0) throw new PriceError(`Pick an option of “${p.title}”.`);
    let unit = BigInt(p.price.amount) + BigInt(v?.extra ?? "0");
    if (p.price.pwyw || p.kind === "tip") {
      const min = BigInt(p.price.pwyw?.min ?? p.price.amount);
      const chosen = line.chosen === null ? null : BigInt(line.chosen);
      if (chosen === null) throw new PriceError(`Choose how much to pay for “${p.title}”.`);
      if (chosen < min + BigInt(v?.extra ?? "0"))
        throw new PriceError(`“${p.title}” is at least ${min + BigInt(v?.extra ?? "0")} base units.`);
      unit = chosen;
    } else if (line.chosen !== null) throw new PriceError(`“${p.title}” has a fixed price.`);
    const subtotal = unit * BigInt(line.quantity);
    if (p.kind === "commission" && p.commission)
      depositShare += (subtotal * BigInt(p.commission.depositPercent)) / 100n;
    else depositShare += subtotal;
    lines.push({ productId: p.id, title: p.title, version: v?.name ?? null, quantity: line.quantity, unit, subtotal });
  }
  const subtotal = lines.reduce((n, l) => n + l.subtotal, 0n);
  let off = 0n;
  if (discount) {
    const eligible = lines
      .filter((l) => discount.productIds.length === 0 || discount.productIds.includes(l.productId))
      .reduce((n, l) => n + l.subtotal, 0n);
    off = discount.percent !== null ? (eligible * BigInt(discount.percent)) / 100n : BigInt(discount.amountOff ?? "0");
    if (off > eligible) off = eligible;
  }
  const tip = BigInt(req.tip);
  const total = subtotal - off + tip;
  // Discounts and tips land on what is paid now, so a commission's remainder is never more than its share.
  const later = subtotal - depositShare;
  const dueLater = later > 0n ? (later * (subtotal - off)) / (subtotal === 0n ? 1n : subtotal) : 0n;
  return { lines, subtotal, discount: off, tip, total, dueNow: total - dueLater, dueLater };
}

// ---- delivery ---------------------------------------------------------------------------

export const DeliverySchema = z.object({
  v: z.literal(1),
  ref: z.string(),
  keys: z
    .array(z.object({ productId: id, key: z.string(), content: hash.nullable() }))
    .min(1)
    .max(40),
  deliveredAt: z.string(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export function deliveryPayload(
  ref: string,
  keys: { productId: string; key: Uint8Array; content: string | null }[],
): Uint8Array {
  return utf8(
    JSON.stringify(
      DeliverySchema.parse({
        v: 1,
        ref,
        keys: keys.map((k) => ({ productId: k.productId, key: toBase64Url(k.key), content: k.content })),
        deliveredAt: new Date().toISOString(),
      }),
    ),
  );
}
export function readDelivery(bytes: Uint8Array): {
  ref: string;
  keys: { productId: string; key: Uint8Array; content: string | null }[];
} {
  const d = DeliverySchema.parse(JSON.parse(fromUtf8(bytes)));
  return {
    ref: d.ref,
    keys: d.keys.map((k) => ({ productId: k.productId, key: fromBase64Url(k.key), content: k.content })),
  };
}

/** A verified-purchase review needs this secret's hash on the order; the buyer's device keeps the secret. */
export const reviewHashOf = (secret: string) => toHex(sha256(utf8(`mzk:review:${secret}`)));

/** Amounts for people: "12.5 fUSD". */
export function formatAmount(base: bigint | string, token: ShopToken): string {
  const d = TOKEN_DECIMALS[token];
  const n = typeof base === "string" ? BigInt(base) : base;
  const whole = n / 10n ** BigInt(d);
  const frac = (n % 10n ** BigInt(d)).toString().padStart(d, "0").replace(/0+$/, "");
  return `${whole.toString()}${frac ? `.${frac.slice(0, 6)}` : ""} ${token}`;
}

/** "12.50" → base units; null when it is not a valid amount. */
export function parseAmount(input: string, token: ShopToken): bigint | null {
  const t = input.trim();
  if (!/^\d{1,18}(\.\d{0,18})?$/.test(t)) return null;
  const [w = "0", f = ""] = t.split(".");
  const d = TOKEN_DECIMALS[token];
  if (f.length > d) return null;
  return BigInt(w) * 10n ** BigInt(d) + BigInt(f.padEnd(d, "0") || "0");
}

/**
 * Free call times for one week, from the seller's weekly hours, minus booked
 * slots. Times are computed in the seller's time zone and returned as UTC ISO.
 */
export function callSlots(
  booking: NonNullable<ProductDef["booking"]>,
  weekStart: Date,
  booked: string[],
  now = new Date(),
): string[] {
  const taken = new Set(booked);
  const out: string[] = [];
  for (let d = 0; d < 7; d++) {
    const day = new Date(weekStart.getTime() + d * 86_400_000);
    const local = zonedParts(day, booking.timezone);
    for (const h of booking.hours.filter((x) => x.day === local.weekday)) {
      for (let m = h.from; m + booking.minutes <= h.to; m += booking.minutes) {
        const start = zonedToUtc(local.year, local.month, local.day, Math.floor(m / 60), m % 60, booking.timezone);
        const iso = start.toISOString();
        if (start.getTime() > now.getTime() + 3_600_000 && !taken.has(iso)) out.push(iso);
      }
    }
  }
  return out.sort();
}

function zonedParts(d: Date, tz: string): { year: number; month: number; day: number; weekday: number } {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  });
  const parts = Object.fromEntries(f.formatToParts(d).map((p) => [p.type, p.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday ?? "Sun");
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), weekday: wd };
}

/** The UTC instant of a wall-clock time in a time zone (two passes handle daylight-saving edges). */
export function zonedToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i++) {
    const f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    const p = Object.fromEntries(f.formatToParts(new Date(guess)).map((x) => [x.type, Number(x.value)]));
    const asIf = Date.UTC(p.year ?? year, (p.month ?? month) - 1, p.day ?? day, p.hour ?? hour, p.minute ?? minute);
    guess += Date.UTC(year, month - 1, day, hour, minute) - asIf;
  }
  return new Date(guess);
}
