"use client";
import Link from "next/link";
/**
 * Paying for an order (spec 5.11 checkout, right column), the same three ways
 * and the same staged sending as Pay me (PaySheet): QoreX, the Mizuhiki wallet
 * (balance and network fee checked first), or sending it by hand from any
 * wallet with the order's memo. The order is placed (and held) only when the
 * buyer presses Pay, then the transaction is reported so the server reads it
 * from QoreChain at once.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  ButtonLink,
  ChoiceCard,
  Icon,
  SealFailed,
  SealMoment,
  Sheet,
  TextField,
  type SealStep,
} from "@mizuhiki/ui";
import { formatAmount, type ShopToken } from "@mizuhiki/core";
import { denomBySymbol, explorerTx, fromBaseUnits } from "@mizuhiki/chain";
import { useAccount } from "@/account/AccountProvider";
import { ApiFailure } from "@/lib/api";
import {
  PayFailure,
  payWithMizuhiki,
  payWithQorex,
  qorex,
  reviewMizuhiki,
  type PayStage,
  type PreparedPayment,
} from "@/lib/pay";
import { orderPayment, reportTx, type OrderView } from "../engine";
import { rememberOrder, rememberTx } from "./store";
import s from "./buyer.module.css";

export type BuyMethod = "qorex" | "mizuhiki" | "manual";

/** A stand-in payment with the real amount and a memo of the real length, for the fee estimate before the order exists. */
function estimateFor(token: ShopToken, units: bigint, part: "now" | "rest"): PreparedPayment | null {
  const denom = denomBySymbol(token);
  if (!denom) return null;
  const ref = `${"A".repeat(22)}${part === "rest" ? "-2" : ""}`;
  const shown = fromBaseUnits(units, denom.decimals);
  return { ref, memo: `mzk:ord:${ref}`, denom, units, amount: shown, tip: "0", total: shown, token, note: null };
}

export function PayPanel({
  token,
  units,
  seller,
  sellerName,
  part = "now",
  obtain,
  blocked,
  onPaid,
  onManual,
  compact = false,
  allowManual = true,
}: {
  token: ShopToken;
  /** What is due now, base units (shown before the order exists). */
  units: bigint;
  seller: string;
  sellerName: string;
  part?: "now" | "rest";
  /** Places the order (checkout) or returns the existing one (order page). */
  obtain: () => Promise<OrderView>;
  /** Why paying is not possible yet, in plain words; null when ready. */
  blocked: string | null;
  onPaid: (o: OrderView, txHash: string | null) => void;
  /** Manual paying: the order page shows the address, memo and amount and waits. */
  onManual: (o: OrderView) => void;
  compact?: boolean;
  /** The order page shows the address and memo itself, so it leaves this choice out. */
  allowManual?: boolean;
}) {
  const acct = useAccount();
  const [hasQorex, setHasQorex] = useState(false);
  const myAddr = acct.account?.owner.address ?? "";
  const self = myAddr === seller;
  const mzkReady = acct.status === "unlocked" && !!acct.account && !self;
  const [method, setMethod] = useState<BuyMethod | null>(null);
  const [fee, setFee] = useState<{ fee: bigint | null; problem: string | null } | "checking" | null>(null);
  const [phase, setPhase] = useState<"idle" | "sending" | "failed">("idle");
  const [steps, setSteps] = useState<SealStep[]>([]);
  const [failure, setFailure] = useState<{
    title: string;
    detail: string;
    tx?: string | undefined;
    ref?: string | undefined;
  } | null>(null);
  const [pass, setPass] = useState("");
  const [unlockErr, setUnlockErr] = useState<string | undefined>();
  const [unlocking, setUnlocking] = useState(false);
  const free = units === 0n;
  const alive = useRef(true);
  useEffect(() => {
    // Strict mode mounts twice: mark alive on every mount, not only the first.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // QoreX injects itself after load; look twice.
  useEffect(() => {
    setHasQorex(!!qorex());
    const t = setTimeout(() => setHasQorex(!!qorex()), 700);
    return () => clearTimeout(t);
  }, []);
  // A sensible default: the wallet that is ready here.
  useEffect(() => {
    if (method) return;
    if (mzkReady) setMethod("mizuhiki");
    else if (hasQorex) setMethod("qorex");
  }, [method, mzkReady, hasQorex]);

  // The Mizuhiki wallet: balance and the simulated fee, before anything is placed.
  const estimate = useMemo(() => estimateFor(token, units, part), [token, units, part]);
  useEffect(() => {
    if (method !== "mizuhiki" || !mzkReady || !acct.account || !estimate || free) {
      setFee(null);
      return;
    }
    const life = { alive: true };
    setFee("checking");
    reviewMizuhiki(acct.account, seller, estimate).then(
      (r) => life.alive && setFee(r),
      (e: unknown) =>
        life.alive &&
        setFee({ fee: null, problem: (e as Error).message || "The network fee could not be worked out." }),
    );
    return () => {
      life.alive = false;
    };
  }, [method, mzkReady, acct.account, estimate, seller, free]);

  const total = formatAmount(units, token);
  const ready =
    !blocked &&
    (free ||
      (method === "qorex" && hasQorex) ||
      method === "manual" ||
      (method === "mizuhiki" && mzkReady && fee !== "checking" && fee !== null && !fee.problem));

  const pay = async () => {
    if (!ready) return;
    const order: { k: "order" | PayStage; label: string }[] = [
      { k: "order", label: part === "rest" ? "Getting the order" : "Holding your order for an hour" },
      ...(free || method === "manual"
        ? []
        : [
            {
              k: "signing" as const,
              label: method === "qorex" ? "Waiting for you in QoreX" : "Signing with your post-quantum key",
            },
            { k: "submitted" as const, label: "Submitted to QoreChain" },
            { k: "confirmed" as const, label: "Confirmed on QoreChain" },
          ]),
    ];
    const mark = (k: "order" | PayStage) => {
      const i = order.findIndex((o) => o.k === k);
      if (i < 0) return;
      setSteps(order.map((o, j) => ({ label: o.label, state: j < i ? "done" : j === i ? "running" : "waiting" })));
    };
    setFailure(null);
    setPhase("sending");
    mark("order");
    let placed: OrderView;
    try {
      placed = await obtain();
      rememberOrder(placed.ref, sellerName);
    } catch (e) {
      setFailure({
        title: "Not paid. Nothing was charged.",
        detail: e instanceof ApiFailure || e instanceof Error ? e.message : "The order could not be placed.",
      });
      setPhase("failed");
      return;
    }
    if (free || method === "manual") {
      onManual(placed);
      return;
    }
    let p: PreparedPayment;
    try {
      p = orderPayment(placed, part);
    } catch (e) {
      setFailure({ title: "Not paid. No money moved.", detail: (e as Error).message, ref: placed.ref });
      setPhase("failed");
      return;
    }
    let sentHash: string | undefined;
    try {
      const common = {
        owner: placed.payTo,
        ownerName: sellerName,
        p,
        onStage: (st: PayStage, h?: string) => {
          if (h && !sentHash) {
            sentHash = h;
            rememberTx(placed.ref, sellerName, h);
          }
          mark(st);
        },
      };
      let r;
      if (method === "qorex") r = await payWithQorex(common);
      else {
        if (!acct.account) throw new PayFailure("Unlock your Mizuhiki wallet first. No money moved.", "no");
        const check = await reviewMizuhiki(acct.account, placed.payTo, p);
        if (check.problem) throw new PayFailure(check.problem, "no");
        r = await payWithMizuhiki({ ...common, account: acct.account });
      }
      rememberTx(placed.ref, sellerName, r.txHash);
      setSteps(order.map((o) => ({ label: o.label, state: "done" })));
      await reportTx(placed.ref, r.txHash).catch(() => undefined);
      if (alive.current) onPaid(placed, r.txHash);
    } catch (e) {
      const f =
        e instanceof PayFailure
          ? e
          : new PayFailure("The payment could not be sent. No money moved.", "unknown", sentHash);
      setFailure({
        title:
          f.moved === "no"
            ? "Not paid. No money moved."
            : f.moved === "yes"
              ? "Not paid. Only the network fee was spent."
              : "Not confirmed yet.",
        detail:
          f.moved === "unknown"
            ? `${f.message} Your order is held for an hour; its page keeps checking QoreChain.`
            : `${f.message} Your order is held for an hour, so you can try again.`,
        tx: f.txHash ?? sentHash,
        ref: placed.ref,
      });
      setPhase("failed");
    }
  };

  const unlockHere = async () => {
    setUnlockErr(undefined);
    setUnlocking(true);
    try {
      await acct.unlock(pass);
      setPass("");
      setMethod("mizuhiki");
    } catch (e) {
      setUnlockErr((e as Error).message || "That passphrase did not unlock this device.");
    } finally {
      setUnlocking(false);
    }
  };

  return (
    <div className={[s.payPanel, compact ? s.payCompact : ""].join(" ")}>
      {free ? null : (
        <div role="radiogroup" aria-label="Pay with" className={s.stack}>
          <ChoiceCard
            selected={method === "qorex"}
            onSelect={() => hasQorex && setMethod("qorex")}
            title="Pay with QoreX"
            detail={
              hasQorex
                ? "QoreX shows the payment and signs it with your post-quantum key."
                : "Install the QoreX extension, or open this page in the QoreX app's browser."
            }
            icon={<Icon name="wallet" />}
            tone="sora"
          />
          <ChoiceCard
            selected={method === "mizuhiki"}
            onSelect={() => setMethod("mizuhiki")}
            title="Pay with my Mizuhiki wallet"
            detail={
              self
                ? "This is your own shop."
                : mzkReady
                  ? `Signed here with your keys, from ${myAddr.slice(0, 10)}…${myAddr.slice(-6)}.`
                  : acct.status === "locked"
                    ? "Unlock Mizuhiki on this device first."
                    : "Needs a Mizuhiki account on this device."
            }
            icon={<Icon name="key" />}
            tone="sakura"
          />
          {allowManual ? (
            <ChoiceCard
              selected={method === "manual"}
              onSelect={() => setMethod("manual")}
              title="Send it myself"
              detail="Pay from any QoreChain wallet with the order's memo. The next page shows the address and waits for it."
              icon={<Icon name="copy" />}
              tone="butter"
            />
          ) : null}
        </div>
      )}

      {method === "mizuhiki" && acct.status === "locked" && !self ? (
        <form
          className={s.unlockRow}
          onSubmit={(e) => {
            e.preventDefault();
            void unlockHere();
          }}
        >
          <TextField
            label="Device passphrase"
            type="password"
            autoComplete="current-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            error={unlockErr}
          />
          <Button type="submit" variant="line" icon="key" busy={unlocking} disabled={!pass}>
            Unlock
          </Button>
        </form>
      ) : null}
      {method === "mizuhiki" && acct.status === "none" ? (
        <p className={s.fine}>
          No Mizuhiki account on this device. Pay with QoreX or send it yourself, or{" "}
          <Link
            href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/" : window.location.pathname)}`}
          >
            log in
          </Link>
          .
        </p>
      ) : null}

      <dl className={s.sum}>
        <div>
          <dt>Token</dt>
          <dd>{token === "fUSD" ? "fUSD (test dollars)" : "QOR (test)"} on QoreChain testnet</dd>
        </div>
        {free ? null : (
          <div>
            <dt>Network fee</dt>
            <dd>
              {method === "mizuhiki"
                ? fee === "checking"
                  ? "Working it out…"
                  : fee && fee.fee !== null
                    ? `About ${fromBaseUnits(fee.fee, 6)} QOR, paid by you`
                    : "Shown once your wallet is unlocked"
                : method === "qorex"
                  ? "QoreX shows it before you approve"
                  : method === "manual"
                    ? "Your wallet shows it"
                    : "Pick how to pay"}
            </dd>
          </div>
        )}
        <div className={s.sumTotal}>
          <dt>{part === "rest" ? "Rest to pay" : "Total"}</dt>
          <dd>{free ? "Free" : total}</dd>
        </div>
      </dl>

      {method === "mizuhiki" && fee && fee !== "checking" && fee.problem ? (
        <p className={s.problem}>{fee.problem}</p>
      ) : null}
      {blocked ? (
        <p className={s.blocked}>
          <Icon name="info" size={16} />
          {blocked}
        </p>
      ) : null}

      <Button
        variant="cord"
        size="xl"
        full
        icon={free ? "download" : "coin"}
        disabled={!ready}
        onClick={() => void pay()}
      >
        {free ? "Get it" : method === "manual" ? `Continue to pay ${total}` : `Pay ${total}`}
      </Button>

      <Sheet
        open={phase !== "idle"}
        onClose={() => phase === "failed" && setPhase("idle")}
        title={phase === "failed" ? "Payment" : "Paying"}
        dismissable={phase !== "sending"}
      >
        {phase === "sending" ? (
          <SealMoment
            steps={steps}
            progress={steps.filter((x) => x.state === "done").length / Math.max(1, steps.length)}
            note={<>Keep this page open. Nothing is charged until you approve it.</>}
          />
        ) : null}
        {phase === "failed" && failure ? (
          <>
            <SealFailed
              title={failure.title}
              detail={failure.detail}
              txHash={failure.tx}
              onClose={() => setPhase("idle")}
              onRetry={() => setPhase("idle")}
              retryLabel="Back"
            />
            <div className={s.failLinks}>
              {failure.tx ? (
                <ButtonLink variant="ghost" icon="link" href={explorerTx(failure.tx)} target="_blank" rel="noreferrer">
                  See the transaction
                </ButtonLink>
              ) : null}
              {failure.ref ? (
                <ButtonLink variant="ghost" iconRight="arrow" href={`/library/${failure.ref}`}>
                  Open the order
                </ButtonLink>
              ) : null}
            </div>
          </>
        ) : null}
      </Sheet>
    </div>
  );
}
