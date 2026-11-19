/**
 * What the buyer side keeps on this device (localStorage): the cart per
 * seller, saved products (the heart), reviews posted here, and orders placed
 * here with the transaction this device sent. Nothing secret lives here: buyer
 * keys are kept by the engine, wrapped by a browser key.
 */
import { addToCart, cartKey, parseCart, removeLine, type AddResult, type Cart, type CartLine } from "./model";
import type { ShopToken } from "@mizuhiki/core";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
    window.dispatchEvent(new CustomEvent("mzk:shop-store", { detail: key }));
  } catch {
    // Storage is blocked (private mode): the page keeps working for this visit.
  }
}

// ---- cart ----------------------------------------------------------------------------------

export function getCart(name: string): Cart | null {
  try {
    return parseCart(localStorage.getItem(cartKey(name)), name);
  } catch {
    return null;
  }
}
export function putInCart(
  base: { name: string; seller: string; token: ShopToken },
  line: CartLine,
  replace?: number,
): AddResult {
  const r = addToCart(getCart(base.name), base, line, replace);
  if (r.ok) write(cartKey(base.name), r.cart);
  return r;
}
export function startNewCart(base: { name: string; seller: string; token: ShopToken }, line: CartLine): Cart {
  const cart: Cart = { v: 1, name: base.name, seller: base.seller, token: base.token, lines: [line] };
  write(cartKey(base.name), cart);
  return cart;
}
export function dropLine(name: string, index: number): Cart | null {
  const c = getCart(name);
  if (!c) return null;
  const next = removeLine(c, index);
  write(cartKey(name), next);
  return next;
}
export function saveCart(cart: Cart): void {
  write(cartKey(cart.name), cart);
}
export function clearCart(name: string): void {
  write(cartKey(name), null);
}

// ---- saved (heart) ---------------------------------------------------------------------------

export interface SavedProduct {
  name: string;
  slug: string;
  productId: string;
  title: string;
  ribbon: string;
  thumbnail: string | null;
  savedAt: string;
}
const SAVED = "mzk:shop:saved";
export const savedProducts = (): SavedProduct[] => read<SavedProduct[]>(SAVED, []);
export const isSaved = (productId: string) => savedProducts().some((p) => p.productId === productId);
export function toggleSaved(p: Omit<SavedProduct, "savedAt">): boolean {
  const all = savedProducts();
  if (all.some((x) => x.productId === p.productId)) {
    write(
      SAVED,
      all.filter((x) => x.productId !== p.productId),
    );
    return false;
  }
  write(SAVED, [{ ...p, savedAt: new Date().toISOString() }, ...all].slice(0, 200));
  return true;
}

// ---- reviews posted here ---------------------------------------------------------------------

export interface PostedReview {
  ref: string;
  productId: string;
  name: string;
  slug: string;
  title: string;
  rating: number;
  text: string;
  at: string;
}
const REVIEWS = "mzk:shop:reviews";
export const postedReviews = (): PostedReview[] => read<PostedReview[]>(REVIEWS, []);
export function rememberReview(r: PostedReview): void {
  write(
    REVIEWS,
    [r, ...postedReviews().filter((x) => !(x.ref === r.ref && x.productId === r.productId))].slice(0, 500),
  );
}

// ---- orders placed on this device --------------------------------------------------------------

export interface LocalOrder {
  ref: string;
  name: string;
  at: string;
  /** Transactions this device sent for the order (deposit, then the rest). */
  txs: string[];
}
const ORDERS = "mzk:shop:orders";
export const localOrders = (): LocalOrder[] => read<LocalOrder[]>(ORDERS, []);
export const localOrder = (ref: string) => localOrders().find((o) => o.ref === ref);
export function rememberOrder(ref: string, name: string): void {
  if (localOrder(ref)) return;
  write(ORDERS, [{ ref, name, at: new Date().toISOString(), txs: [] }, ...localOrders()].slice(0, 300));
}
export function rememberTx(ref: string, name: string, txHash: string): void {
  const all = localOrders();
  const o = all.find((x) => x.ref === ref) ?? { ref, name, at: new Date().toISOString(), txs: [] };
  const next = { ...o, txs: [...new Set([...o.txs, txHash.toUpperCase()])] };
  write(ORDERS, [next, ...all.filter((x) => x.ref !== ref)]);
}

/** Re-render when any of these stores change (this tab or another). */
export function onStoreChange(fn: () => void): () => void {
  const h = () => fn();
  window.addEventListener("mzk:shop-store", h);
  window.addEventListener("storage", h);
  return () => {
    window.removeEventListener("mzk:shop-store", h);
    window.removeEventListener("storage", h);
  };
}
