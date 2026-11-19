"use client";
import Link from "next/link";
/**
 * Checkout at /@name/checkout (spec 5.11, Gumroad's one two-column page): the
 * cart on the left (lines with Configure and Remove, discount code, tip,
 * subtotal and total from the shared `orderTotal`), and on the right who it is
 * sealed to and how it is paid. The cart is kept per seller on this device.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, ButtonLink, EmptyState, Icon, Kicker, Oops, Sakura, Skeleton, TextField } from "@mizuhiki/ui";
import { formatAmount, parseAmount, type Discount, type ProductDef } from "@mizuhiki/core";
import { ApiFailure } from "@/lib/api";
import { buildRequest, checkDiscount, placeOrder, type OrderView } from "../engine";
import { changedLines, liveTotal, orderLines, type Cart } from "./model";
import { PayPanel } from "./PayPanel";
import { SealTo, type SealChoice } from "./SealTo";
import { ShopBar, Thumb, slotLabel, useShop } from "./parts";
import { clearCart, dropLine, getCart, onStoreChange } from "./store";
import s from "./buyer.module.css";

const TIPS = [0, 10, 15, 20] as const;

export function CheckoutPage({ name, seller }: { name: string; seller: { displayName: string; owner: string } }) {
  const router = useRouter();
  const shop = useShop(name);
  const [cart, setCart] = useState<Cart | null | undefined>(undefined);
  useEffect(() => {
    const read = () => setCart(getCart(name));
    read();
    return onStoreChange(read);
  }, [name]);

  const defs = useMemo(
    () => new Map(shop.state === "ok" ? shop.items.map((x) => [x.def.id, x.def] as const) : []),
    [shop],
  );
  const [code, setCode] = useState("");
  const [discount, setDiscount] = useState<{ code: string; d: Discount } | null>(null);
  const [codeErr, setCodeErr] = useState<string | undefined>();
  const [checking, setChecking] = useState(false);
  const [tipPct, setTipPct] = useState<number>(0);
  const [tipCustom, setTipCustom] = useState("");
  const [seal, setSeal] = useState<SealChoice | null>(null);
  const onSeal = useCallback((c: SealChoice | null) => setSeal(c), []);
  const placed = useRef<{ key: string; order: OrderView } | null>(null);

  const token = cart?.token ?? "fUSD";
  const missing = cart && shop.state === "ok" ? cart.lines.flatMap((l, i) => (defs.has(l.productId) ? [] : [i])) : [];
  const changed = cart && shop.state === "ok" ? changedLines(cart, defs) : [];
  const lines = cart ? orderLines(cart, defs) : [];
  const lineDefs = cart ? cart.lines.map((l) => defs.get(l.productId)).filter((d): d is ProductDef => !!d) : [];
  const allowCode = lineDefs.some((d) => d.discountField === "available");
  const allowTip = lineDefs.some((d) => d.tips);
  const base =
    cart && shop.state === "ok" && missing.length === 0
      ? liveTotal({ seller: cart.seller, token, lines, tip: 0n, discountCode: null }, lineDefs, discount?.d ?? null)
      : null;
  const afterDiscount = base?.ok ? base.total.subtotal - base.total.discount : 0n;
  const tip = !allowTip
    ? 0n
    : tipPct >= 0
      ? (afterDiscount * BigInt(tipPct)) / 100n
      : (parseAmount(tipCustom, token) ?? 0n);
  const priced =
    cart && shop.state === "ok" && missing.length === 0
      ? liveTotal(
          { seller: cart.seller, token, lines, tip, discountCode: discount?.code ?? null },
          lineDefs,
          discount?.d ?? null,
        )
      : null;
  const t = priced?.ok ? priced.total : null;
  const deposit = t && t.dueLater > 0n;

  const blocked =
    shop.state !== "ok"
      ? "Checking the products on QoreChain…"
      : missing.length
        ? "Remove what is no longer offered first."
        : priced && !priced.ok
          ? priced.problem
          : !seal
            ? "Choose who it is sealed to."
            : null;

  const obtain = async (): Promise<OrderView> => {
    if (!cart || !seal || !t) throw new Error("The order is not ready yet. Nothing was charged.");
    const key = JSON.stringify({
      lines,
      r: seal.recipient,
      g: seal.gift,
      tip: tip.toString(),
      code: discount?.code ?? null,
    });
    if (placed.current?.key === key && new Date(placed.current.order.expiresAt).getTime() > Date.now() + 60_000)
      return placed.current.order;
    const { request } = buildRequest({
      seller: cart.seller,
      token,
      lines,
      recipient: seal.recipient,
      gift: seal.gift,
      tip,
      discountCode: discount?.code ?? null,
      reviewKeys: seal.reviewKeys,
    });
    const order = await placeOrder(request);
    if (order.total !== t.total.toString())
      throw new Error(
        `The shop priced this at ${formatAmount(order.total, token)}, not ${formatAmount(t.total, token)}. Reload to see why. Nothing was charged.`,
      );
    placed.current = { key, order };
    return order;
  };

  const done = (o: OrderView, tx: string | null) => {
    clearCart(name);
    router.push(`/library/${o.ref}${tx ? "" : "?pay=manual"}`);
  };

  return (
    <div className={s.stage}>
      <Sakura count={3} />
      <div className={s.wrap}>
        <ShopBar name={name} />
        <header className={s.checkoutHead}>
          <div>
            <Kicker>おかいもの</Kicker>
            <h1 className={s.pageTitle}>Checkout</h1>
          </div>
          <ButtonLink variant="line" icon="back" href={`/@${name}?tab=shop`}>
            Continue shopping
          </ButtonLink>
        </header>

        {cart === undefined ? (
          <div className={s.checkoutGrid}>
            <div className={s.card}>
              <Skeleton lines={4} avatar />
            </div>
            <div className={s.card}>
              <Skeleton lines={5} />
            </div>
          </div>
        ) : cart === null ? (
          <div className={s.card}>
            <EmptyState
              title="Your cart is empty"
              face="sleepy"
              jp="からっぽ"
              action={
                <ButtonLink variant="cord" href={`/@${name}?tab=shop`} icon="bag">
                  See @{name}&apos;s shop
                </ButtonLink>
              }
            >
              Pick something you like on {seller.displayName}&apos;s page and it waits here.
            </EmptyState>
          </div>
        ) : (
          <div className={s.checkoutGrid}>
            <section className={s.cartCol} aria-label="Your cart">
              <div className={s.card}>
                {shop.state === "error" ? (
                  <Oops title="The shop could not be checked">{shop.message} Nothing was charged.</Oops>
                ) : null}
                <ul className={s.cartLines}>
                  {cart.lines.map((l, i) => {
                    const d = defs.get(l.productId);
                    const tl = t?.lines[i];
                    const version = d?.versions.find((v) => v.id === l.versionId);
                    return (
                      <li key={`${l.productId}-${i}`} className={s.cartLine} style={{ animationDelay: `${i * 50}ms` }}>
                        {d ? <Thumb def={d} size={76} /> : <span className={s.thumbGone} />}
                        <div className={s.lineText}>
                          <Link href={`/@${name}/p/${l.slug}`} className={s.lineTitle}>
                            {d?.title ?? l.title}
                          </Link>
                          <small>@{name}</small>
                          {version ? (
                            <small>
                              <b>Option:</b> {version.name}
                            </small>
                          ) : null}
                          {l.quantity > 1 || d?.limits.quantity ? (
                            <small>
                              <b>Quantity:</b> {l.quantity}
                            </small>
                          ) : null}
                          {l.slot ? (
                            <small>
                              <b>Time:</b> {slotLabel(l.slot)}
                            </small>
                          ) : null}
                          {d?.kind === "commission" && d.commission ? (
                            <small>
                              <b>Deposit:</b> {d.commission.depositPercent}% now, the rest when it is done
                            </small>
                          ) : null}
                          {shop.state === "ok" && !d ? (
                            <span className={s.lineWarn}>No longer offered. Remove it to continue.</span>
                          ) : null}
                          {changed.includes(i) ? (
                            <span className={s.lineWarn}>
                              The seller changed this since you added it. Check the price.
                            </span>
                          ) : null}
                          <span className={s.lineActions}>
                            {d ? (
                              <ButtonLink size="sm" variant="line" href={`/@${name}/p/${l.slug}?line=${i}`}>
                                Configure
                              </ButtonLink>
                            ) : null}
                            <Button size="sm" variant="ghost" onClick={() => setCart(dropLine(name, i))}>
                              Remove
                            </Button>
                          </span>
                        </div>
                        <b className={s.linePrice}>
                          {tl
                            ? formatAmount(tl.subtotal, token)
                            : l.chosen
                              ? formatAmount(BigInt(l.chosen) * BigInt(l.quantity), token)
                              : "…"}
                        </b>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {allowCode ? (
                <form
                  className={[s.card, s.codeCard].join(" ")}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const c = code.trim().toUpperCase();
                    if (!c) return;
                    setChecking(true);
                    setCodeErr(undefined);
                    checkDiscount(cart.seller, c, token)
                      .then((d) => {
                        if (!d) {
                          setDiscount(null);
                          setCodeErr("That code is not valid for this order.");
                        } else setDiscount({ code: c, d });
                      })
                      .catch((x: unknown) =>
                        setCodeErr(x instanceof ApiFailure ? x.message : "The code could not be checked. Try again."),
                      )
                      .finally(() => setChecking(false));
                  }}
                >
                  <TextField
                    label="Discount code"
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value);
                      setCodeErr(undefined);
                    }}
                    autoCapitalize="characters"
                    autoComplete="off"
                    error={codeErr}
                    ok={
                      discount
                        ? `${discount.code} applied${discount.d.percent !== null ? `: ${discount.d.percent}% off` : ""}`
                        : undefined
                    }
                  />
                  {discount ? (
                    <Button variant="ghost" onClick={() => (setDiscount(null), setCode(""))}>
                      Remove
                    </Button>
                  ) : (
                    <Button type="submit" variant="line" busy={checking} disabled={!code.trim()}>
                      Apply
                    </Button>
                  )}
                </form>
              ) : null}

              {allowTip ? (
                <div className={[s.card, s.tipCard].join(" ")}>
                  <b>Add a tip for {seller.displayName.split(" ")[0]}</b>
                  <div className={s.quick} role="group" aria-label="Tip">
                    {TIPS.map((p) => (
                      <button key={p} type="button" aria-pressed={tipPct === p} onClick={() => setTipPct(p)}>
                        {p === 0 ? "No tip" : `${p}%`}
                      </button>
                    ))}
                    <button type="button" aria-pressed={tipPct < 0} onClick={() => setTipPct(-1)}>
                      Other
                    </button>
                  </div>
                  {tipPct < 0 ? (
                    <TextField
                      label={`Tip amount (${token})`}
                      inputMode="decimal"
                      value={tipCustom}
                      onChange={(e) => {
                        const v = e.target.value.replace(/,/g, ".");
                        if (/^\d{0,12}(\.\d{0,6})?$/.test(v)) setTipCustom(v);
                      }}
                    />
                  ) : null}
                </div>
              ) : null}

              <div className={[s.card, s.totals].join(" ")}>
                {t ? (
                  <dl>
                    <div>
                      <dt>Subtotal</dt>
                      <dd>{formatAmount(t.subtotal, token)}</dd>
                    </div>
                    {t.discount > 0n ? (
                      <div>
                        <dt>Discount {discount?.code}</dt>
                        <dd>−{formatAmount(t.discount, token)}</dd>
                      </div>
                    ) : null}
                    {t.tip > 0n ? (
                      <div>
                        <dt>Tip</dt>
                        <dd>{formatAmount(t.tip, token)}</dd>
                      </div>
                    ) : null}
                    <div className={s.totalRow}>
                      <dt>Total</dt>
                      <dd>{formatAmount(t.total, token)}</dd>
                    </div>
                    {deposit ? (
                      <>
                        <div>
                          <dt>Due now (deposit)</dt>
                          <dd>{formatAmount(t.dueNow, token)}</dd>
                        </div>
                        <div>
                          <dt>Due when it is done</dt>
                          <dd>{formatAmount(t.dueLater, token)}</dd>
                        </div>
                      </>
                    ) : null}
                  </dl>
                ) : priced && !priced.ok ? (
                  <Oops title="This cart cannot be priced">{priced.problem}</Oops>
                ) : (
                  <Skeleton lines={2} />
                )}
              </div>
              {lineDefs.some((d) => d.refund) ? (
                <div className={[s.card, s.refundNote].join(" ")}>
                  {lineDefs
                    .filter((d) => d.refund)
                    .map((d) => (
                      <p key={d.id}>
                        <Icon name="undo" size={16} />
                        <span>
                          <b>{d.title}:</b> refund within {d.refund?.days} days, sent back by the seller from their
                          wallet. {d.refund?.finePrint}
                        </span>
                      </p>
                    ))}
                </div>
              ) : null}
            </section>

            <section className={s.payCol} aria-label="Seal and pay">
              <div className={s.card}>
                <h2 className={s.colTitle}>Who opens it</h2>
                <SealTo shop={name} next={`/@${name}/checkout`} onChange={onSeal} />
              </div>
              <div className={s.card}>
                <h2 className={s.colTitle}>{deposit ? "Pay the deposit" : "Pay"}</h2>
                <PayPanel
                  token={token}
                  units={t?.dueNow ?? 0n}
                  seller={cart.seller}
                  sellerName={name}
                  obtain={obtain}
                  blocked={blocked ?? (t ? null : "Working out the total…")}
                  onPaid={(o, tx) => done(o, tx)}
                  onManual={(o) => done(o, null)}
                />
                <p className={s.fine}>
                  Paying holds your order for an hour.{" "}
                  {t && t.dueNow > 0n ? `The memo mzk:ord:… ties your payment to it on QoreChain.` : ""}
                </p>
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
