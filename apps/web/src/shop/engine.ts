/**
 * The Shop on this device (spec 5.11, ARCHITECTURE 8b).
 *
 * Seller: a product is a working copy sealed to the owner (editor state, the
 * content page and the product key K). Publishing seals the content page under
 * K, signs the public record with the owner's hybrid key and, for "Instant
 * delivery" only, seals K to the helper. The seller's device delivers paid
 * orders: it checks the payment on QoreChain and seals K to the buyer.
 *
 * Buyer: an order request binds the recipient key; the payment carries
 * `mzk:ord:<ref>`. A buyer without an account gets a 12-word buyer key made
 * here (never registered on chain). Purchases open on the device: the delivery
 * envelope gives K, K opens the content page, file keys inside it open files.
 */
import {
  CHAIN_ID,
  ContentSchema,
  ProductDefSchema,
  Purpose,
  BUYER_PHRASE_WORDS,
  ab,
  canonicalJson,
  formatAmount,
  fromBase64Url,
  fromUtf8,
  newPhrase,
  newProductKey,
  normalizePhrase,
  openContent,
  openItem,
  orderRef,
  publicRecipient,
  randomBytes,
  readDelivery,
  refundRef,
  reviewHashOf,
  sealContent,
  sealItem,
  sha256Hex,
  signRecord,
  toBase64Url,
  toHex,
  utf8,
  verifyRecord,
  type Content,
  type Discount,
  type OrderRequest,
  type ProductDef,
  type ProductKind,
  type RecipientCard,
  type ShopToken,
  type Signed,
} from "@mizuhiki/core";
import { deriveSealKeys, type SealKeyPair } from "@qorechain/qoreseal";
import {
  DeliveryRefused,
  denomBySymbol,
  msgSend,
  pqKeyViaEvm,
  prepareDelivery,
  resolveOwner,
  sendTx,
  waitForTx,
} from "@mizuhiki/chain";
import type { Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import { idb } from "@/lib/idb";
import { cardOf } from "@/lib/send";
import type { PreparedPayment } from "@/lib/pay";

export type Tokened = Account & { token: string };
export const withToken = (account: Account, token: string): Tokened => ({ ...account, token });
const T = (a: Tokened) => ({ token: a.token });

// ---- shapes from the API -------------------------------------------------------------------

export interface OwnerProduct {
  id: string;
  slug: string;
  kind: ProductKind;
  status: "draft" | "published" | "unpublished";
  version: number;
  record: Signed<ProductDef> | null;
  draftEnvelope: string;
  agentEnvelope: string | null;
  sales: number;
  revenue: string;
  updatedAt: string;
}

export interface PublicProduct {
  record: Signed<ProductDef>;
  status: string;
  /** Sales count, when the seller shows it. */
  sales: number | null;
  /** Left in stock (total limit), or null for no limit. */
  left: number | null;
  versionsLeft: Record<string, number | null>;
  rating: { average: number | null; count: number };
  reviews: { rating: number; text: string; at: string }[];
  /** Call slots already taken (UTC ISO). */
  booked: string[];
}

export type OrderStatus = "awaiting" | "in_progress" | "paid" | "delivered" | "refunded" | "expired";
export interface OrderView {
  ref: string;
  seller: string;
  request: OrderRequest;
  /** The signed product records this order was priced with. */
  records: Signed<ProductDef>[];
  token: ShopToken;
  total: string;
  dueNow: string;
  dueLater: string;
  status: OrderStatus;
  payer: string | null;
  depositTx: string | null;
  balanceTx: string | null;
  refundTx: string | null;
  delivery: string | null;
  deliveredBy: string | null;
  balanceRequested: boolean;
  createdAt: string;
  paidAt: string | null;
  deliveredAt: string | null;
  expiresAt: string;
  payTo: string;
  memo: string;
}

export interface DiscountRow {
  id: string;
  code: string;
  percent: number | null;
  amountOff: string | null;
  token: ShopToken | null;
  productIds: string[];
  maxUses: number | null;
  uses: number;
  expiresAt: string | null;
  active: boolean;
}

// ---- seller: the working copy ----------------------------------------------------------------

/** What the editor works on. Sealed to the owner only; holds the product key. */
export interface ProductDraft {
  v: 1;
  /** The record being edited (unsigned). `version` is the last published one; publish signs version + 1. */
  def: ProductDef;
  content: Content;
  /** base64url product key K. */
  key: string;
  savedAt: string;
}

export const newId = (prefix: string) => `${prefix}${toHex(randomBytes(8))}`;

export function newDraft(args: { owner: string; name: string; kind: ProductKind; title: string; token: ShopToken; amount: bigint }): ProductDraft {
  const id = newId("pr");
  const def = ProductDefSchema.parse({
    v: 1,
    id,
    owner: args.owner,
    name: args.name,
    slug: slugify(args.title) || id.slice(2, 10),
    kind: args.kind,
    title: args.title,
    price: { token: args.token, amount: args.amount.toString(), pwyw: args.kind === "tip" ? { min: args.amount.toString(), suggested: args.amount.toString() } : null },
    cta: args.kind === "call" ? "Book a time" : args.kind === "tip" ? "Support" : "I want this!",
    commission: args.kind === "commission" ? { depositPercent: 50 } : null,
    booking: args.kind === "call" ? { minutes: 30, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, hours: [1, 2, 3, 4, 5].map((day) => ({ day, from: 600, to: 1020 })), place: "" } : null,
    version: 1,
    updatedAt: new Date().toISOString(),
  });
  return {
    v: 1,
    // A never-published product carries version 0 so the first publish signs version 1.
    def: { ...def, version: 0 },
    content: { v: 1, pages: [{ id: newId("pg"), title: "", blocks: [{ t: "text", text: "" }] }] },
    key: toBase64Url(newProductKey()),
    savedAt: new Date().toISOString(),
  };
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function sealDraft(account: Account, d: ProductDraft): { envelope: Uint8Array; hash: string } {
  const s = sealItem({ purpose: Purpose.product(d.def.id), readers: [publicRecipient(account.keys.seal)], plaintext: utf8(JSON.stringify({ ...d, savedAt: new Date().toISOString() })), context: "draft" });
  return { envelope: s.envelope, hash: s.hash };
}

export async function openDraft(account: Account, p: OwnerProduct): Promise<ProductDraft> {
  const env = await api.bytes(`/blobs/${p.draftEnvelope}`);
  const d = JSON.parse(fromUtf8(openItem({ purpose: Purpose.product(p.id), envelope: env, keys: account.keys.seal, context: "draft" }))) as ProductDraft;
  return { ...d, content: ContentSchema.parse(d.content) };
}

export async function listMyProducts(a: Tokened): Promise<OwnerProduct[]> {
  return (await api.get<{ products: OwnerProduct[] }>("/owner/products", T(a))).products;
}

/** The sealed file pieces a content page points at, so the server keeps them with the product. */
export const contentChunks = (c: Content): string[] => [
  ...new Set(
    c.pages.flatMap((p) =>
      p.blocks.flatMap((b) => (b.t === "file" && Array.isArray(b.file.chunks) ? (b.file.chunks as unknown[]).filter((h): h is string => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) : [])),
    ),
  ),
];

/**
 * Save the working copy (nothing public changes). Pass the product's current
 * `agentEnvelope` so a published "Instant delivery" product keeps its helper copy.
 */
export async function saveDraft(a: Tokened, d: ProductDraft, agentEnvelope: string | null = null): Promise<void> {
  const s = sealDraft(a, d);
  await api.put("/blobs", s.envelope, T(a));
  await api.put("/products", { id: d.def.id, slug: d.def.slug, kind: d.def.kind, draftEnvelope: s.hash, agentEnvelope, files: contentChunks(d.content) }, T(a));
}

/** The delivery helper this Mizuhiki offers for "Instant delivery", if any. */
export const offeredHelper = async (): Promise<string | null> => (await api.get<{ address: string | null }>("/shop/helper")).address;

/** Problems that stop publishing, in plain words (empty = ready). */
export function publishProblems(d: ProductDraft): string[] {
  const out: string[] = [];
  const def = d.def;
  if (!def.title.trim()) out.push("Give the product a name.");
  if (!/^[a-z0-9-]{1,48}$/.test(def.slug)) out.push("The link may use lowercase letters, numbers and dashes.");
  if (!["tip", "commission", "call", "bundle"].includes(def.kind) && !d.content.pages.some((p) => p.blocks.some((b) => (b.t === "text" ? b.text.trim() : true))))
    out.push("Add what the buyer gets in Content.");
  if (def.kind === "bundle" && (def.bundle?.productIds.length ?? 0) < 2) out.push("A bundle needs two or more of your published products.");
  if (def.kind === "call" && (def.booking?.hours.length ?? 0) === 0) out.push("Add the hours people can book.");
  if (def.price.pwyw && BigInt(def.price.pwyw.suggested) < BigInt(def.price.pwyw.min)) out.push("The suggested amount must be at least the minimum.");
  if (def.delivery === "instant" && !def.agent) out.push("Instant delivery needs a helper's address.");
  return out;
}

/** Seal the content, sign the record (version + 1) and publish it. Returns the new working copy. */
export async function publish(a: Tokened, d: ProductDraft, onStep: (s: "content" | "sign" | "upload") => void = () => undefined): Promise<ProductDraft> {
  const problems = publishProblems(d);
  if (problems.length) throw new Error(problems[0]);
  const key = fromBase64Url(d.key);
  onStep("content");
  const hasContent = d.content.pages.some((p) => p.blocks.some((b) => (b.t === "text" ? b.text.trim() : true)));
  let content: string | null = null;
  if (hasContent) {
    const blob = await sealContent(key, d.def.id, d.content);
    content = (await api.put<{ hash: string }>("/blobs", blob, T(a))).hash;
  }
  let agentEnvelope: string | null = null;
  if (d.def.delivery === "instant" && d.def.agent) {
    const recipient = await resolveOwner(d.def.agent, await cardOf(d.def.agent));
    const s = sealItem({ purpose: Purpose.product(d.def.id), readers: [recipient], plaintext: utf8(JSON.stringify({ key: d.key, content })), context: "agent" });
    agentEnvelope = (await api.put<{ hash: string }>("/blobs", s.envelope, T(a))).hash;
  }
  onStep("sign");
  const def = ProductDefSchema.parse({ ...d.def, content, version: d.def.version + 1, updatedAt: new Date().toISOString() });
  const record = signRecord({ kind: "product", body: def, signer: a.owner.address, classical: a.keys.classical, pq: a.keys.pq });
  const next: ProductDraft = { ...d, def };
  const s = sealDraft(a, next);
  onStep("upload");
  await api.put("/blobs", s.envelope, T(a));
  await api.put("/products", { id: def.id, slug: def.slug, kind: def.kind, draftEnvelope: s.hash, agentEnvelope, publish: record, files: contentChunks(d.content) }, T(a));
  return next;
}

export const setProductStatus = (a: Tokened, id: string, status: "published" | "unpublished") => api.patch(`/owner/products/${id}`, { status }, T(a));
export const deleteProduct = (a: Tokened, id: string) => api.del(`/owner/products/${id}`, T(a));

/** Public images (covers, thumbnails): the same media store pages use. */
export async function uploadImage(a: Tokened, file: File): Promise<{ hash: string; type: string }> {
  return api.put<{ hash: string; type: string }>("/media", new Uint8Array(await file.arrayBuffer()), T(a));
}

// ---- seller: discounts -------------------------------------------------------------------------

export const listDiscounts = async (a: Tokened) => (await api.get<{ discounts: DiscountRow[] }>("/owner/discounts", T(a))).discounts;
export const saveDiscount = (a: Tokened, d: Omit<DiscountRow, "uses">) => api.put("/owner/discounts", d, T(a));
export const deleteDiscount = (a: Tokened, id: string) => api.del(`/owner/discounts/${id}`, T(a));

// ---- seller: orders and delivery -----------------------------------------------------------------

export const listSales = async (a: Tokened) => (await api.get<{ orders: OrderView[] }>("/owner/orders", T(a))).orders;
export const requestBalance = (a: Tokened, ref: string) => api.post(`/orders/${ref}/balance`, {}, T(a));

/**
 * Deliver every paid order this device can: the seller's own device by default.
 * Returns what happened per order, in plain words.
 */
export async function deliverPaid(a: Tokened, orders: OrderView[], mine: OwnerProduct[]): Promise<{ ref: string; ok: boolean; why?: string }[]> {
  const waiting = orders.filter((o) => o.status === "paid" && !o.delivery);
  if (waiting.length === 0) return [];
  const keys = new Map<string, { key: Uint8Array; content: string | null }>();
  for (const p of mine) {
    try {
      const d = await openDraft(a, p);
      keys.set(p.id, { key: fromBase64Url(d.key), content: null });
    } catch {
      // A product whose working copy does not open here cannot be delivered from this device.
    }
  }
  const discounts = await listDiscounts(a).catch(() => [] as DiscountRow[]);
  const out: { ref: string; ok: boolean; why?: string }[] = [];
  for (const o of waiting) {
    try {
      // Price with the records the buyer saw, each checked against this seller's key on chain.
      const products: ProductDef[] = [];
      for (const r of o.records) {
        const def = await verifyProduct(r);
        if (def.owner !== a.owner.address) throw new DeliveryRefused("This order names a product that is not yours.");
        products.push(def);
      }
      const code = o.request.discountCode?.trim().toUpperCase();
      const d = code ? discounts.find((x) => x.code === code) : undefined;
      if (code && !d) throw new DeliveryRefused(`The discount code ${code} is not one of yours. Nothing was sealed.`);
      const discount: Discount | null = d ? { percent: d.percent, amountOff: d.amountOff, productIds: d.productIds } : null;
      // Each product key goes out with the content hash of the record the buyer bought.
      const forOrder = new Map([...keys].map(([id, k]) => [id, { key: k.key, content: products.find((p) => p.id === id)?.content ?? null }]));
      const { envelope } = await prepareDelivery({ order: o, products, keys: forOrder, discount, cardOf, current: mine.flatMap((p) => (p.record ? [p.record.body] : [])) });
      const h = (await api.put<{ hash: string }>("/blobs", envelope, T(a))).hash;
      await api.post(`/orders/${o.ref}/deliver`, { envelope: h }, T(a));
      out.push({ ref: o.ref, ok: true });
    } catch (e) {
      out.push({ ref: o.ref, ok: false, why: e instanceof DeliveryRefused || e instanceof ApiFailure ? e.message : "This order could not be sealed here." });
    }
  }
  return out;
}

/** A refund: the seller sends the money back from their own wallet with the order's refund memo, then records it. */
export async function refund(a: Tokened, o: OrderView, amount: bigint, onStage: (s: "signing" | "submitted" | "confirmed") => void): Promise<string> {
  if (!o.payer) throw new Error("This order has no payer on record.");
  const denom = denomBySymbol(o.token);
  if (!denom) throw new Error("Unknown token.");
  onStage("signing");
  const sent = await sendTx(a.owner, [msgSend(a.owner.address, o.payer, denom.denom, amount)], `mzk:ord:${refundRef(o.ref)}`);
  onStage("submitted");
  await waitForTx(sent.txHash);
  onStage("confirmed");
  await api.post(`/orders/${o.ref}/refund`, { txHash: sent.txHash }, T(a));
  return sent.txHash;
}

// ---- public: product records -------------------------------------------------------------------

/** Fetch and verify a product against its owner's key on QoreChain. */
export async function loadProduct(name: string, slug: string): Promise<PublicProduct & { def: ProductDef }> {
  const p = await api.get<PublicProduct>(`/products/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`);
  return { ...p, def: await verifyProduct(p.record) };
}

export async function verifyProduct(record: Signed<ProductDef>): Promise<ProductDef> {
  const pq = await pqKeyViaEvm(record.signer);
  if (!pq.registered || !pq.publicKey || !pq.possessionProven) throw new Error("The seller's key is not on QoreChain, so this product cannot be checked.");
  const body = verifyRecord(record, { kind: "product", signer: record.signer, pqPublicKey: pq.publicKey });
  const def = ProductDefSchema.parse(body);
  if (def.owner !== record.signer) throw new Error("This product is signed by someone other than its seller.");
  return def;
}

export async function loadShop(name: string): Promise<{ def: ProductDef; rating: PublicProduct["rating"] }[]> {
  const r = await api.get<{ products: { record: Signed<ProductDef>; rating: PublicProduct["rating"] }[] }>(`/shop/${encodeURIComponent(name)}`);
  const out: { def: ProductDef; rating: PublicProduct["rating"] }[] = [];
  for (const p of r.products) {
    try {
      out.push({ def: await verifyProduct(p.record), rating: p.rating });
    } catch {
      // A product that does not verify is not shown.
    }
  }
  return out;
}

export async function checkDiscount(seller: string, code: string, token: ShopToken): Promise<Discount | null> {
  try {
    return (await api.post<{ discount: Discount }>("/discounts/check", { seller, code, token })).discount;
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 404) return null;
    throw e;
  }
}

// ---- buyer keys (no account) -------------------------------------------------------------------

export interface BuyerKey {
  phrase: string;
  keys: SealKeyPair;
  /** SHA-256 of the public parts: how the library finds its purchases. */
  hash: string;
  recipient: { kind: "key"; mlkem: string; x25519: string };
}

export function buyerKeyFrom(phraseInput: string): BuyerKey {
  const phrase = normalizePhrase(phraseInput);
  const keys = deriveSealKeys({ mnemonic: phrase, index: 0 });
  const mlkem = toHex(keys.mlkemPublicKey);
  const x25519 = toHex(keys.x25519PublicKey);
  return { phrase, keys, hash: sha256Hex(utf8(canonicalJson({ mlkem, x25519 }))), recipient: { kind: "key", mlkem, x25519 } };
}
export const newBuyerKey = (): BuyerKey => buyerKeyFrom(newPhrase(BUYER_PHRASE_WORDS));

/**
 * Buyer keys stay on this device, wrapped by a browser key that cannot be
 * exported (so a copied database is useless elsewhere). The 12 words are the way back on another device.
 */
async function deviceWrapKey(): Promise<CryptoKey> {
  const existing = await idb.get<CryptoKey>("shop:wrap").catch(() => undefined);
  if (existing) return existing;
  const k = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  await idb.set("shop:wrap", k);
  return k;
}
export async function rememberBuyerKey(k: BuyerKey): Promise<void> {
  const wrap = await deviceWrapKey();
  const all = await buyerKeyRecords();
  if (all.some((x) => x.hash === k.hash)) return;
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv) }, wrap, ab(utf8(k.phrase))));
  await idb.set("shop:buyer-keys", [...all, { hash: k.hash, iv, ct }]);
}
async function buyerKeyRecords(): Promise<{ hash: string; iv: Uint8Array; ct: Uint8Array }[]> {
  return (await idb.get<{ hash: string; iv: Uint8Array; ct: Uint8Array }[]>("shop:buyer-keys").catch(() => undefined)) ?? [];
}
export async function buyerKeys(): Promise<BuyerKey[]> {
  const wrap = await deviceWrapKey().catch(() => null);
  if (!wrap) return [];
  const out: BuyerKey[] = [];
  for (const r of await buyerKeyRecords()) {
    try {
      out.push(buyerKeyFrom(fromUtf8(new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ab(r.iv) }, wrap, ab(r.ct))))));
    } catch {
      // Unreadable here (storage from another browser profile); the 12 words still work.
    }
  }
  return out;
}
export async function forgetBuyerKey(hash: string): Promise<void> {
  await idb.set("shop:buyer-keys", (await buyerKeyRecords()).filter((r) => r.hash !== hash));
}

// ---- buyer: ordering and paying ----------------------------------------------------------------

/**
 * The review secret is derived from the recipient's own sealing seed and the order nonce,
 * so the buyer can review from any device that holds the same key.
 */
export function reviewSecret(seal: SealKeyPair, nonce: string): string {
  return sha256Hex(new Uint8Array([...seal.seed, ...utf8(`mzk:review-secret:${nonce}`)]));
}

export function newNonce(): string {
  return toBase64Url(randomBytes(16));
}

export interface Checkout {
  seller: string;
  token: ShopToken;
  lines: OrderRequest["lines"];
  /** Who it is sealed to: the buyer's account, a buyer key, or a gift's receiver. */
  recipient: OrderRequest["recipient"];
  gift: boolean;
  tip: bigint;
  discountCode: string | null;
  /** The sealing key that will open it (to derive the review secret); null for gifts sealed to someone else. */
  reviewKeys: SealKeyPair | null;
}

export function buildRequest(c: Checkout): { request: OrderRequest; ref: string } {
  const nonce = newNonce();
  const secret = c.reviewKeys ? reviewSecret(c.reviewKeys, nonce) : toHex(randomBytes(32));
  const request: OrderRequest = {
    v: 1,
    seller: c.seller,
    token: c.token,
    lines: c.lines,
    recipient: c.recipient,
    gift: c.gift,
    tip: c.tip.toString(),
    discountCode: c.discountCode,
    reviewHash: reviewHashOf(secret),
    nonce,
  };
  return { request, ref: orderRef(request) };
}

export async function placeOrder(request: OrderRequest): Promise<OrderView & { lines?: unknown }> {
  return api.post<OrderView>("/orders", { request });
}

/** A payment for the part of an order due now (or the rest of a commission). */
export function orderPayment(o: OrderView, part: "now" | "rest" = "now"): PreparedPayment {
  const denom = denomBySymbol(o.token);
  if (!denom) throw new Error("This order asks for a token that is not accepted.");
  const units = BigInt(part === "now" ? o.dueNow : o.dueLater);
  const ref = part === "now" ? o.ref : `${o.ref}-2`;
  const shown = formatAmount(units, o.token).replace(` ${o.token}`, "");
  return { ref, memo: `mzk:ord:${ref}`, denom, units, amount: shown, tip: "0", total: shown, token: o.token, note: null };
}

/** Tell the server the payment's transaction, so it reads it from QoreChain now rather than at the next index pass. */
export const reportTx = (ref: string, txHash: string) => api.post<OrderView & { seen: boolean }>(`/orders/${ref}/tx`, { txHash });
export const getOrder = (ref: string) => api.get<OrderView>(`/orders/${ref}`);

// ---- buyer: purchases ---------------------------------------------------------------------------

export const myOrders = async (a: Tokened) => (await api.get<{ orders: OrderView[] }>("/orders/mine", T(a))).orders;
export const keyOrders = async (k: BuyerKey) => (await api.get<{ orders: OrderView[] }>(`/orders/by-key/${k.hash}`)).orders;

export interface OpenedPurchase {
  ref: string;
  products: { def: ProductDef; content: Content | null }[];
}

/** Open a delivered order on this device: the delivery gives each product key; the keys open the content pages. */
export async function openPurchase(o: OrderView, seal: SealKeyPair, defs: Map<string, ProductDef>): Promise<OpenedPurchase> {
  if (!o.delivery) throw new Error("This purchase has not been sealed to you yet.");
  const env = await api.bytes(`/blobs/${o.delivery}`);
  const d = readDelivery(openItem({ chainId: CHAIN_ID, purpose: Purpose.order(o.ref), envelope: env, keys: seal }));
  if (d.ref !== o.ref) throw new Error("This delivery belongs to another order.");
  const products: OpenedPurchase["products"] = [];
  for (const k of d.keys) {
    const def = defs.get(k.productId);
    if (!def) continue;
    const content = k.content ? await openContent(k.key, k.productId, await api.bytes(`/blobs/${k.content}`)) : null;
    products.push({ def, content });
  }
  return { ref: o.ref, products };
}

export async function postReview(ref: string, secret: string, productId: string, rating: number, text: string): Promise<void> {
  await api.post(`/orders/${ref}/review`, { secret, productId, rating, text });
}
export const orderReviews = async (ref: string) =>
  (await api.get<{ reviews: { productId: string; rating: number; text: string }[] }>(`/orders/${ref}/review`)).reviews;

/** The keys that open an order on this device: the account's own, or a remembered buyer key. */
export async function sealKeysFor(o: OrderView, account: Account | undefined): Promise<SealKeyPair | null> {
  const r = o.request.recipient;
  if (r.kind === "account") return account && account.owner.address === r.address ? account.keys.seal : null;
  for (const k of await buyerKeys()) if (k.recipient.mlkem === r.mlkem && k.recipient.x25519 === r.x25519) return k.keys;
  return null;
}

export { cardOf };
export type { RecipientCard };
