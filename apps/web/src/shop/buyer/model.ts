/**
 * Pure helpers for the buyer side of the Shop (spec 5.11): the description
 * renderer's tokens, prices for people, the cart, the call week, and the
 * after-payment steps. No browser APIs here, so all of it is unit-tested.
 */
import { formatAmount, orderTotal, type Discount, type OrderRequest, type ProductDef, type ShopToken } from "@mizuhiki/core";

// ---- description: **bold**, *italic*, [link](https://…), paragraphs ---------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] };

const INLINE = /\*\*([^*\n]+?)\*\*|\*([^*\s\n][^*\n]*?)\*|\[([^\]\n]{1,200})\]\((https:\/\/[^\s)]{1,2000})\)/g;

/** Only absolute https links survive; anything else stays as its literal text. */
export function safeHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname ? u.toString() : null;
  } catch {
    return null;
  }
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  const push = (v: string) => {
    if (!v) return;
    const prev = out[out.length - 1];
    if (prev?.t === "text") prev.v += v;
    else out.push({ t: "text", v });
  };
  for (const m of s.matchAll(INLINE)) {
    const at = m.index;
    push(s.slice(last, at));
    last = at + m[0].length;
    const inner = (x: string) => (depth < 3 ? parseInline(x, depth + 1) : [{ t: "text" as const, v: x }]);
    if (m[1] !== undefined) out.push({ t: "b", c: inner(m[1]) });
    else if (m[2] !== undefined) out.push({ t: "i", c: inner(m[2]) });
    else if (m[3] !== undefined && m[4] !== undefined) {
      const href = safeHref(m[4]);
      if (href) out.push({ t: "a", href, c: inner(m[3]) });
      else push(m[0]);
    }
  }
  push(s.slice(last));
  return out;
}

/** Paragraphs split on blank lines; single line breaks stay inside a paragraph. */
export function paragraphs(s: string): string[][] {
  return s
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.split("\n").map((l) => l.trimEnd()))
    .filter((lines) => lines.some((l) => l.trim()));
}

// ---- prices ----------------------------------------------------------------------------------

/** "12.5 fUSD" without the token, for places that show the token once. */
export const amountOnly = (units: bigint | string, token: ShopToken) => formatAmount(units, token).replace(` ${token}`, "");

/** The lowest price a buyer can pay for one item (base plus the cheapest version, or the pay-what-you-want minimum). */
export function fromPrice(def: ProductDef): bigint {
  const base = BigInt(def.price.pwyw?.min ?? def.price.amount);
  const extras = def.versions.map((v) => BigInt(v.extra));
  return base + (extras.length ? extras.reduce((a, b) => (b < a ? b : a)) : 0n);
}

/** The ribbon text: "5 fUSD", "5 fUSD+" when versions or pay-what-you-want can raise it. */
export function ribbonLabel(def: ProductDef): string {
  const open = !!def.price.pwyw || def.kind === "tip" || def.versions.some((v) => v.extra !== def.versions[0]?.extra);
  const n = fromPrice(def);
  if (n === 0n && !open) return "Free";
  return `${formatAmount(n, def.price.token)}${open ? "+" : ""}`;
}

/** Price of one item with the chosen version and amount; null when the chosen amount is missing or too low. */
export function unitPrice(def: ProductDef, versionId: string | null, chosen: bigint | null): bigint | null {
  const v = versionId ? def.versions.find((x) => x.id === versionId) : undefined;
  const extra = BigInt(v?.extra ?? "0");
  if (def.price.pwyw || def.kind === "tip") {
    const min = BigInt(def.price.pwyw?.min ?? def.price.amount) + extra;
    if (chosen === null || chosen < min) return null;
    return chosen;
  }
  return BigInt(def.price.amount) + extra;
}

/** The least a buyer may pay for one pay-what-you-want item with this version. */
export function minAmount(def: ProductDef, versionId: string | null): bigint {
  const extra = BigInt((versionId ? def.versions.find((x) => x.id === versionId)?.extra : undefined) ?? "0");
  return BigInt(def.price.pwyw?.min ?? def.price.amount) + extra;
}

/** The suggested amount for a pay-what-you-want item, never below the minimum. */
export function suggestedAmount(def: ProductDef, versionId: string | null): bigint {
  const extra = BigInt((versionId ? def.versions.find((x) => x.id === versionId)?.extra : undefined) ?? "0");
  const min = BigInt(def.price.pwyw?.min ?? def.price.amount) + extra;
  const sug = BigInt(def.price.pwyw?.suggested ?? def.price.amount) + extra;
  return sug > min ? sug : min;
}

/** Average rating rounded to one decimal, "4.5". */
export const ratingLabel = (avg: number | null) => (avg === null ? "" : (Math.round(avg * 10) / 10).toFixed(1));

/** Fingerprint for people: hex in groups of four, the first 24 characters. */
export function fingerprint(hex: string, n = 24): string {
  return (hex.slice(0, n).match(/.{1,4}/g) ?? []).join(" ");
}

// ---- cart ------------------------------------------------------------------------------------

export interface CartLine {
  productId: string;
  slug: string;
  title: string;
  /** The record version the buyer configured; checkout re-prices against the current one and says so. */
  productVersion: number;
  versionId: string | null;
  quantity: number;
  /** Pay what you want or tip: base units per item. */
  chosen: string | null;
  /** A call: slot start, UTC ISO. */
  slot: string | null;
}

export interface Cart {
  v: 1;
  /** The seller's page name and address; one cart per seller. */
  name: string;
  seller: string;
  token: ShopToken;
  lines: CartLine[];
}

export const cartKey = (name: string) => `mzk:cart:${name}`;
export const MAX_LINES = 20;

export function parseCart(raw: string | null, name: string): Cart | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<Record<keyof Cart, unknown>> & Cart;
    const v: unknown = c.v;
    const tok: unknown = c.token;
    if (v !== 1 || c.name !== name || !Array.isArray(c.lines) || (tok !== "fUSD" && tok !== "QOR")) return null;
    const lines = c.lines.filter(
      (l) =>
        typeof l.productId === "string" &&
        typeof l.slug === "string" &&
        Number.isInteger(l.quantity) &&
        l.quantity >= 1 &&
        l.quantity <= 100 &&
        (l.chosen === null || /^\d{1,40}$/.test(l.chosen)),
    );
    return lines.length ? { ...c, lines: lines.slice(0, MAX_LINES) } : null;
  } catch {
    return null;
  }
}

export type AddResult = { ok: true; cart: Cart } | { ok: false; reason: "token" | "full" | "seller" };

/**
 * Add (or, with `replace`, update) a line. A call slot is one line per slot; any
 * other product is one line per product and option, so adding it again updates it.
 */
export function addToCart(
  cart: Cart | null,
  base: { name: string; seller: string; token: ShopToken },
  line: CartLine,
  replace?: number,
): AddResult {
  if (cart && cart.seller !== base.seller) return { ok: false, reason: "seller" };
  if (cart && cart.lines.length && cart.token !== base.token) return { ok: false, reason: "token" };
  const lines = [...(cart?.lines ?? [])];
  const same = (l: CartLine) => l.productId === line.productId && l.versionId === line.versionId && (line.slot === null || l.slot === line.slot);
  const at = replace !== undefined && lines[replace] ? replace : lines.findIndex(same);
  if (at >= 0) lines[at] = line;
  else {
    if (lines.length >= MAX_LINES) return { ok: false, reason: "full" };
    lines.push(line);
  }
  return { ok: true, cart: { v: 1, name: base.name, seller: base.seller, token: base.token, lines } };
}

export function removeLine(cart: Cart, index: number): Cart | null {
  const lines = cart.lines.filter((_, i) => i !== index);
  return lines.length ? { ...cart, lines } : null;
}

/** The order lines for a cart, priced against the current records (the version each buyer sees now). */
export function orderLines(cart: Cart, defs: Map<string, ProductDef>): OrderRequest["lines"] {
  return cart.lines.map((l) => ({
    productId: l.productId,
    productVersion: defs.get(l.productId)?.version ?? l.productVersion,
    versionId: l.versionId,
    quantity: l.quantity,
    chosen: l.chosen,
    slot: l.slot,
  }));
}

/** Lines whose product changed since they were added (the buyer must look again). */
export function changedLines(cart: Cart, defs: Map<string, ProductDef>): number[] {
  return cart.lines.flatMap((l, i) => {
    const d = defs.get(l.productId);
    return d && d.version !== l.productVersion ? [i] : [];
  });
}

/** The live total for the checkout, or the plain-words reason it cannot be priced. */
export function liveTotal(
  args: { seller: string; token: ShopToken; lines: OrderRequest["lines"]; tip: bigint; discountCode: string | null },
  defs: ProductDef[],
  discount: Discount | null,
): { ok: true; total: ReturnType<typeof orderTotal> } | { ok: false; problem: string } {
  const req: OrderRequest = {
    v: 1,
    seller: args.seller,
    token: args.token,
    lines: args.lines,
    recipient: { kind: "account", address: args.seller },
    gift: false,
    tip: args.tip.toString(),
    discountCode: args.discountCode,
    reviewHash: "0".repeat(64),
    nonce: "0000000000000000",
  };
  try {
    return { ok: true, total: orderTotal(req, defs, discount) };
  } catch (e) {
    return { ok: false, problem: (e as Error).message };
  }
}

// ---- call week -------------------------------------------------------------------------------

/** Monday 00:00 of the week holding `d`, in this browser's time zone. */
export function startOfWeek(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const back = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - back);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Local date key "2026-11-19" for a moment, in this browser's time zone. */
export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Free slots grouped into the seven local days of the week starting at `weekStart`. */
export function slotsByDay(slots: string[], weekStart: Date): { day: Date; slots: string[] }[] {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const keys = days.map(dayKey);
  const groups = days.map((day) => ({ day, slots: [] as string[] }));
  for (const s of slots) {
    const i = keys.indexOf(dayKey(new Date(s)));
    if (i >= 0) groups[i]?.slots.push(s);
  }
  return groups;
}

// ---- after payment -----------------------------------------------------------------------------

export type OrderStatusLike = "awaiting" | "in_progress" | "paid" | "delivered" | "refunded" | "expired";
export type StepState = "waiting" | "running" | "done" | "failed";

/**
 * The four steps after paying (spec 5.11): submitted, confirmed on QoreChain,
 * preparing your copy, ready. `sentTx` is a transaction this device sent and
 * the server has not seen yet.
 */
export function afterPaySteps(o: { status: OrderStatusLike; depositTx: string | null; delivery: string | null }, sentTx: string | null): StepState[] {
  if (o.status === "expired") return ["failed", "waiting", "waiting", "waiting"];
  if (o.status === "delivered" || (o.status === "refunded" && o.delivery)) return ["done", "done", "done", "done"];
  if (o.status === "paid" || o.status === "refunded") return ["done", "done", "running", "waiting"];
  if (o.status === "in_progress") return ["done", "done", "waiting", "waiting"];
  // awaiting
  if (o.depositTx || sentTx) return ["done", "running", "waiting", "waiting"];
  return ["running", "waiting", "waiting", "waiting"];
}

/** Minutes and seconds left on an unpaid order's hold, "42 min". */
export function holdLeft(expiresAt: string, now = Date.now()): string {
  const ms = new Date(expiresAt).getTime() - now;
  if (ms <= 0) return "ended";
  const min = Math.ceil(ms / 60_000);
  return min >= 60 ? "1 hour" : `${min} min`;
}
