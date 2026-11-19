"use client";
/**
 * Sales: every order with its buyer, lines, total, status and transactions.
 * Opening this tab seals paid orders to their buyers from this device (the
 * dashboard does the same in the background). Row actions: deliver now, ask
 * for the rest of a commission, refund (the seller's own transfer back).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  EmptyState,
  Icon,
  LockLine,
  Oops,
  Sheet,
  Skeleton,
  StatusChip,
  Stepper,
  TextField,
  useToast,
  type StepItem,
} from "@mizuhiki/ui";
import { formatAmount, parseAmount } from "@mizuhiki/core";
import { explorerAddress, explorerTx } from "@mizuhiki/chain";
import { useOwner } from "@/owner/OwnerProvider";
import { ApiFailure } from "@/lib/api";
import { useDebounced, useRoomEvents } from "@/rooms/useRoom";
import { listSales, refund, requestBalance, withToken, type OrderView } from "../engine";
import { deliverNow, useDelivering, useOutcomes } from "./delivery";
import {
  amountInput,
  buyerLabel,
  canAskRest,
  canDeliver,
  canRefund,
  orderLines,
  orderStatus,
  paidSoFar,
} from "./model";
import { when } from "./bits";
import s from "./seller.module.css";

type Filter = "all" | "waiting" | "delivered" | "awaiting" | "refunded";

export function SalesTab({ onWaiting }: { onWaiting?: (n: number) => void }) {
  const owner = useOwner();
  const toast = useToast();
  const outcomes = useOutcomes();
  const delivering = useDelivering();
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [refunding, setRefunding] = useState<OrderView | null>(null);

  const tokened = useCallback(async () => withToken(owner.account, await owner.token()), [owner]);

  const load = useCallback(async () => {
    try {
      const os = await listSales(await tokened());
      setOrders(os);
      setError(null);
      return os;
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Your sales could not be loaded. Nothing changed.");
      return null;
    }
  }, [tokened]);

  // Open: load, then seal what is paid, then show the result.
  useEffect(() => {
    void (async () => {
      const os = await load();
      if (os?.some(canDeliver)) {
        await deliverNow(await tokened(), { orders: os }).catch(() => undefined);
        await load();
      }
    })();
  }, [load, tokened]);

  // Live: a new order or payment arrives over the owner events socket.
  const soon = useDebounced(() => void load(), 400);
  useRoomEvents((kind) => {
    if (kind === "order") soon();
  });
  // Reload after any delivery pass (the background one included).
  useEffect(() => {
    if (outcomes.size) void load();
  }, [outcomes, load]);

  useEffect(() => {
    onWaiting?.(orders?.filter(canDeliver).length ?? 0);
  }, [orders, onWaiting]);

  const deliverOne = async (o: OrderView) => {
    setBusy(o.ref);
    try {
      const done = await deliverNow(await tokened(), { only: o.ref });
      if (!done.some((d) => d.ref === o.ref))
        toast.show("This order is not waiting to be sealed any more.", { tone: "info" });
      await load();
    } finally {
      setBusy(null);
    }
  };

  const askRest = async (o: OrderView) => {
    setBusy(o.ref);
    try {
      await requestBalance(await tokened(), o.ref);
      toast.show("Asked for the rest. The buyer sees a Pay the rest button on their purchase.");
      await load();
    } catch (e) {
      toast.show(e instanceof ApiFailure ? e.message : "That did not work. Nothing changed.", { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const shown = useMemo(
    () =>
      (orders ?? []).filter((o) =>
        filter === "all"
          ? true
          : filter === "waiting"
            ? canDeliver(o) || o.status === "in_progress"
            : filter === "delivered"
              ? o.status === "delivered"
              : filter === "awaiting"
                ? o.status === "awaiting" || o.status === "expired"
                : o.status === "refunded",
      ),
    [orders, filter],
  );

  if (error && !orders)
    return (
      <Oops
        title="Not loaded"
        action={
          <Button variant="line" icon="undo" onClick={() => void load()}>
            Try again
          </Button>
        }
      >
        {error}
      </Oops>
    );
  if (!orders)
    return (
      <div className={s.cards} aria-busy="true">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} lines={3} />
        ))}
      </div>
    );
  if (orders.length === 0)
    return (
      <div className={s.emptyWrap}>
        <EmptyState title="No sales yet" face="sleepy" jp="まだ">
          When someone orders, it shows up here at once. Paid orders are sealed to the buyer from this device while your
          dashboard is open.
        </EmptyState>
      </div>
    );

  const waiting = orders.filter(canDeliver).length;
  return (
    <div className={s.stack}>
      <div className={s.salesBar}>
        <div className={s.filters} role="group" aria-label="Show">
          {(
            [
              ["all", "All"],
              ["waiting", "To do"],
              ["delivered", "Delivered"],
              ["awaiting", "Unpaid"],
              ["refunded", "Refunded"],
            ] as [Filter, string][]
          ).map(([f, label]) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
        <span className={s.deliverState} aria-live="polite">
          {delivering ? (
            <>
              <span className={s.dot} aria-hidden="true" /> Sealing paid orders to their buyers…
            </>
          ) : waiting ? (
            `${waiting} paid ${waiting === 1 ? "order is" : "orders are"} waiting to be sealed`
          ) : (
            <>
              <Icon name="check" size={15} /> Every paid order is sealed
            </>
          )}
        </span>
      </div>
      {error ? <Oops title="Not refreshed">{error}</Oops> : null}
      {shown.length === 0 ? (
        <p className={s.muted}>Nothing here with this filter.</p>
      ) : (
        <ul className={[s.cards, s.stagger].join(" ")}>
          {shown.map((o) => {
            const st = orderStatus(o);
            const out = outcomes.get(o.ref);
            const lines = orderLines(o);
            const commission = BigInt(o.dueLater) > 0n;
            return (
              <li key={o.ref} className={s.order}>
                <div className={s.orderHead}>
                  <div className={s.orderWho}>
                    <b>{buyerLabel(o)}</b>
                    <small>
                      {when(o.createdAt)} · Order <code className={s.mono}>{o.ref.slice(0, 10)}</code>
                    </small>
                  </div>
                  <StatusChip status={st.chip}>{st.label}</StatusChip>
                  <b className={s.orderTotal}>{formatAmount(o.total, o.token)}</b>
                </div>
                <ul className={s.lines}>
                  {lines.map((l, i) => (
                    <li key={i}>
                      <span>
                        {l.title}
                        {l.option ? <small> · {l.option}</small> : null}
                        {l.quantity > 1 ? <small> × {l.quantity}</small> : null}
                      </span>
                      {l.slot ? (
                        <small className={s.slot}>
                          <Icon name="calendar" size={14} />{" "}
                          {new Date(l.slot).toLocaleString("en-GB", {
                            weekday: "short",
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </small>
                      ) : null}
                      {l.chosen ? <small className={s.slot}>They chose {l.chosen}</small> : null}
                    </li>
                  ))}
                </ul>
                {commission ? (
                  <p className={s.orderNote}>
                    Deposit {formatAmount(o.dueNow, o.token)} {o.depositTx ? "paid" : "due"} · the rest{" "}
                    {formatAmount(o.dueLater, o.token)}{" "}
                    {o.balanceTx ? "paid" : o.balanceRequested ? "asked for" : "when the work is done"}
                  </p>
                ) : null}
                {BigInt(o.request.tip) > 0n ? (
                  <p className={s.orderNote}>Includes a tip of {formatAmount(o.request.tip, o.token)}</p>
                ) : null}
                {o.request.discountCode ? <p className={s.orderNote}>Code {o.request.discountCode}</p> : null}
                <div className={s.txs}>
                  {o.depositTx ? <TxLink hash={o.depositTx} label={commission ? "Deposit" : "Payment"} /> : null}
                  {o.balanceTx ? <TxLink hash={o.balanceTx} label="The rest" /> : null}
                  {o.refundTx ? <TxLink hash={o.refundTx} label="Refund" /> : null}
                  {o.payer ? (
                    <a href={explorerAddress(o.payer)} target="_blank" rel="noreferrer" className={s.txLink}>
                      <Icon name="wallet" size={14} /> Buyer wallet
                    </a>
                  ) : null}
                  {o.status === "awaiting" ? <small className={s.muted}>Held until {when(o.expiresAt)}</small> : null}
                  {o.deliveredAt ? (
                    <small className={s.muted}>
                      <Icon name="lock" size={13} /> Sealed {when(o.deliveredAt)}
                      {o.deliveredBy && o.deliveredBy !== o.seller ? " by your delivery helper" : " from your device"}
                    </small>
                  ) : null}
                </div>
                {out && canDeliver(o) && !out.ok ? (
                  <p className={s.outBad} role="status">
                    <Icon name="alert" size={15} /> Not sealed yet: {out.why}
                  </p>
                ) : out?.ok && o.status === "delivered" && Date.now() - out.at < 120_000 ? (
                  <p className={s.outOk} role="status">
                    <Icon name="check" size={15} /> Sealed to the buyer. できた！
                  </p>
                ) : null}
                {canDeliver(o) || canAskRest(o) || canRefund(o) ? (
                  <div className={s.rowActions}>
                    {canDeliver(o) ? (
                      <Button
                        size="sm"
                        variant="cord"
                        icon="lock"
                        busy={busy === o.ref || delivering}
                        onClick={() => void deliverOne(o)}
                      >
                        Deliver now
                      </Button>
                    ) : null}
                    {canAskRest(o) ? (
                      <Button
                        size="sm"
                        variant={o.balanceRequested ? "line" : "cord"}
                        icon="bell"
                        busy={busy === o.ref}
                        onClick={() => void askRest(o)}
                      >
                        {o.balanceRequested ? "Ask again" : "Ask for the rest"}
                      </Button>
                    ) : null}
                    {canRefund(o) ? (
                      <Button size="sm" variant="ghost" icon="undo" onClick={() => setRefunding(o)}>
                        Refund
                      </Button>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <LockLine>
        Mizuhiki never holds the product key for an order. Your device checks each payment on QoreChain and seals the
        key to the buyer; we only see that it happened.
      </LockLine>
      {refunding ? (
        <RefundSheet
          order={refunding}
          onClose={() => setRefunding(null)}
          onDone={() => void load()}
          tokened={tokened}
        />
      ) : null}
    </div>
  );
}

function TxLink({ hash, label }: { hash: string; label: string }) {
  return (
    <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className={s.txLink}>
      <Icon name="coin" size={14} /> {label} <code className={s.mono}>{hash.slice(0, 8)}…</code>
    </a>
  );
}

type Stage = "idle" | "signing" | "submitted" | "confirmed" | "recorded" | "failed";

function RefundSheet({
  order,
  onClose,
  onDone,
  tokened,
}: {
  order: OrderView;
  onClose: () => void;
  onDone: () => void;
  tokened: () => Promise<ReturnType<typeof withToken>>;
}) {
  const toast = useToast();
  const paid = paidSoFar(order);
  const [text, setText] = useState(amountInput(paid, order.token));
  const [stage, setStage] = useState<Stage>("idle");
  const [tx, setTx] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sure, setSure] = useState(false);
  const amount = parseAmount(text, order.token);
  const amountErr =
    amount === null
      ? "Use a number, like 12.50."
      : amount <= 0n
        ? "Refund more than zero."
        : amount > paid
          ? `They paid ${formatAmount(paid, order.token)}. Refund up to that.`
          : null;
  const running = stage === "signing" || stage === "submitted" || stage === "confirmed";

  const go = async () => {
    if (amount === null || amountErr) return;
    setErr(null);
    setStage("signing");
    const reached: { at: Stage } = { at: "signing" };
    try {
      const h = await refund(await tokened(), order, amount, (st) => {
        reached.at = st;
        setStage(st);
      });
      setTx(h);
      setStage("recorded");
      toast.show("Refunded. The order now says so.");
      onDone();
    } catch (e) {
      setStage("failed");
      const why = e instanceof Error && e.message ? e.message : "The refund did not go through.";
      setErr(
        reached.at === "confirmed"
          ? `The money was sent back on QoreChain, but the order was not marked refunded: ${why} Do not send it again; reload Sales in a minute.`
          : reached.at === "submitted"
            ? `The transfer was sent but not confirmed yet: ${why} Check your wallet before trying again.`
            : `${why} No money moved.`,
      );
    }
  };

  const steps: StepItem[] = [
    {
      title: "Sign with your keys",
      state:
        stage === "signing" ? "running" : stage === "idle" ? "waiting" : stage === "failed" && !tx ? "failed" : "done",
    },
    {
      title: "Sent to QoreChain",
      state: stage === "submitted" ? "running" : ["confirmed", "recorded"].includes(stage) ? "done" : "waiting",
    },
    {
      title: "Confirmed and recorded on the order",
      state: stage === "confirmed" ? "running" : stage === "recorded" ? "done" : "waiting",
    },
  ];

  return (
    <Sheet open onClose={onClose} title="Refund this order" dismissable={!running}>
      <div className={s.stack}>
        <p className={s.help}>
          On-chain payments cannot be charged back, so a refund is your own transfer back to the buyer&rsquo;s wallet (
          {order.payer ? `${order.payer.slice(0, 12)}…` : "unknown"}), sent from your wallet with this order&rsquo;s
          refund note. The amount and both addresses are public on QoreChain.
        </p>
        {stage === "idle" || stage === "failed" ? (
          <>
            <TextField
              label={`Amount in ${order.token}`}
              inputMode="decimal"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setSure(false);
              }}
              error={amountErr ?? undefined}
              hint={`They paid ${formatAmount(paid, order.token)}. The network fee is paid by you.`}
            />
            <label className={s.check}>
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
              <span>
                Send {amount !== null && !amountErr ? formatAmount(amount, order.token) : "this amount"} back now. Their
                copy stays theirs; a refund cannot unseal it.
              </span>
            </label>
          </>
        ) : null}
        {stage !== "idle" ? <Stepper steps={steps} /> : null}
        {err ? <Oops title="Not refunded">{err}</Oops> : null}
        {tx ? (
          <a href={explorerTx(tx)} target="_blank" rel="noreferrer" className={s.txLink}>
            <Icon name="coin" size={14} /> Refund transaction <code className={s.mono}>{tx.slice(0, 12)}…</code>
          </a>
        ) : null}
        <div className={s.actionsEnd}>
          {stage === "recorded" ? (
            <Button variant="cord" icon="check" onClick={onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={onClose} disabled={running}>
                Cancel
              </Button>
              <Button
                variant="danger"
                icon="undo"
                busy={running}
                disabled={!sure || amountErr !== null}
                onClick={() => void go()}
              >
                {stage === "failed" ? "Try again" : "Send refund"}
              </Button>
            </>
          )}
        </div>
      </div>
    </Sheet>
  );
}
