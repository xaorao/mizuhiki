"use client";
/**
 * Renders a page manifest: cover, avatar, name, handle, bio, the sealing badge,
 * Links | Shop, and the block rows. Used by the public page, the editor's live
 * preview and the onboarding preview, so all three always match.
 */
import type { ReactNode } from "react";
import { Avatar, Chip, Icon, Musubi, Row, Segmented, type IconName, type Tone } from "@mizuhiki/ui";
import type { Block, Manifest } from "@mizuhiki/core";
import { mediaUrl } from "@/lib/api";
import { themeVars } from "./theme";
import s from "./PageView.module.css";

export const BLOCK_LOOK: Record<Block["type"], { icon: IconName; tone: Tone }> = {
  pay: { icon: "coin", tone: "matcha" },
  message: { icon: "mail", tone: "sakura" },
  form: { icon: "form", tone: "sora" },
  product: { icon: "bag", tone: "butter" },
  shopSection: { icon: "bag", tone: "butter" },
  room: { icon: "users", tone: "fuji" },
  capsule: { icon: "hour", tone: "kinari" },
  link: { icon: "link", tone: "sora" },
  collection: { icon: "folder", tone: "kinari" },
  text: { icon: "text", tone: "kinari" },
  invoiceRequest: { icon: "invoice", tone: "matcha" },
  fileRequest: { icon: "upload", tone: "sora" },
  social: { icon: "share", tone: "fuji" },
};

export interface PendingBlock {
  key: string;
  title: string;
}

export function PageView({
  manifest,
  onBlock,
  onMessage,
  onInfo,
  compact = false,
  pending = [],
  footer,
  tab,
  onTab,
  hasShop = false,
  renderBlock,
  shopFallback,
  previewOwner = false,
}: {
  /** True in the sign-up preview before a name is typed. */
  previewOwner?: boolean | undefined;
  manifest: Pick<Manifest, "name" | "displayName" | "bio" | "avatar" | "blocks" | "theme">;
  onBlock?: ((b: Block) => void) | undefined;
  onMessage?: (() => void) | undefined;
  onInfo?: (() => void) | undefined;
  compact?: boolean;
  /** Unfinished blocks shown as "Finish setup, not visible" placeholders (editor and onboarding previews only). */
  pending?: PendingBlock[];
  footer?: ReactNode;
  tab?: "links" | "shop";
  onTab?: (t: "links" | "shop") => void;
  hasShop?: boolean;
  /** Draw a block another way (the public page's shop grid and product rows); undefined keeps the standard row. */
  renderBlock?: ((b: Block) => ReactNode | undefined) | undefined;
  /** The Shop side when the page has no Shop section (the public page shows every published product). */
  shopFallback?: ReactNode;
}) {
  // The sign-up preview passes no name yet: speak to the person instead of printing a placeholder ("Sealed to Your").
  const firstName = previewOwner ? "you" : ((manifest.displayName || manifest.name).split(" ")[0] ?? manifest.name);
  // Links | Shop (spec 5.4): Links holds the page's buttons (a product button included, where the owner put it);
  // Shop holds the store: the Shop sections, or every published product when there is no section.
  const isShop = (b: Block) => b.type === "shopSection";
  const live = manifest.blocks.filter(
    (b) => b.on && !b.archived && (!(hasShop && tab) || b.type === "collection" || (tab === "shop") === isShop(b)),
  );
  const collectionIds = new Set(live.filter((b) => b.type === "collection").map((b) => b.id));
  const hiddenCollections = new Set(
    manifest.blocks.filter((b) => b.type === "collection" && (!b.on || b.archived)).map((b) => b.id),
  );
  // Order: blocks outside collections in their own order; a collection's heading where it sits, then its members.
  const visible = live.filter(
    (b) =>
      b.type !== "collection" &&
      !(b.collection && (collectionIds.has(b.collection) || hiddenCollections.has(b.collection))),
  );
  const featured = live.find((b) => b.type === "message")?.id;
  const rowFor = (b: Block) => {
    const custom = renderBlock?.(b);
    if (custom !== undefined)
      return (
        <div key={b.id} id={compact ? undefined : b.id} className={s.anchor}>
          {custom}
        </div>
      );
    const look = BLOCK_LOOK[b.type];
    return (
      <div key={b.id} id={compact ? undefined : b.id} className={s.anchor}>
        <Row
          icon={look.icon}
          tone={look.tone}
          title={b.title}
          detail={b.subtitle || undefined}
          feature={b.id === featured}
          {...(b.type === "link" ? { href: b.url } : { onClick: () => onBlock?.(b) })}
        />
      </div>
    );
  };
  const t = manifest.theme;
  const wp = t.wallpaper;
  const hero = t.header === "hero";
  const showsShopFallback = hasShop && tab === "shop" && !live.some(isShop) && !!shopFallback;
  return (
    <article
      className={[s.page, compact ? s.compact : "", hero ? s.hero : ""].join(" ")}
      style={themeVars(t)}
      data-wallpaper={wp.kind}
    >
      <div
        className={[s.cover, wp.kind === "pattern" ? "seigaiha" : "", s[`wp_${wp.kind}`]].join(" ")}
        style={{ ["--a" as string]: wp.a, ["--b" as string]: wp.b }}
      >
        {!compact && onMessage ? (
          <div className={s.top}>
            <button type="button" className={s.pill} onClick={onMessage}>
              <Icon name="send" size={16} />
              Message
            </button>
          </div>
        ) : null}
      </div>
      {!compact ? (
        <span className={s.peek}>
          <Musubi face="normal" size={78} bob />
        </span>
      ) : null}
      <div className={s.body}>
        <Avatar
          name={manifest.displayName || manifest.name}
          {...(manifest.avatar ? { src: mediaUrl(manifest.avatar.hash) } : {})}
          size={compact ? 72 : 104}
          lock
        />
        <h1 className={s.name}>{manifest.displayName || manifest.name}</h1>
        <p className={s.handle}>@{manifest.name}</p>
        {manifest.bio ? <p className={s.bio}>{manifest.bio}</p> : null}
        {onInfo ? (
          <button type="button" className={s.badge} onClick={onInfo}>
            <Icon name="shield" size={16} />
            <span>Anything you send is sealed to {firstName}</span>
          </button>
        ) : (
          <span className={s.badgeStatic}>
            <Chip icon="shield">Sealed to {firstName}</Chip>
          </span>
        )}
        {hasShop && onTab && tab ? (
          <div className={s.tabs}>
            <Segmented
              label="Page sections"
              value={tab}
              onChange={onTab}
              options={[
                { value: "links", label: "Links" },
                { value: "shop", label: "Shop" },
              ]}
            />
          </div>
        ) : null}
        <div className={s.rows}>
          {live.map((b) => {
            if (b.type === "collection") {
              const members = live.filter((m) => m.collection === b.id && m.type !== "collection");
              if (members.length === 0) return null;
              return (
                <section key={b.id} className={s.collection} aria-label={b.title}>
                  <h2 className={s.collectionTitle}>{b.title}</h2>
                  {members.map(rowFor)}
                </section>
              );
            }
            return visible.includes(b) ? rowFor(b) : null;
          })}
          {showsShopFallback ? shopFallback : null}
          {pending.map((p) => (
            <div key={p.key} className={s.pending}>
              <Icon name="wrench" size={16} />
              <span>
                <b>{p.title}</b> · Finish setup, not visible on your page
              </span>
            </div>
          ))}
          {live.length === 0 && pending.length === 0 && !showsShopFallback ? (
            <p className={s.none}>Nothing here yet.</p>
          ) : null}
        </div>
      </div>
      {footer}
      {manifest.theme.poweredBy ? (
        <p className={s.credit}>
          <a href="/">Made with mizuhiki 水引</a>
        </p>
      ) : null}
    </article>
  );
}
