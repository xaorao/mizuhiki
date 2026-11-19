"use client";
/**
 * Shop blocks on the public page (spec 5.4 and 5.11): a Shop section renders
 * as a grid of product cards (thumbnail, title, rating with count, price
 * ribbon), a product button as a row. Both show only records that verify
 * against the seller's key on chain; a tap opens the full product page.
 */
import Link from "next/link";
import { Icon, Skeleton } from "@mizuhiki/ui";
import type { Block, ProductDef } from "@mizuhiki/core";
import { ribbonLabel } from "./model";
import { RatingLine, Ribbon, Thumb, useShop } from "./parts";
import s from "./buyer.module.css";

type ShopBlock = Extract<Block, { type: "product" | "shopSection" }>;

export function ShopBlockView({ block, name, onTap }: { block: ShopBlock; name: string; onTap?: (b: Block) => void }) {
  const shop = useShop(name);
  const ids = block.type === "product" ? [block.productId] : block.productIds;
  if (shop.state === "loading")
    return block.type === "product" ? (
      <div className={s.rowSkel}>
        <Skeleton lines={2} avatar />
      </div>
    ) : (
      <section className={s.shopSection} aria-label={block.title} aria-busy="true">
        <h2 className={s.sectionTitle}>{block.title}</h2>
        <div className={s.grid}>
          {ids.slice(0, 2).map((id) => (
            <div key={id} className={[s.gridCard, s.gridSkel].join(" ")} />
          ))}
        </div>
      </section>
    );
  if (shop.state === "error") return null;
  const byId = new Map(shop.items.map((x) => [x.def.id, x]));
  const items = ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x);
  if (items.length === 0) {
    if (block.type === "product") return null;
    return (
      <section className={s.shopSection} aria-label={block.title}>
        <h2 className={s.sectionTitle}>{block.title}</h2>
        <p className={s.none}>No products found</p>
      </section>
    );
  }
  const href = (d: ProductDef) => `/@${name}/p/${d.slug}`;
  if (block.type === "product") {
    const it = items[0];
    if (!it) return null;
    return (
      <Link className={s.productRow} href={href(it.def)} onClick={() => onTap?.(block)}>
        <Thumb def={it.def} size={52} />
        <span className={s.productRowText}>
          <b>{block.title || it.def.title}</b>
          <small>{block.subtitle || it.def.summary || <RatingLine rating={it.rating} compact />}</small>
        </span>
        <Ribbon>{ribbonLabel(it.def)}</Ribbon>
        <Icon name="chev" size={18} className={s.productRowChev} />
      </Link>
    );
  }
  return (
    <section className={s.shopSection} aria-label={block.title}>
      <h2 className={s.sectionTitle}>{block.title}</h2>
      {block.subtitle ? <p className={s.sectionSub}>{block.subtitle}</p> : null}
      <ul className={s.grid}>
        {items.map((it, i) => (
          <li key={it.def.id} style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}>
            <Link className={s.gridCard} href={href(it.def)} onClick={() => onTap?.(block)}>
              <span className={s.gridThumb}>
                <Thumb def={it.def} />
              </span>
              <span className={s.gridBody}>
                <b>{it.def.title}</b>
                <RatingLine rating={it.rating} compact />
              </span>
              <span className={s.gridFoot}>
                <Ribbon>{ribbonLabel(it.def)}</Ribbon>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
