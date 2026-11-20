"use client";
/**
 * Small pieces every buyer screen shares: stars, the price ribbon, the safe
 * description renderer, product thumbnails, the shop top bar, cached shop
 * reads, the seller's page, and the keys that open an order on this device.
 */
import { Fragment, useEffect, useId, useState, type ReactNode } from "react";
import Link from "next/link";
import { Icon, Knot } from "@mizuhiki/ui";
import type { Manifest, ProductDef, RecipientCard, Signed } from "@mizuhiki/core";
import type { SealKeyPair } from "@qorechain/qoreseal";
import type { Account } from "@/account/AccountProvider";
import { api, mediaUrl } from "@/lib/api";
import { buyerKeys, loadShop, type BuyerKey, type OrderView, type PublicProduct } from "../engine";
import { paragraphs, parseInline, ratingLabel, type Inline } from "./model";
import { getCart, onStoreChange } from "./store";
import s from "./buyer.module.css";
import { failureText } from "@/lib/failure";

// ---- stars and ribbon --------------------------------------------------------------------------

const STAR = "m12 2.6 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4L12 17.4l-5.8 3 1.1-6.4-4.7-4.6 6.5-.9z";

export function Stars({ value, size = 16 }: { value: number; size?: number }) {
  const uid = useId().replace(/:/g, "");
  return (
    <span className={s.stars} aria-hidden="true">
      {[1, 2, 3, 4, 5].map((n) => {
        const fill = Math.max(0, Math.min(1, value - (n - 1)));
        return (
          <svg key={n} viewBox="0 0 24 24" width={size} height={size}>
            <defs>
              <clipPath id={`${uid}-${n}`}>
                <rect x="0" y="0" width={24 * fill} height="24" />
              </clipPath>
            </defs>
            <path d={STAR} fill="var(--white)" stroke="var(--ink)" strokeWidth="1.8" strokeLinejoin="round" />
            <path d={STAR} fill="var(--knot-gold)" clipPath={`url(#${uid}-${n})`} />
            <path d={STAR} fill="none" stroke="var(--ink)" strokeWidth="1.8" strokeLinejoin="round" />
          </svg>
        );
      })}
    </span>
  );
}

export function RatingLine({ rating, compact = false }: { rating: PublicProduct["rating"]; compact?: boolean }) {
  if (rating.count === 0) return <span className={s.ratingNone}>{compact ? "No ratings yet" : "No ratings yet"}</span>;
  const avg = rating.average ?? 0;
  return (
    <span className={s.rating}>
      <Stars value={avg} size={compact ? 14 : 17} />
      <span>
        {compact ? ratingLabel(avg) : null}
        <span className={compact ? s.ratingCount : ""}>
          {compact ? ` (${rating.count})` : `${rating.count} ${rating.count === 1 ? "rating" : "ratings"}`}
        </span>
      </span>
      <span className="sr-only">
        Rated {ratingLabel(avg)} out of 5 from {rating.count} {rating.count === 1 ? "rating" : "ratings"}
      </span>
    </span>
  );
}

export function Ribbon({
  children,
  tone = "butter",
  big = false,
}: {
  children: ReactNode;
  tone?: "butter" | "sakura" | "matcha";
  big?: boolean;
}) {
  return (
    <span className={[s.ribbon, big ? s.ribbonBig : ""].join(" ")}>
      <span className={[s.ribbonInner, s[`rb_${tone}`]].join(" ")}>{children}</span>
    </span>
  );
}

// ---- safe rich text ------------------------------------------------------------------------------

function renderInline(nodes: Inline[]): ReactNode {
  return nodes.map((n, i) =>
    n.t === "text" ? (
      <Fragment key={i}>{n.v}</Fragment>
    ) : n.t === "b" ? (
      <strong key={i}>{renderInline(n.c)}</strong>
    ) : n.t === "i" ? (
      <em key={i}>{renderInline(n.c)}</em>
    ) : (
      <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow ugc">
        {renderInline(n.c)}
      </a>
    ),
  );
}

/** Text with paragraphs, **bold**, *italic* and https links, built as React nodes (never as HTML). */
export function RichText({ text, className }: { text: string; className?: string | undefined }) {
  const paras = paragraphs(text);
  if (paras.length === 0) return null;
  return (
    <div className={[s.rich, className ?? ""].join(" ")}>
      {paras.map((lines, i) => (
        <p key={i}>
          {lines.map((l, j) => (
            <Fragment key={j}>
              {j > 0 ? <br /> : null}
              {renderInline(parseInline(l))}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

// ---- pictures ------------------------------------------------------------------------------------

export const thumbOf = (def: ProductDef): string | null =>
  def.thumbnail
    ? mediaUrl(def.thumbnail.hash)
    : def.covers[0] && def.covers[0].type.startsWith("image/")
      ? mediaUrl(def.covers[0].hash)
      : null;

const KIND_TONE: Record<ProductDef["kind"], string> = {
  file: "sora",
  course: "matcha",
  report: "fuji",
  bundle: "butter",
  call: "sakura",
  commission: "kinari",
  tip: "sakura",
};
const KIND_ICON = {
  file: "file",
  course: "text",
  report: "chart",
  bundle: "folder",
  call: "calendar",
  commission: "pen",
  tip: "heart",
} as const;

/** The square thumbnail, or a pastel tile with the kind's icon when the seller set none. */
export function Thumb({ def, size }: { def: ProductDef; size?: number }) {
  const src = thumbOf(def);
  return (
    <span
      className={[s.thumb, s[`tt_${KIND_TONE[def.kind]}`]].join(" ")}
      style={size ? { width: size, height: size } : undefined}
    >
      {src ? (
        <img src={src} alt="" loading="lazy" />
      ) : (
        <Icon name={KIND_ICON[def.kind]} size={size ? Math.round(size * 0.36) : 40} />
      )}
    </span>
  );
}

// ---- top bar -------------------------------------------------------------------------------------

export function useCartCount(name: string): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const read = () => setN(getCart(name)?.lines.reduce((a, l) => a + l.quantity, 0) ?? 0);
    read();
    return onStoreChange(read);
  }, [name]);
  return n;
}

/** Knot home, the seller's page, Library and the cart with its count. */
export function ShopBar({
  name,
  children,
  inLibrary = false,
}: {
  name?: string;
  children?: ReactNode;
  inLibrary?: boolean;
}) {
  return (
    <header className={s.bar}>
      <Link className={s.home} href="/" aria-label="Mizuhiki home">
        <Knot size={24} />
      </Link>
      {name ? (
        <Link className={s.barName} href={`/@${name}`}>
          @{name}
        </Link>
      ) : null}
      <span className={s.barRight}>
        {children}
        {inLibrary ? null : (
          <Link className={s.barLink} href="/library">
            <Icon name="folder" size={18} />
            <span>Library</span>
          </Link>
        )}
        {name ? <CartLink name={name} /> : null}
      </span>
    </header>
  );
}

function CartLink({ name }: { name: string }) {
  const n = useCartCount(name);
  return (
    <Link
      className={s.cartLink}
      href={`/@${name}/checkout`}
      aria-label={n ? `Cart, ${n} ${n === 1 ? "item" : "items"}` : "Cart, empty"}
    >
      <Icon name="bag" size={20} />
      {n ? <span className={s.cartCount}>{n}</span> : null}
    </Link>
  );
}

// ---- reads -------------------------------------------------------------------------------------

type ShopItems = Awaited<ReturnType<typeof loadShop>>;
const shopCache = new Map<string, { at: number; p: Promise<ShopItems> }>();

/** A page's verified products, shared by every block on the page (one fetch, one check per record). */
export function cachedShop(name: string): Promise<ShopItems> {
  const hit = shopCache.get(name);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = loadShop(name);
  shopCache.set(name, { at: Date.now(), p });
  p.catch(() => shopCache.delete(name));
  return p;
}

export function useShop(
  name: string,
): { state: "loading" } | { state: "ok"; items: ShopItems } | { state: "error"; message: string } {
  const [st, setSt] = useState<ReturnType<typeof useShop>>({ state: "loading" });
  useEffect(() => {
    const life = { alive: true };
    cachedShop(name).then(
      (items) => life.alive && setSt({ state: "ok", items }),
      (e: unknown) => life.alive && setSt({ state: "error", message: failureText(e, "The shop could not be loaded.") }),
    );
    return () => {
      life.alive = false;
    };
  }, [name]);
  return st;
}

export interface SellerPage {
  displayName: string;
  avatar: Manifest["avatar"];
  address: string;
  card: RecipientCard | null;
}
const pageCache = new Map<string, Promise<SellerPage | null>>();
/** The seller's public page, for the name and avatar on receipts and the library (display only). */
export function sellerPage(name: string): Promise<SellerPage | null> {
  let p = pageCache.get(name);
  if (!p) {
    p = api
      .get<{ record: Signed<Manifest>; card: RecipientCard | null; registry: { owner: string } }>(
        `/pages/${encodeURIComponent(name)}`,
      )
      .then((r) => ({
        displayName: r.record.body.displayName,
        avatar: r.record.body.avatar,
        address: r.registry.owner,
        card: r.card,
      }))
      .catch(() => null);
    pageCache.set(name, p);
  }
  return p;
}

// ---- keys ----------------------------------------------------------------------------------------

/**
 * The keys that open an order here: the unlocked account, a buyer key kept on
 * this device, or an account restored from a buyer key's 12 words (same sealing key).
 */
export async function keysForOrder(
  o: OrderView,
  account: Account | undefined,
  extra: BuyerKey[] = [],
): Promise<SealKeyPair | null> {
  const r = o.request.recipient;
  if (r.kind === "account") return account && account.owner.address === r.address ? account.keys.seal : null;
  const all = [...extra, ...(await buyerKeys())];
  for (const k of all) if (k.recipient.mlkem === r.mlkem && k.recipient.x25519 === r.x25519) return k.keys;
  if (account) {
    const mine = account.keys.seal;
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    if (hex(mine.mlkemPublicKey) === r.mlkem && hex(mine.x25519PublicKey) === r.x25519) return mine;
  }
  return null;
}

/** Short, readable dates: "19 Nov 2026, 14:05". */
export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
export const slotLabel = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
