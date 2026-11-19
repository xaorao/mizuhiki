"use client";
/**
 * The receipt at /library/<ref>/receipt (spec 5.11; Gumroad's receipt):
 * order id, date, total, the product card, its button and custom message, the
 * seller's contact, and ours: the transaction with an explorer link, what it
 * is sealed to, and the content fingerprint. A product with a refund promise
 * offers "Request a refund", a sealed message to the seller naming the order.
 */
import { useEffect, useState } from "react";
import { Avatar, Button, ButtonLink, EmptyState, Icon, Oops, Receipt, Sakura, Sheet, Skeleton, TextArea, useToast } from "@mizuhiki/ui";
import { canonicalJson, formatAmount, sha256Hex, utf8, type ProductDef } from "@mizuhiki/core";
import { explorerTx } from "@mizuhiki/chain";
import { useAccount } from "@/account/AccountProvider";
import { ApiFailure, mediaUrl } from "@/lib/api";
import { SEND_STEP_LABEL, SendFailure, sendSealed, type SendStep } from "@/lib/send";
import type { OrderView } from "../engine";
import { fingerprint } from "./model";
import { loadOrder } from "./OrderPage";
import { RichText, ShopBar, Thumb, sellerPage, slotLabel, when, type SellerPage } from "./parts";
import s from "./buyer.module.css";

export function ReceiptPage({ orderRef }: { orderRef: string }) {
  const [load, setLoad] = useState<{ state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ok"; o: OrderView; defs: Map<string, ProductDef> }>({
    state: "loading",
  });
  const [seller, setSeller] = useState<SellerPage | null>(null);
  const [refund, setRefund] = useState(false);
  useEffect(() => {
    loadOrder(orderRef).then(
      (r) => {
        setLoad({ state: "ok", ...r });
        const n = r.defs.values().next().value?.name;
        if (n) void sellerPage(n).then(setSeller);
      },
      (e: unknown) =>
        setLoad(e instanceof ApiFailure && e.status === 404 ? { state: "missing" } : { state: "error", message: (e as Error).message || "The receipt could not be loaded." }),
    );
  }, [orderRef]);

  const name = load.state === "ok" ? (load.defs.values().next().value?.name ?? "") : "";
  return (
    <div className={s.stage}>
      <Sakura count={3} />
      <div className={[s.wrap, s.narrow].join(" ")}>
        <ShopBar {...(name ? { name } : {})} />
        {load.state === "loading" ? (
          <div className={s.card}>
            <Skeleton lines={7} />
          </div>
        ) : load.state === "missing" ? (
          <div className={s.card}>
            <EmptyState title="No order with this reference" face="sleepy" action={<ButtonLink variant="cord" href="/library">Open my library</ButtonLink>}>
              Check the link. Nothing was charged for orders that were never paid.
            </EmptyState>
          </div>
        ) : load.state === "error" ? (
          <div className={s.card}>
            <Oops title="The receipt could not be shown">{load.message} Your purchase itself is unchanged.</Oops>
          </div>
        ) : (
          <ReceiptBody o={load.o} defs={load.defs} name={name} seller={seller} onRefund={() => setRefund(true)} />
        )}
      </div>
      {load.state === "ok" ? <RefundSheet open={refund} onClose={() => setRefund(false)} o={load.o} name={name} seller={seller} /> : null}
    </div>
  );
}

function ReceiptBody({ o, defs, name, seller, onRefund }: { o: OrderView; defs: Map<string, ProductDef>; name: string; seller: SellerPage | null; onRefund: () => void }) {
  const toast = useToast();
  const items = o.request.lines.map((l) => ({ l, d: defs.get(l.productId) })).filter((x): x is { l: (typeof o.request.lines)[number]; d: ProductDef } => !!x.d);
  const r = o.request.recipient;
  const sealedTo = r.kind === "account" ? r.address : `buyer key ${fingerprint(sha256Hex(utf8(canonicalJson({ mlkem: r.mlkem, x25519: r.x25519 }))), 24)}`;
  const refundable = items.find((x) => x.d.refund);
  const paidAt = o.paidAt ? new Date(o.paidAt).getTime() : null;
  const refundUntil = refundable?.d.refund && paidAt ? paidAt + refundable.d.refund.days * 86_400_000 : null;
  const paid = o.status !== "awaiting" && o.status !== "expired";
  const first = items[0]?.d;
  return (
    <div className={s.receiptWrap}>
      <Receipt
        title={paid ? `Paid @${name}` : "Not paid"}
        when={when(o.paidAt ?? o.createdAt)}
        stamp="済"
        foot="Keep this to show what you bought and when. It holds no part of what was sealed to you."
        lines={[
          { term: "Order", value: <code className={s.mono}>{o.ref}</code> },
          { term: "Date", value: when(o.paidAt ?? o.createdAt) },
          { term: "Total", value: formatAmount(o.total, o.token) },
          ...(BigInt(o.dueLater) > 0n
            ? [
                { term: "Deposit", value: formatAmount(o.dueNow, o.token) },
                { term: "Rest", value: `${formatAmount(o.dueLater, o.token)}${o.balanceTx ? ", paid" : ", not paid yet"}` },
              ]
            : []),
          { term: "Status", value: statusWord(o.status) },
          { term: "Sealed to", value: <span className={s.mono}>{sealedTo}</span> },
          ...(o.request.gift ? [{ term: "Gift", value: "Yes, paid by you for someone else" }] : []),
        ]}
        hash={o.depositTx ?? undefined}
      />

      <div className={s.card}>
        <ul className={s.receiptItems}>
          {items.map(({ l, d }, i) => (
            <li key={i}>
              <Thumb def={d} size={64} />
              <span>
                <b>{d.title}</b>
                <small>
                  {[d.versions.find((v) => v.id === l.versionId)?.name, l.quantity > 1 ? `Quantity ${l.quantity}` : null, l.slot ? slotLabel(l.slot) : null]
                    .filter(Boolean)
                    .join(" · ") || `by @${d.name}`}
                </small>
                {d.content ? (
                  <small className={s.mono} title={d.content}>
                    Content fingerprint {fingerprint(d.content, 32)}
                  </small>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        {first?.receipt.message ? <RichText text={first.receipt.message} className={s.thanks} /> : null}
        {o.status === "delivered" || o.status === "refunded" ? (
          <ButtonLink variant="cord" size="lg" full href={`/library/${o.ref}`} icon="download">
            {first?.receipt.button ?? "View content"}
          </ButtonLink>
        ) : paid ? (
          <ButtonLink variant="line" full href={`/library/${o.ref}`}>
            See where it is
          </ButtonLink>
        ) : null}
      </div>

      <div className={[s.card, s.receiptMeta].join(" ")}>
        <h2 className={s.colTitle}>On QoreChain</h2>
        <dl className={s.sum}>
          {o.depositTx ? (
            <div>
              <dt>{BigInt(o.dueLater) > 0n ? "Deposit" : "Payment"}</dt>
              <dd>
                <a href={explorerTx(o.depositTx)} target="_blank" rel="noreferrer" className={s.txLink}>
                  <Icon name="link" size={13} /> {o.depositTx}
                </a>
              </dd>
            </div>
          ) : null}
          {o.balanceTx ? (
            <div>
              <dt>Rest</dt>
              <dd>
                <a href={explorerTx(o.balanceTx)} target="_blank" rel="noreferrer" className={s.txLink}>
                  <Icon name="link" size={13} /> {o.balanceTx}
                </a>
              </dd>
            </div>
          ) : null}
          {o.refundTx ? (
            <div>
              <dt>Refund</dt>
              <dd>
                <a href={explorerTx(o.refundTx)} target="_blank" rel="noreferrer" className={s.txLink}>
                  <Icon name="link" size={13} /> {o.refundTx}
                </a>
              </dd>
            </div>
          ) : null}
          <div>
            <dt>Paid from</dt>
            <dd className={s.mono}>{o.payer ?? "Not paid yet"}</dd>
          </div>
          <div>
            <dt>Paid to</dt>
            <dd className={s.mono}>{o.seller}</dd>
          </div>
          <div>
            <dt>Memo</dt>
            <dd className={s.mono}>mzk:ord:{o.ref}</dd>
          </div>
        </dl>
        <div className={s.rowWrap}>
          <Button
            variant="ghost"
            icon="copy"
            onClick={() => {
              const text = [
                "Mizuhiki purchase receipt",
                `Order: ${o.ref}`,
                `Seller: @${name} (${o.seller})`,
                ...items.map((x) => `Item: ${x.d.title}${x.l.quantity > 1 ? ` x${x.l.quantity}` : ""}`),
                `Total: ${formatAmount(o.total, o.token)}`,
                `Sealed to: ${sealedTo}`,
                ...(o.depositTx ? [`Transaction: ${o.depositTx}`, explorerTx(o.depositTx)] : []),
              ].join("\n");
              void navigator.clipboard.writeText(text).then(
                () => toast.show("Receipt copied"),
                () => toast.show("Copy is not allowed here", { tone: "error" }),
              );
            }}
          >
            Copy receipt
          </Button>
          <Button variant="ghost" icon="file" onClick={() => window.print()}>
            Print
          </Button>
        </div>
      </div>

      <div className={[s.card, s.contact].join(" ")}>
        <Avatar name={seller?.displayName ?? name} {...(seller?.avatar ? { src: mediaUrl(seller.avatar.hash) } : {})} size={52} />
        <span className={s.contactText}>
          <b>{seller?.displayName ?? `@${name}`}</b>
          <small>Questions about this order? Message the seller; it is sealed to them.</small>
        </span>
        <ButtonLink variant="line" icon="send" href={`/@${name}/message`}>
          Message @{name}
        </ButtonLink>
      </div>

      {refundable?.d.refund && paid && o.status !== "refunded" ? (
        <div className={[s.card, s.refundNote].join(" ")}>
          <p>
            <Icon name="undo" size={18} />
            <span>
              <b>
                {refundable.d.title}: refund within {refundable.d.refund.days} {refundable.d.refund.days === 1 ? "day" : "days"}
              </b>
              {refundUntil ? ` (until ${when(new Date(refundUntil).toISOString())})` : ""}. The seller sends refunds back from their own wallet.
            </span>
          </p>
          {refundUntil && Date.now() > refundUntil ? (
            <p className={s.fine}>The refund period for this order has ended. You can still message the seller.</p>
          ) : (
            <Button variant="line" icon="undo" onClick={onRefund}>
              Request a refund
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function statusWord(st: OrderView["status"]): string {
  return {
    awaiting: "Waiting for payment",
    in_progress: "Deposit paid",
    paid: "Paid, being prepared",
    delivered: "Delivered",
    refunded: "Refunded",
    expired: "Hold ended, nothing charged",
  }[st];
}

function RefundSheet({ open, onClose, o, name, seller }: { open: boolean; onClose: () => void; o: OrderView; name: string; seller: SellerPage | null }) {
  const acct = useAccount();
  const toast = useToast();
  const [why, setWhy] = useState("");
  const [step, setStep] = useState<{ s: SendStep; p: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const signer = acct.status === "unlocked" && acct.account && acct.account.owner.address === o.payer ? acct.account : undefined;
  return (
    <Sheet open={open} onClose={() => (step ? undefined : onClose())} title="Request a refund" dismissable={!step}>
      {sent ? (
        <div className={s.sheetBody}>
          <EmptyState title={`Request sent to @${name}`} face="happy" jp="できた！">
            It is sealed to them and names order {o.ref}. Refunds come back from their wallet to {o.payer ?? "the paying wallet"}, and this receipt shows it.
          </EmptyState>
          <Button variant="cord" full onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <form
          className={s.sheetBody}
          onSubmit={(e) => {
            e.preventDefault();
            setErr(null);
            setStep({ s: "keys", p: 0 });
            sendSealed({
              to: { address: o.seller, card: seller?.card ?? null },
              kind: "message",
              text: `Refund request for order ${o.ref}\nTotal paid: ${formatAmount(o.total, o.token)}\nPaid from: ${o.payer ?? "unknown"}\nTransaction: ${o.depositTx ?? "none"}\n\n${why.trim()}`,
              contact: o.payer ?? "",
              files: [],
              maxFileBytes: 0,
              signer,
              onStep: (st, p) => setStep({ s: st, p }),
            })
              .then(() => {
                setSent(true);
                toast.show("Refund request sent");
              })
              .catch((x: unknown) => setErr(x instanceof SendFailure ? x.message : "Not sent. Nothing left your device."))
              .finally(() => setStep(null));
          }}
        >
          <p className={s.fine}>
            This sends a sealed message to @{name} naming order <code className={s.mono}>{o.ref}</code>. Only they can read it.
          </p>
          <TextArea label="Why would you like a refund?" rows={4} maxLength={1000} counter value={why} onChange={(e) => setWhy(e.target.value)} />
          {step ? (
            <p className={s.waitLine} aria-live="polite">
              <span className={s.spin} aria-hidden="true" /> {SEND_STEP_LABEL[step.s]}…
            </p>
          ) : null}
          {err ? <Oops title="Not sent">{err}</Oops> : null}
          <Button type="submit" variant="cord" full icon="send" busy={!!step} disabled={!why.trim()}>
            Seal and send
          </Button>
        </form>
      )}
    </Sheet>
  );
}
