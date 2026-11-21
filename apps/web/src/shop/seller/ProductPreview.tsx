"use client";
/**
 * The live preview: the buyer's product page drawn from the working copy
 * (Gumroad's product page: cover or carousel, title, price ribbon, creator,
 * description, option cards, the call to action, "What's included"). The
 * receipt preview mirrors the Receipt tab. Nothing here can be bought.
 */
import { useState } from "react";
import { Icon, Musubi } from "@mizuhiki/ui";
import { formatAmount, type ProductDef, ctaLabel } from "@mizuhiki/core";
import { mediaUrl } from "@/lib/api";
import { amountInput, priceLabel, productPath, WEEKDAYS } from "./model";
import { RichText, Thumb } from "./bits";
import s from "./seller.module.css";

export function ProductPreview({ def, name, displayName }: { def: ProductDef; name: string; displayName: string }) {
  const [cover, setCover] = useState(0);
  const [option, setOption] = useState<string | null>(def.versions[0]?.id ?? null);
  const shownCover = def.covers[Math.min(cover, def.covers.length - 1)];
  const pick = def.versions.find((v) => v.id === option) ?? def.versions[0];
  const base = BigInt(def.price.amount) + BigInt(pick?.extra ?? "0");
  const days = [...new Set((def.booking?.hours ?? []).map((h) => h.day))].sort();
  return (
    <article className={s.pv} aria-label="Preview of your product page">
      <div className={s.pvCover}>
        {shownCover ? (
          <img src={mediaUrl(shownCover.hash)} alt="" />
        ) : (
          <div className={s.pvCoverEmpty}>
            <Musubi face="normal" size={72} />
            <small>Add a cover image to show here</small>
          </div>
        )}
        {def.covers.length > 1 ? (
          <div className={s.pvDots} role="group" aria-label="Cover images">
            {def.covers.map((c, i) => (
              <button
                key={c.hash}
                type="button"
                aria-label={`Cover ${i + 1}`}
                aria-pressed={i === cover}
                onClick={() => setCover(i)}
              />
            ))}
          </div>
        ) : null}
      </div>
      <div className={s.pvBody}>
        <h3 className={s.pvTitle}>{def.title || "Untitled product"}</h3>
        <div className={s.pvMeta}>
          <span className={s.ribbon}>
            {def.versions.length && !def.price.pwyw ? formatAmount(base, def.price.token) : priceLabel(def)}
          </span>
          <span className={s.pvCreator}>
            <span className={s.pvAvatar} aria-hidden="true">
              {(displayName || name || "?").slice(0, 1).toUpperCase()}
            </span>
            {displayName || `@${name}`}
          </span>
          {def.limits.showSales ? <small className={s.muted}>0 sales</small> : null}
        </div>
        {def.description.trim() ? (
          <RichText text={def.description} className={s.pvDesc} />
        ) : (
          <p className={s.pvPlaceholder}>Your description shows here.</p>
        )}
        {def.kind === "call" && def.booking ? (
          <p className={s.pvFact}>
            <Icon name="calendar" size={15} /> {def.booking.minutes}-minute call ·{" "}
            {days.length ? days.map((d) => WEEKDAYS[d]?.slice(0, 3)).join(", ") : "no hours yet"} · times shown in the
            buyer&rsquo;s zone
          </p>
        ) : null}
        {def.kind === "commission" && def.commission ? (
          <p className={s.pvFact}>
            <Icon name="coin" size={15} /> {def.commission.depositPercent}% deposit now, the rest when the work is done
          </p>
        ) : null}
        {def.kind === "bundle" && def.bundle ? (
          <p className={s.pvFact}>
            <Icon name="archive" size={15} /> {def.bundle.productIds.length} products in one
          </p>
        ) : null}
        {def.versions.length ? (
          <div className={s.pvOptions} role="radiogroup" aria-label="Options">
            {def.versions.map((v) => (
              <button
                key={v.id}
                type="button"
                role="radio"
                aria-checked={pick?.id === v.id}
                className={s.pvOption}
                onClick={() => setOption(v.id)}
              >
                <span className={s.pvChip}>
                  {formatAmount(BigInt(def.price.amount) + BigInt(v.extra), def.price.token)}
                </span>
                <b>{v.name || "Untitled option"}</b>
                {v.description ? <small>{v.description}</small> : null}
              </button>
            ))}
          </div>
        ) : null}
        {def.price.pwyw || def.kind === "tip" ? (
          <div className={s.pvPwyw}>
            <span>Name a fair price</span>
            <b>
              {amountInput(def.price.pwyw?.suggested ?? def.price.amount, def.price.token)} {def.price.token}
            </b>
            <small>At least {formatAmount(def.price.pwyw?.min ?? def.price.amount, def.price.token)}</small>
          </div>
        ) : null}
        <span className={s.pvCta} aria-hidden="true">
          {ctaLabel(def.cta)}
        </span>
        {def.summary.trim() ? <p className={s.pvSummary}>{def.summary}</p> : null}
        {def.details.length ? (
          <dl className={s.pvDetails}>
            {def.details.map((d, i) => (
              <div key={i}>
                <dt>{d.k || "Detail"}</dt>
                <dd>{d.v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {def.refund ? (
          <p className={s.pvFact}>
            <Icon name="undo" size={15} /> {def.refund.days}-day refund promise from {displayName || `@${name}`}
            {def.refund.finePrint ? <small className={s.pvFine}>{def.refund.finePrint}</small> : null}
          </p>
        ) : null}
        <p className={s.pvLock}>
          <Icon name="lock" size={14} />
          {def.delivery === "instant"
            ? "Sealed to your key after payment, by a delivery helper that can read this product."
            : "Sealed to your key after payment. Only your key can open it."}
        </p>
        {name ? <small className={s.pvUrl}>{productPath(name, def.slug)}</small> : null}
      </div>
    </article>
  );
}

export function ReceiptPreview({ def, name, displayName }: { def: ProductDef; name: string; displayName: string }) {
  const today = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return (
    <article className={s.receipt} aria-label="Preview of the receipt">
      <header className={s.rcHead}>
        <span className={s.rcStamp} lang="ja">
          封
        </span>
        <div>
          <b>Your receipt</b>
          <small>ありがとう！ Thank you for your purchase.</small>
        </div>
      </header>
      <dl className={s.rcFacts}>
        <div>
          <dt>Order ID</dt>
          <dd className={s.mono}>preview_order_id</dd>
        </div>
        <div>
          <dt>Order date</dt>
          <dd>{today}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{priceLabel(def)}</dd>
        </div>
      </dl>
      <div className={s.rcProduct}>
        <Thumb def={def} size={52} />
        <div>
          <b>{def.title || "Untitled product"}</b>
          <small>{displayName || `@${name}`}</small>
        </div>
      </div>
      <span className={s.rcButton} aria-hidden="true">
        {def.receipt.button || "View content"}
      </span>
      {def.receipt.message.trim() ? <RichText text={def.receipt.message} className={s.rcMessage} /> : null}
      <dl className={s.rcChain}>
        <div>
          <dt>Transaction</dt>
          <dd>The payment&rsquo;s QoreChain link</dd>
        </div>
        <div>
          <dt>Sealed to</dt>
          <dd>The buyer&rsquo;s address or buyer key</dd>
        </div>
        <div>
          <dt>Content fingerprint</dt>
          <dd className={def.content ? s.mono : undefined}>
            {def.content ? `${def.content.slice(0, 16)}…` : "Set when you publish"}
          </dd>
        </div>
      </dl>
      <p className={s.rcContact}>
        Questions about your product? Contact <b>@{name || "you"}</b> on Mizuhiki.
      </p>
      {def.kind === "call" && def.booking ? (
        <p className={s.muted}>
          The booked time shows here, with {def.booking.place.trim() ? def.booking.place : "your meeting details"}.
        </p>
      ) : null}
    </article>
  );
}
