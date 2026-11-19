"use client";
import Link from "next/link";
/**
 * One order at /library/<ref>, surviving reloads (spec 5.11 "After payment"
 * and Gumroad's content page). Before delivery it tracks four steps:
 * submitted, confirmed on QoreChain, preparing your copy, ready; an unpaid
 * order shows how to pay it, a commission shows the deposit and the rest. Once
 * delivered it opens on this device: rating on the left, the content pages,
 * files and links on the right.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Button,
  ButtonLink,
  CopyValue,
  EmptyState,
  Icon,
  Kicker,
  LockLine,
  Musubi,
  Oops,
  Sakura,
  Skeleton,
  Stepper,
  TextArea,
  TextField,
  useToast,
  type StepItem,
} from "@mizuhiki/ui";
import { canonicalJson, decryptFile, formatAmount, isValidPhrase, normalizePhrase, sha256Hex, utf8, type Content, type FileFacts, type ProductDef } from "@mizuhiki/core";
import { explorerTx } from "@mizuhiki/chain";
import type { SealKeyPair } from "@qorechain/qoreseal";
import { useAccount } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import { fmtBytes } from "@/public/MessageSheet";
import {
  buyerKeyFrom,
  getOrder,
  openPurchase,
  orderReviews,
  postReview,
  rememberBuyerKey,
  reportTx,
  reviewSecret,
  verifyProduct,
  type BuyerKey,
  type OpenedPurchase,
  type OrderView,
} from "../engine";
import { afterPaySteps, fingerprint, holdLeft } from "./model";
import { PayPanel } from "./PayPanel";
import { RichText, ShopBar, Stars, Thumb, keysForOrder, slotLabel } from "./parts";
import { localOrder, onStoreChange, rememberOrder, rememberReview } from "./store";
import s from "./buyer.module.css";

type Load = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "bad"; message: string } | { state: "ok"; o: OrderView; defs: Map<string, ProductDef> };

/** Read an order and check every product record it was priced with against its seller's key on chain. */
export async function loadOrder(ref: string): Promise<{ o: OrderView; defs: Map<string, ProductDef> }> {
  const o = await getOrder(ref);
  const defs = new Map<string, ProductDef>();
  for (const r of o.records) {
    const d = await verifyProduct(r);
    if (d.owner !== o.seller) throw new Error("This order names a product that is not the seller's.");
    defs.set(d.id, d);
  }
  return { o, defs };
}

export function OrderPage({ orderRef, manual }: { orderRef: string; manual: boolean }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [sent, setSent] = useState<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    const read = () => setSent(localOrder(orderRef)?.txs ?? []);
    read();
    return onStoreChange(read);
  }, [orderRef]);

  const refresh = useCallback(async () => {
    try {
      const first = load.state !== "ok";
      if (first) {
        const r = await loadOrder(orderRef);
        rememberOrder(orderRef, r.defs.values().next().value?.name ?? "");
        setLoad({ state: "ok", ...r });
        return r.o;
      }
      // Report a transaction this device sent that the server has not seen yet.
      const cur = load.o;
      const unseen = sent.find((h) => h !== cur.depositTx?.toUpperCase() && h !== cur.balanceTx?.toUpperCase());
      const o = unseen && (cur.status === "awaiting" || cur.status === "in_progress") ? await reportTx(orderRef, unseen) : await getOrder(orderRef);
      setLoad({ state: "ok", o, defs: load.defs });
      return o;
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) setLoad({ state: "missing" });
      else if (e instanceof ApiFailure) setLoad((l) => (l.state === "ok" ? l : { state: "error", message: e.message }));
      else setLoad({ state: "bad", message: (e as Error).message || "A product record in this order did not check out." });
      return null;
    }
  }, [orderRef, load, sent]);

  // Poll while something is still moving; slower while the seller's device prepares the copy.
  useEffect(() => {
    clearTimeout(timer.current);
    if (load.state === "loading") {
      void refresh();
      return;
    }
    if (load.state !== "ok") return;
    const st = load.o.status;
    const moving = st === "awaiting" || st === "paid" || st === "in_progress";
    if (!moving) return;
    const wait = st === "paid" ? 8000 : 4000;
    timer.current = setTimeout(() => void refresh(), wait);
    return () => clearTimeout(timer.current);
  }, [load, refresh]);

  const sellerName = load.state === "ok" ? (load.defs.values().next().value?.name ?? "") : "";
  return (
    <div className={s.stage}>
      <Sakura count={3} />
      <div className={s.wrap}>
        <ShopBar {...(sellerName ? { name: sellerName } : {})} />
        {load.state === "loading" ? (
          <div className={s.card} aria-busy="true">
            <Skeleton lines={5} avatar />
            <p className={s.checking}>
              <span className={s.spin} aria-hidden="true" />
              Reading the order and checking its products on QoreChain…
            </p>
          </div>
        ) : load.state === "missing" ? (
          <div className={s.card}>
            <EmptyState
              title="No order with this reference"
              face="sleepy"
              action={
                <ButtonLink variant="cord" href="/library" icon="bag">
                  Open my library
                </ButtonLink>
              }
            >
              Check the link. Orders that were never paid disappear after their hold ends; nothing was charged for them.
            </EmptyState>
          </div>
        ) : load.state === "error" ? (
          <div className={s.card}>
            <Oops title="This order could not be loaded" action={<Button variant="line" onClick={() => (setLoad({ state: "loading" }))}>Try again</Button>}>
              {load.message} If you paid, your payment is safe on QoreChain and this page picks it up once Mizuhiki answers.
            </Oops>
          </div>
        ) : load.state === "bad" ? (
          <div className={s.hardFail} role="alert">
            <Musubi face="worried" size={100} />
            <h1>This order could not be verified</h1>
            <p>A product record in it does not match its seller&apos;s key on QoreChain, so nothing is opened here.</p>
            <p className={s.mono}>{load.message}</p>
          </div>
        ) : load.o.delivery && (load.o.status === "delivered" || load.o.status === "refunded") ? (
          <Purchase o={load.o} defs={load.defs} />
        ) : (
          <Track o={load.o} defs={load.defs} sent={sent} manual={manual} onChanged={() => void refresh()} />
        )}
      </div>
    </div>
  );
}

// ---- before delivery ---------------------------------------------------------------------------

function Track({ o, defs, sent, manual, onChanged }: { o: OrderView; defs: Map<string, ProductDef>; sent: string[]; manual: boolean; onChanged: () => void }) {
  const lines = o.request.lines.map((l) => ({ l, d: defs.get(l.productId) }));
  const first = lines[0]?.d;
  const name = first?.name ?? "";
  const instant = lines.every((x) => x.d?.delivery === "instant");
  const tx = o.depositTx ?? sent[0] ?? null;
  const st = afterPaySteps(o, sent[0] ?? null);
  const sellerFirst = `@${name}`;
  const steps: StepItem[] = [
    {
      title: "Submitted",
      state: st[0] ?? "waiting",
      detail: tx ? <TxLink hash={tx} /> : o.status === "expired" ? "The hold ended before a payment arrived." : "Waiting for your payment.",
    },
    { title: "Confirmed on QoreChain", state: st[1] ?? "waiting", detail: o.depositTx ? <TxLink hash={o.depositTx} /> : "QoreChain confirms a payment in a few seconds." },
    {
      title: "Preparing your copy",
      state: st[2] ?? "waiting",
      detail:
        o.status === "in_progress"
          ? "Starts once the rest is paid."
          : instant
            ? "The seller's helper seals it to you. This takes a moment."
            : `${sellerFirst}'s own device seals it to you when their dashboard is open, so this can take a while. You can close this page; it is in your library.`,
    },
    { title: "Ready", state: st[3] ?? "waiting", detail: "Opens on this device." },
  ];
  const expired = o.status === "expired";
  const rest = o.status === "in_progress";
  const paidRest = sent.length > 1 || !!o.balanceTx;
  return (
    <div className={s.trackGrid}>
      <section className={s.card} aria-labelledby="track-title">
        <Kicker>{expired ? "あれ？" : o.status === "awaiting" && !tx ? "おまちしています" : "ちょっと待ってね"}</Kicker>
        <h1 id="track-title" className={s.pageTitle}>
          {expired
            ? "This order's hold ended"
            : o.status === "awaiting" && !tx
              ? "Waiting for your payment"
              : rest
                ? "Deposit paid"
                : o.status === "refunded"
                  ? "Refunded"
                  : "Paid. Preparing your copy"}
        </h1>
        <OrderSummary o={o} defs={defs} />
        {expired ? (
          <Oops
            title="Nothing was charged"
            action={
              first ? (
                <ButtonLink variant="line" href={`/@${name}/p/${first.slug}`}>
                  Start again
                </ButtonLink>
              ) : undefined
            }
          >
            The order was held for an hour and no payment with its memo reached QoreChain, so the items went back on sale.
          </Oops>
        ) : (
          <Stepper steps={steps} />
        )}
        {o.status === "refunded" && o.refundTx ? (
          <p className={s.note}>
            <Icon name="undo" size={18} />
            <span>
              The seller sent your money back. <TxLink hash={o.refundTx} />
            </span>
          </p>
        ) : null}
        {rest ? (
          <p className={s.note}>
            <Icon name="coin" size={18} />
            <span>
              {o.balanceRequested
                ? paidRest
                  ? "Paying the rest… this page updates when QoreChain confirms it."
                  : `${sellerFirst} finished and asks for the rest: ${formatAmount(o.dueLater, o.token)}.`
                : `Deposit paid. You'll pay the rest (${formatAmount(o.dueLater, o.token)}) when ${sellerFirst} asks. This page and your library show it then.`}
            </span>
          </p>
        ) : null}
        <div className={s.rowWrap}>
          <ButtonLink variant="ghost" icon="folder" href="/library">
            Library
          </ButtonLink>
          {o.status !== "awaiting" && o.status !== "expired" ? (
            <ButtonLink variant="ghost" icon="file" href={`/library/${o.ref}/receipt`}>
              Receipt
            </ButtonLink>
          ) : null}
        </div>
      </section>

      {o.status === "awaiting" && !tx ? (
        <section className={s.card} aria-label="Pay for this order">
          <h2 className={s.colTitle}>Pay {formatAmount(o.dueNow, o.token)}</h2>
          <p className={s.fine}>Held for you for {holdLeft(o.expiresAt)} more. Pay any of these ways; this page checks QoreChain every few seconds.</p>
          <ManualBox o={o} amount={BigInt(o.dueNow)} memo={o.memo} open={manual} />
          <PayPanel
            token={o.token}
            units={BigInt(o.dueNow)}
            seller={o.seller}
            sellerName={name}
            obtain={() => Promise.resolve(o)}
            blocked={null}
            onPaid={onChanged}
            onManual={onChanged}
            compact
            allowManual={false}
          />
        </section>
      ) : rest && o.balanceRequested && !paidRest ? (
        <section className={s.card} aria-label="Pay the rest">
          <h2 className={s.colTitle}>Pay the rest</h2>
          <ManualBox o={o} amount={BigInt(o.dueLater)} memo={`mzk:ord:${o.ref}-2`} open={false} />
          <PayPanel
            token={o.token}
            units={BigInt(o.dueLater)}
            seller={o.seller}
            sellerName={name}
            part="rest"
            obtain={() => Promise.resolve(o)}
            blocked={null}
            onPaid={onChanged}
            onManual={onChanged}
            compact
            allowManual={false}
          />
        </section>
      ) : (
        <aside className={[s.card, s.waitArt].join(" ")} aria-hidden="true">
          <Musubi face={expired ? "worried" : o.status === "paid" ? "cover" : "normal"} size={150} bob />
          <p lang="ja">{expired ? "またね" : "ちょっと待ってね"}</p>
        </aside>
      )}
    </div>
  );
}

function ManualBox({ o, amount, memo, open }: { o: OrderView; amount: bigint; memo: string; open: boolean }) {
  return (
    <details className={s.manual} open={open}>
      <summary>
        <Icon name="copy" size={16} /> Send it from any wallet
      </summary>
      <dl className={s.sum}>
        <div>
          <dt>To</dt>
          <dd>
            <CopyValue value={o.payTo} label="the seller's address" />
          </dd>
        </div>
        <div>
          <dt>Amount</dt>
          <dd>
            <CopyValue value={formatAmount(amount, o.token).replace(` ${o.token}`, "")} label="the amount" /> {o.token}
          </dd>
        </div>
        <div>
          <dt>Memo (paste exactly)</dt>
          <dd>
            <CopyValue value={memo} label="the memo" />
          </dd>
        </div>
      </dl>
      <p className={s.fine}>Without the memo the money still reaches the seller, but this order will not see it. Send the exact amount or more.</p>
      <p className={s.waitLine} aria-live="polite">
        <span className={s.spin} aria-hidden="true" /> Watching QoreChain for {memo}…
      </p>
    </details>
  );
}

function TxLink({ hash }: { hash: string }) {
  return (
    <a className={s.txLink} href={explorerTx(hash)} target="_blank" rel="noreferrer">
      <Icon name="link" size={13} /> {hash.slice(0, 10)}…{hash.slice(-6)}
    </a>
  );
}

function OrderSummary({ o, defs }: { o: OrderView; defs: Map<string, ProductDef> }) {
  return (
    <ul className={s.orderItems}>
      {o.request.lines.map((l, i) => {
        const d = defs.get(l.productId);
        if (!d) return null;
        const v = d.versions.find((x) => x.id === l.versionId);
        return (
          <li key={i}>
            <Thumb def={d} size={52} />
            <span>
              <b>{d.title}</b>
              <small>
                {[v?.name, l.quantity > 1 ? `× ${l.quantity}` : null, l.slot ? slotLabel(l.slot) : null].filter(Boolean).join(" · ") || `@${d.name}`}
              </small>
            </span>
          </li>
        );
      })}
      <li className={s.orderTotal}>
        <span>Total</span>
        <b>{formatAmount(o.total, o.token)}</b>
      </li>
    </ul>
  );
}

// ---- after delivery: the content page ------------------------------------------------------------

type Opening = { state: "finding" } | { state: "need" } | { state: "opening" } | { state: "open"; p: OpenedPurchase; keys: SealKeyPair } | { state: "failed"; why: string };

function Purchase({ o, defs }: { o: OrderView; defs: Map<string, ProductDef> }) {
  const acct = useAccount();
  const [extra, setExtra] = useState<BuyerKey[]>([]);
  const [open, setOpen] = useState<Opening>({ state: "finding" });
  const first = defs.get(o.request.lines[0]?.productId ?? "") ?? [...defs.values()][0];
  const name = first?.name ?? "";

  useEffect(() => {
    const life = { alive: true };
    const live = () => life.alive;
    void (async () => {
      const keys = await keysForOrder(o, acct.account, extra);
      if (!live()) return;
      if (!keys) return setOpen({ state: "need" });
      setOpen({ state: "opening" });
      try {
        const p = await openPurchase(o, keys, defs);
        if (live()) setOpen({ state: "open", p, keys });
      } catch (e) {
        if (live()) setOpen({ state: "failed", why: (e as Error).message || "It did not open with this key." });
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [o, defs, acct.account, extra]);

  const isKey = o.request.recipient.kind === "key";
  return (
    <div className={s.purchaseGrid}>
      <aside className={s.purchaseSide}>
        {open.state === "open" && !o.request.gift ? <RateBox o={o} defs={defs} keys={open.keys} /> : null}
        {isKey && acct.status !== "unlocked" ? (
          <div className={s.card}>
            <b className={s.sideHead}>Make it a Mizuhiki account</b>
            <p className={s.fine}>
              Your 12 words can also be a full Mizuhiki account: a private page, an inbox and every purchase in one place. Log in with
              &ldquo;Use your recovery phrase&rdquo; and type the same words.
            </p>
            <ButtonLink variant="line" icon="key" href={`/login?next=${encodeURIComponent(`/library/${o.ref}`)}`}>
              Use my 12 words
            </ButtonLink>
          </div>
        ) : null}
        <nav className={[s.card, s.sideLinks].join(" ")} aria-label="This purchase">
          <Link href={`/library/${o.ref}/receipt`}>
            <span>Receipt</span>
            <Icon name="chev" size={18} />
          </Link>
          <a href="/library">
            <span>Library</span>
            <Icon name="chev" size={18} />
          </a>
          {name ? (
            <Link href={`/@${name}`}>
              <span>@{name}</span>
              <Icon name="chev" size={18} />
            </Link>
          ) : null}
        </nav>
        {o.status === "refunded" ? (
          <p className={s.note}>
            <Icon name="undo" size={18} />
            <span>This order was refunded{o.refundTx ? <> · <TxLink hash={o.refundTx} /></> : null}.</span>
          </p>
        ) : null}
      </aside>

      <section className={s.purchaseMain} aria-live="polite">
        {open.state === "finding" || open.state === "opening" ? (
          <div className={s.card}>
            <Skeleton lines={6} />
            <p className={s.checking}>
              <span className={s.spin} aria-hidden="true" />
              {open.state === "finding" ? "Looking for the key that opens it on this device…" : "Opening it on this device…"}
            </p>
          </div>
        ) : open.state === "need" ? (
          <NeedKey o={o} onKey={(k) => setExtra((x) => [...x, k])} />
        ) : open.state === "failed" ? (
          <div className={s.card}>
            <Oops title="It did not open here">
              {open.why} Your copy is unchanged on Mizuhiki; nothing was opened or sent. If the seller sealed it to an older key, message them with the order
              reference {o.ref}.
            </Oops>
          </div>
        ) : (
          <Opened o={o} p={open.p} />
        )}
      </section>
    </div>
  );
}

function NeedKey({ o, onKey }: { o: OrderView; onKey: (k: BuyerKey) => void }) {
  const acct = useAccount();
  const r = o.request.recipient;
  const [text, setText] = useState("");
  const [keep, setKeep] = useState(true);
  const [err, setErr] = useState<string | undefined>();
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  if (r.kind === "account") {
    const mine = acct.account?.owner.address === r.address;
    return (
      <div className={s.card}>
        <Kicker>封</Kicker>
        <h1 className={s.pageTitle}>{o.request.gift && !mine ? "Sent as a gift" : "Unlock to open it"}</h1>
        <p className={s.fine}>
          It is sealed to <code className={s.mono}>{r.address}</code>. Only that account&apos;s key opens it.
        </p>
        {acct.status === "locked" ? (
          <form
            className={s.unlockRow}
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setErr(undefined);
              acct
                .unlock(pass)
                .catch((x: unknown) => setErr((x as Error).message))
                .finally(() => setBusy(false));
            }}
          >
            <TextField label="Device passphrase" type="password" value={pass} onChange={(e) => setPass(e.target.value)} error={err} autoComplete="current-password" />
            <Button type="submit" variant="cord" icon="key" busy={busy} disabled={!pass}>
              Unlock
            </Button>
          </form>
        ) : acct.status === "unlocked" ? (
          <Oops title="This is not the account it is sealed to">
            You are using {acct.account?.owner.address.slice(0, 12)}…. {o.request.gift ? "It was a gift for the account above; only they can open it." : "Log in with the account above on this device."}
          </Oops>
        ) : (
          <ButtonLink variant="cord" icon="key" href={`/login?next=${encodeURIComponent(`/library/${o.ref}`)}`}>
            Log in to open it
          </ButtonLink>
        )}
      </div>
    );
  }
  const words = normalizePhrase(text) ? normalizePhrase(text).split(" ").length : 0;
  return (
    <form
      className={s.card}
      onSubmit={(e) => {
        e.preventDefault();
        setErr(undefined);
        if (!isValidPhrase(text) || words !== 12) return setErr("Type all 12 words of your buyer key, in order.");
        const k = buyerKeyFrom(text);
        if (k.recipient.mlkem !== r.mlkem || k.recipient.x25519 !== r.x25519) return setErr("These words are a different buyer key than the one this purchase is sealed to.");
        setBusy(true);
        void (keep ? rememberBuyerKey(k) : Promise.resolve())
          .catch(() => undefined)
          .then(() => onKey(k))
          .finally(() => setBusy(false));
      }}
    >
      <Kicker>封</Kicker>
      <h1 className={s.pageTitle}>Open with my 12 words</h1>
      <p className={s.fine}>
        This purchase is sealed to buyer key <code className={s.mono}>{fingerprint(keyHashOf(r), 16)}</code>. Type its words; they are checked on this
        device and never sent.
      </p>
      <TextArea label="Your 12 words, in order" rows={3} value={text} onChange={(e) => setText(e.target.value)} error={err} autoComplete="off" spellCheck={false} />
      <label className={s.check}>
        <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> Keep the key on this device
      </label>
      <Button type="submit" variant="cord" icon="key" busy={busy} disabled={words !== 12}>
        Open it
      </Button>
    </form>
  );
}

/** The key hash the server files buyer-key orders under (same as the engine's BuyerKey.hash). */
function keyHashOf(r: { mlkem: string; x25519: string }): string {
  return buyerKeyHash(r.mlkem, r.x25519);
}
const buyerKeyHash = (mlkem: string, x25519: string) => sha256Hex(utf8(canonicalJson({ mlkem, x25519 })));

function Opened({ o, p }: { o: OrderView; p: OpenedPurchase }) {
  const [pi, setPi] = useState(0);
  const prod = p.products[Math.min(pi, p.products.length - 1)];
  if (!prod)
    return (
      <div className={s.card}>
        <EmptyState title="Nothing to open" face="sleepy">
          The delivery holds no product keys this device knows. Message the seller with order {o.ref}.
        </EmptyState>
      </div>
    );
  const content: Content | null = prod.content;
  const hasPages = (content?.pages.length ?? 0) > 0;
  const line = o.request.lines.find((l) => l.productId === prod.def.id);
  return (
    <div className={[s.card, s.opened].join(" ")}>
      <header className={s.openedHead}>
        <Kicker>できた！</Kicker>
        <h1 className={s.pageTitle}>{prod.def.title}</h1>
        <LockLine>Opened on this device. Mizuhiki only ever held the sealed copy.</LockLine>
      </header>
      {p.products.length > 1 ? (
        <div className={s.quick} role="tablist" aria-label="Products in this order">
          {p.products.map((x, i) => (
            <button key={x.def.id} type="button" role="tab" aria-selected={i === pi} onClick={() => setPi(i)}>
              {x.def.title}
            </button>
          ))}
        </div>
      ) : null}
      {prod.def.receipt.message ? <RichText text={prod.def.receipt.message} className={s.thanks} /> : null}
      {line?.slot ? (
        <p className={s.note}>
          <Icon name="calendar" size={18} />
          <span>
            <b>Your call: {slotLabel(line.slot)}</b> ({prod.def.booking?.minutes ?? 30} min, your time zone).{prod.def.booking?.place ? ` Where: ${prod.def.booking.place}` : ""}
          </span>
        </p>
      ) : null}
      {hasPages ? (
        <ContentReader key={prod.def.id} content={content} />
      ) : (
        <p className={s.fine}>
          {prod.def.kind === "tip"
            ? "Thank you for the support. ありがとう"
            : prod.def.kind === "call"
              ? "Your time is booked. The seller has your order."
              : "There is nothing to download for this one."}
        </p>
      )}
    </div>
  );
}

/** A content page set, with page navigation (purchases, and product passes). */
export function ContentReader({ content }: { content: Content | null }) {
  const [page, setPage] = useState(0);
  const pages = content?.pages ?? [];
  const cur = pages[Math.min(page, pages.length - 1)];
  if (!cur) return null;
  return (
    <>
      {pages.length > 1 ? (
        <nav className={s.pageNav} aria-label="Pages">
          {pages.map((pg, i) => (
            <button key={pg.id} type="button" aria-current={i === page ? "page" : undefined} onClick={() => setPage(i)}>
              <span>{i + 1}</span>
              {pg.title || `Page ${i + 1}`}
            </button>
          ))}
        </nav>
      ) : null}
      <article className={s.contentPage} key={cur.id}>
        {cur.title && pages.length > 1 ? <h2>{cur.title}</h2> : null}
        {cur.blocks.map((b, i) =>
          b.t === "text" ? (
            <RichText key={i} text={b.text} />
          ) : b.t === "heading" ? (
            <h3 key={i}>{b.text}</h3>
          ) : b.t === "link" ? (
            <ButtonLink key={i} variant="line" iconRight="share" href={b.url} target="_blank" rel="noopener noreferrer nofollow">
              {b.label || new URL(b.url).host}
            </ButtonLink>
          ) : (
            <FileCard key={i} f={b.file as unknown as FileFacts} />
          ),
        )}
        {pages.length > 1 ? (
          <div className={s.pagePager}>
            <Button variant="ghost" icon="back" disabled={page === 0} onClick={() => setPage((x) => x - 1)}>
              Previous
            </Button>
            <Button variant="line" iconRight="arrow" disabled={page >= pages.length - 1} onClick={() => setPage((x) => x + 1)}>
              Next
            </Button>
          </div>
        ) : null}
      </article>
    </>
  );
}

function isFileFacts(f: unknown): f is FileFacts {
  if (typeof f !== "object" || f === null) return false;
  const x = f as FileFacts;
  return typeof x.name === "string" && Array.isArray(x.chunks) && typeof x.key === "string" && typeof x.size === "number";
}

/** A sealed file: "Decrypt and download" with progress (the inbox's FileItem, for purchases). */
function FileCard({ f }: { f: FileFacts }) {
  const [st, setSt] = useState<{ s: "idle" } | { s: "busy"; p: number } | { s: "ready"; url: string } | { s: "failed"; why: string }>({ s: "idle" });
  useEffect(
    () => () => {
      if (st.s === "ready") URL.revokeObjectURL(st.url);
    },
    [st],
  );
  if (!isFileFacts(f)) return <p className={s.problem}>A file here is damaged and cannot be opened.</p>;
  const save = async () => {
    let url = st.s === "ready" ? st.url : null;
    if (!url) {
      setSt({ s: "busy", p: 0 });
      try {
        const parts = await decryptFile({ facts: f, fetchChunk: (h) => api.bytes(`/blobs/${h}`), onProgress: (d, t) => setSt({ s: "busy", p: d / Math.max(1, t) }) });
        url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: f.type || "application/octet-stream" }));
        setSt({ s: "ready", url });
      } catch {
        setSt({ s: "failed", why: "This file could not be decrypted. A piece is missing or was changed. Nothing was saved." });
        return;
      }
    }
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    a.click();
  };
  const pct = st.s === "busy" ? Math.round(st.p * 100) : 0;
  return (
    <div className={s.fileCard}>
      <span className={s.fileIcon}>
        <Icon name={f.type.startsWith("image/") ? "image" : "file"} size={22} />
      </span>
      <span className={s.fileText}>
        <b>{f.name}</b>
        <small>
          {f.type || "File"} · {fmtBytes(f.size)} · {st.s === "busy" ? `Decrypting ${pct}%` : st.s === "ready" ? "Decrypted on this device" : "Sealed"}
        </small>
        {st.s === "busy" ? (
          <span className={s.progress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={`Decrypting ${f.name}`}>
            <i style={{ transform: `scaleX(${st.p})` }} />
          </span>
        ) : null}
        {st.s === "failed" ? <span className={s.lineWarn}>{st.why}</span> : null}
      </span>
      <Button variant={st.s === "ready" ? "line" : "cord"} size="sm" icon="download" busy={st.s === "busy"} onClick={() => void save()}>
        {st.s === "ready" ? "Download again" : "Decrypt and download"}
      </Button>
    </div>
  );
}

function RateBox({ o, defs, keys }: { o: OrderView; defs: Map<string, ProductDef>; keys: SealKeyPair }) {
  const toast = useToast();
  const items = o.request.lines.map((l) => defs.get(l.productId)).filter((d): d is ProductDef => !!d);
  const [pid, setPid] = useState(items[0]?.id ?? "");
  const [posted, setPosted] = useState<Record<string, { rating: number; text: string }>>({});
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    void orderReviews(o.ref).then(
      (rs) => setPosted(Object.fromEntries(rs.map((r) => [r.productId, { rating: r.rating, text: r.text }]))),
      () => undefined,
    );
  }, [o.ref]);
  const def = defs.get(pid);
  const mine = posted[pid];
  const showForm = !mine || editing;
  const shownReview = showForm ? null : mine;
  return (
    <div className={[s.card, s.rateBox].join(" ")}>
      {items.length > 1 ? (
        <select className={s.select} value={pid} onChange={(e) => (setPid(e.target.value), setEditing(false), setRating(0), setText(""))} aria-label="Product to rate">
          {items.map((d) => (
            <option key={d.id} value={d.id}>
              {d.title}
            </option>
          ))}
        </select>
      ) : null}
      {showForm ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!rating || !def) return;
            setBusy(true);
            setErr(null);
            postReview(o.ref, reviewSecret(keys, o.request.nonce), pid, rating, text)
              .then(() => {
                setPosted((p) => ({ ...p, [pid]: { rating, text: text.trim() } }));
                rememberReview({ ref: o.ref, productId: pid, name: def.name, slug: def.slug, title: def.title, rating, text: text.trim(), at: new Date().toISOString() });
                setEditing(false);
                toast.show("Review posted");
              })
              .catch((x: unknown) => setErr(x instanceof ApiFailure ? x.message : "The review was not posted. Try again."))
              .finally(() => setBusy(false));
          }}
        >
          <b className={s.sideHead}>Liked it? Give it a rating:</b>
          <div className={s.rateStars} role="radiogroup" aria-label="Rating" onPointerLeave={() => setHover(0)}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={rating === n}
                aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
                className={(hover || rating) >= n ? s.starOn : ""}
                onPointerEnter={() => setHover(n)}
                onClick={() => setRating(n)}
              >
                <Icon name="star" size={26} />
              </button>
            ))}
          </div>
          <TextArea label="Want to leave a written review?" hideLabel placeholder="Want to leave a written review?" rows={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          {err ? <p className={s.problem}>{err}</p> : null}
          <Button type="submit" variant="cord" full busy={busy} disabled={!rating}>
            Post review
          </Button>
          <small className={s.fine}>Posted as a verified buyer, without your name or address.</small>
        </form>
      ) : shownReview ? (
        <div className={s.posted}>
          <b className={s.sideHead}>Your review</b>
          <Stars value={shownReview.rating} size={20} />
          {shownReview.text ? <p>{shownReview.text}</p> : null}
          <Button
            size="sm"
            variant="ghost"
            icon="pen"
            onClick={() => {
              setRating(shownReview.rating);
              setText(shownReview.text);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        </div>
      ) : null}
    </div>
  );
}

