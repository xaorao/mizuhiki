"use client";
/**
 * Pay me (spec 5.5). PayPal.me's pay card (photo, name and @handle above the
 * amount; amount in the link wins), then our part: a sealed note, the honest
 * public line, three ways to pay (QoreX, the Mizuhiki wallet, manual), a review
 * with the full address and fee, staged sending, and a receipt.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Avatar,
  Button,
  ButtonLink,
  ChoiceCard,
  CopyValue,
  Icon,
  LockLine,
  Oops,
  Receipt,
  SealDone,
  SealFailed,
  SealMoment,
  Segmented,
  Sheet,
  TextArea,
  TextField,
  useToast,
  type SealStep,
} from "@mizuhiki/ui";
import { type Block, type RecipientCard } from "@mizuhiki/core";
import { explorerTx, fromBaseUnits } from "@mizuhiki/chain";
import { useAccount } from "@/account/AccountProvider";
import { mediaUrl } from "@/lib/api";
import {
  PayFailure,
  addTip,
  findPayment,
  payWithMizuhiki,
  payWithQorex,
  preparePayment,
  prepareInvoicePayment,
  qorex,
  deliverNote,
  reviewMizuhiki,
  startManual,
  type PaidResult,
  type PayMethod,
  type PayStage,
  type PayToken,
  type PreparedPayment,
} from "@/lib/pay";
import s from "./public.module.css";

type PayBlock = Extract<Block, { type: "pay" }>;
type Phase = "amount" | "method" | "review" | "sending" | "waiting" | "done" | "failed";

const TIPS = [0, 10, 15, 20] as const;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "back"] as const;
const AMOUNT_RE = /^\d{0,9}(\.\d{0,6})?$/;

export function PaySheet({
  open,
  onClose,
  block,
  owner,
  initialAmount,
  onMessage,
  invoice,
  onPaid,
}: {
  open: boolean;
  onClose: () => void;
  block: PayBlock;
  owner: {
    name: string;
    displayName: string;
    address: string;
    card: RecipientCard | null;
    avatar?: { hash: string; type: string } | undefined;
  };
  initialAmount?: string | undefined;
  onMessage?: (() => void) | undefined;
  /** Paying an invoice: amount, token and reference are fixed by the signed invoice; no note, no tip. */
  invoice?: { id: string; number: string; total: bigint; token: PayToken } | undefined;
  onPaid?: ((r: PaidResult) => void) | undefined;
}) {
  const acct = useAccount();
  const toast = useToast();
  const first = (owner.displayName || owner.name).split(" ")[0] ?? owner.name;
  const [phase, setPhase] = useState<Phase>(invoice ? "method" : "amount");
  const [amount, setAmount] = useState(initialAmount ?? "");
  const [token, setToken] = useState<PayToken>(block.tokens[0] ?? "fUSD");
  const [tip, setTip] = useState(0);
  const [note, setNote] = useState("");
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedPayment | null>(null);
  const [review, setReview] = useState<{ fee: bigint | null; problem: string | null } | null>(null);
  const [steps, setSteps] = useState<SealStep[]>([]);
  const [result, setResult] = useState<PaidResult | null>(null);
  const [failure, setFailure] = useState<PayFailure | null>(null);
  const [pass, setPass] = useState("");
  const [unlockErr, setUnlockErr] = useState<string | null>(null);
  const [resending, setResending] = useState(false);
  const [hasQorex, setHasQorex] = useState(false);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (initialAmount !== undefined) setAmount(initialAmount);
  }, [initialAmount]);
  // QoreX injects itself after load; look again when the sheet opens.
  useEffect(() => {
    if (!open) return;
    setHasQorex(!!qorex());
    const t = setTimeout(() => setHasQorex(!!qorex()), 600);
    return () => clearTimeout(t);
  }, [open]);
  useEffect(() => () => clearTimeout(waitTimer.current), []);

  const self = acct.account?.owner.address === owner.address;
  const mzkReady = acct.status === "unlocked" && !!acct.account && !self;
  const decimals = 6;
  const valid = /^\d+(\.\d{1,6})?$/.test(amount) && Number(amount) > 0;
  const totals = useMemo(() => (valid ? addTip(amount, tip, decimals) : null), [amount, tip, valid]);
  const noteReaders = mzkReady ? `Only ${first} and you can read this.` : `Only ${first} can read this.`;

  const reset = () => {
    clearTimeout(waitTimer.current);
    setPhase(invoice ? "method" : "amount");
    setNote("");
    setTip(0);
    setMethod(null);
    setPrepared(null);
    setReview(null);
    setResult(null);
    setFailure(null);
    setError(null);
    if (initialAmount === undefined) setAmount("");
  };

  const press = (k: (typeof KEYS)[number]) => {
    setError(null);
    if (k === "back") setAmount((a) => a.slice(0, -1));
    else
      setAmount((a) => {
        const next = a === "0" && k !== "." ? k : `${a}${k}`;
        return AMOUNT_RE.test(next) ? next : a;
      });
  };

  const toMethod = () => {
    if (!valid) {
      setError("Enter an amount above zero. Nothing was sent.");
      return;
    }
    if (!block.tokens.includes(token)) {
      setError("That token is not accepted here. Nothing was sent.");
      return;
    }
    setPhase("method");
  };

  const toReview = async (m: PayMethod) => {
    setMethod(m);
    setError(null);
    try {
      const p = invoice
        ? prepareInvoicePayment(invoice)
        : await preparePayment({
            owner: { address: owner.address, card: owner.card },
            token,
            amount,
            tipPercent: tip,
            note,
            payer: m === "mizuhiki" && mzkReady ? acct.account : undefined,
          });
      setPrepared(p);
      if (m === "mizuhiki" && acct.account) {
        setReview({ fee: null, problem: null });
        setPhase("review");
        try {
          setReview(await reviewMizuhiki(acct.account, owner.address, p));
        } catch (e) {
          setReview({ fee: null, problem: (e as Error).message });
        }
      } else {
        setReview({ fee: null, problem: null });
        setPhase("review");
      }
    } catch (e) {
      setError(`${(e as Error).message || "The note could not be sealed."} Nothing was sent.`);
      setPhase("method");
    }
  };

  const runPay = async () => {
    if (!prepared || !method) return;
    const order: { k: PayStage; label: string }[] = [
      { k: "signing", label: method === "qorex" ? "Waiting for you in QoreX" : "Signing with your post-quantum key" },
      { k: "submitted", label: "Submitted to QoreChain" },
      { k: "confirmed", label: "Confirmed on chain" },
      ...(prepared.note ? [{ k: "note" as const, label: "Delivering your sealed note" }] : []),
    ];
    const mark = (k: PayStage) => {
      const idx = order.findIndex((o) => o.k === k);
      setSteps(order.map((o, i) => ({ label: o.label, state: i < idx ? "done" : i === idx ? "running" : "waiting" })));
    };
    setSteps(order.map((o) => ({ label: o.label, state: "waiting" })));
    setPhase("sending");
    try {
      const common = { owner: owner.address, ownerName: owner.name, p: prepared, onStage: (st: PayStage) => mark(st) };
      const r =
        method === "qorex"
          ? await payWithQorex(common)
          : acct.account
            ? await payWithMizuhiki({ ...common, account: acct.account })
            : (() => {
                throw new PayFailure("Unlock your Mizuhiki wallet first. No money moved.", "no");
              })();
      setSteps(
        order.map((o) => ({ label: o.label, state: o.k === "note" && r.noteDelivered === false ? "failed" : "done" })),
      );
      setResult(r);
      onPaid?.(r);
      setPhase("done");
    } catch (e) {
      setFailure(
        e instanceof PayFailure ? e : new PayFailure("The payment could not be sent. No money moved.", "unknown"),
      );
      setPhase("failed");
    }
  };

  const startWaiting = async () => {
    if (!prepared) return;
    setPhase("waiting");
    await startManual({ owner: owner.address, ownerName: owner.name, p: prepared });
    const poll = async () => {
      const found = await findPayment(owner.address, prepared.ref).catch(() => null);
      if (found) {
        setResult({
          txHash: found.txHash,
          height: found.height,
          from: found.from,
          fee: null,
          noteDelivered: prepared.note ? true : null,
        });
        setPhase("done");
        return;
      }
      waitTimer.current = setTimeout(() => void poll(), 3000);
    };
    void poll();
  };

  const unlockHere = async () => {
    setUnlockErr(null);
    try {
      await acct.unlock(pass);
      setPass("");
    } catch (e) {
      setUnlockErr((e as Error).message || "That passphrase did not unlock this device.");
    }
  };

  const sending = phase === "sending";
  const total = totals?.total ?? "0";
  const title =
    invoice && (phase === "method" || phase === "sending")
      ? `Pay invoice #${invoice.number.padStart(4, "0")}`
      : phase === "done"
        ? `Paid ${first}`
        : phase === "review"
          ? "Review"
          : phase === "waiting"
            ? "Pay from any wallet"
            : `Pay ${first}`;

  return (
    <Sheet
      open={open}
      onClose={() => {
        if (sending) return;
        if (phase === "done" || phase === "failed") reset();
        onClose();
      }}
      title={title}
      dismissable={!sending}
    >
      {phase === "amount" ? (
        <form
          className={s.pay}
          onSubmit={(e) => {
            e.preventDefault();
            toMethod();
          }}
        >
          <div className={s.payWho}>
            <Avatar
              name={owner.displayName}
              {...(owner.avatar ? { src: mediaUrl(owner.avatar.hash) } : {})}
              size={56}
            />
            <div>
              <b>{owner.displayName}</b>
              <small>@{owner.name}</small>
            </div>
          </div>
          <label className={s.amountBox}>
            <span className="sr-only">Amount in {token}</span>
            <input
              value={amount}
              inputMode="decimal"
              placeholder="0"
              aria-label="Amount"
              onChange={(e) => {
                const v = e.target.value.replace(/,/g, ".");
                if (AMOUNT_RE.test(v)) setAmount(v);
                setError(null);
              }}
            />
            <span className={s.tokenTag}>{token}</span>
          </label>
          {block.presets.length ? (
            <div className={s.presets} role="group" aria-label="Preset amounts">
              {block.presets.map((p) => (
                <button key={p} type="button" aria-pressed={amount === p} onClick={() => setAmount(p)}>
                  {p}
                </button>
              ))}
            </div>
          ) : null}
          <div className={s.keypad} aria-hidden="true">
            {KEYS.map((k) => (
              <button key={k} type="button" tabIndex={-1} onClick={() => press(k)}>
                {k === "back" ? <Icon name="back" size={18} /> : k}
              </button>
            ))}
          </div>
          {block.tokens.length > 1 ? (
            <Segmented<PayToken>
              label="Token"
              value={token}
              onChange={setToken}
              options={block.tokens.map((t) => ({
                value: t,
                label: t === "fUSD" ? "fUSD (test dollars)" : "QOR (test)",
              }))}
            />
          ) : null}
          {block.tip ? (
            <div className={s.presets} role="group" aria-label="Tip">
              {TIPS.map((t) => (
                <button key={t} type="button" aria-pressed={tip === t} onClick={() => setTip(t)}>
                  {t === 0 ? "No tip" : `+${t}%`}
                </button>
              ))}
            </div>
          ) : null}
          <div className={s.noteBox}>
            <TextArea
              label={`Note to ${first} (optional)`}
              value={note}
              maxLength={1000}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What is it for?"
            />
            <LockLine>{noteReaders}</LockLine>
          </div>
          <p className={s.publicLine}>
            <Icon name="eye" size={14} /> The amount and addresses are public on chain.
          </p>
          {error ? <Oops title="Not yet">{error}</Oops> : null}
          <Button type="submit" variant="cord" size="lg" full iconRight="arrow" disabled={!valid}>
            {valid ? `Continue · ${total} ${token}` : "Enter an amount"}
          </Button>
        </form>
      ) : null}

      {phase === "method" ? (
        <div className={s.pay}>
          <p className={s.lead}>How do you want to pay?</p>
          <div role="radiogroup" aria-label="Pay with" className={s.stack}>
            <ChoiceCard
              selected={false}
              onSelect={() => hasQorex && void toReview("qorex")}
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
              selected={false}
              onSelect={() => mzkReady && void toReview("mizuhiki")}
              title="Pay with my Mizuhiki wallet"
              detail={
                self
                  ? "This is your own page."
                  : mzkReady
                    ? "Signed here with your keys. Your note can be read by you too."
                    : acct.status === "locked"
                      ? "Unlock Mizuhiki on this device first."
                      : "Needs a Mizuhiki account on this device."
              }
              icon={<Icon name="key" />}
              tone="sakura"
            />
            <ChoiceCard
              selected={false}
              onSelect={() => void toReview("manual")}
              title="Copy address and reference"
              detail="Pay from any QoreChain wallet. This page waits for the payment."
              icon={<Icon name="copy" />}
              tone="butter"
            />
          </div>
          {acct.status === "locked" && !self ? (
            <form
              className={s.unlock}
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
                error={unlockErr ?? undefined}
              />
              <Button type="submit" variant="line" icon="key" disabled={!pass}>
                Unlock my wallet
              </Button>
            </form>
          ) : null}
          {error ? <Oops title="Not yet">{error}</Oops> : null}
          {invoice ? null : (
            <Button variant="line" icon="back" onClick={() => setPhase("amount")}>
              Back
            </Button>
          )}
        </div>
      ) : null}

      {phase === "review" && prepared && method ? (
        <div className={s.pay}>
          <dl className={s.review}>
            <div>
              <dt>Amount</dt>
              <dd>
                {prepared.amount} {prepared.token}
              </dd>
            </div>
            {prepared.tip !== "0" ? (
              <div>
                <dt>Tip</dt>
                <dd>
                  {prepared.tip} {prepared.token}
                </dd>
              </div>
            ) : null}
            <div className={s.reviewTotal}>
              <dt>Total</dt>
              <dd>
                {prepared.total} {prepared.token}
              </dd>
            </div>
            <div>
              <dt>Network fee</dt>
              <dd>
                {method === "mizuhiki"
                  ? review?.fee !== null && review?.fee !== undefined
                    ? `${fromBaseUnits(review.fee, 6)} QOR`
                    : "Working it out…"
                  : method === "qorex"
                    ? "QoreX shows it before you approve"
                    : "Your wallet shows it"}
              </dd>
            </div>
            <div>
              <dt>To</dt>
              <dd>
                {owner.displayName} @{owner.name}
                <CopyValue value={owner.address} label="Recipient address" />
              </dd>
            </div>
            <div>
              <dt>{method === "manual" ? "Memo (paste exactly)" : "Reference"}</dt>
              <dd>
                <CopyValue
                  value={method === "manual" ? prepared.memo : prepared.ref}
                  label={method === "manual" ? "Memo" : "Reference"}
                />
              </dd>
            </div>
            <div>
              <dt>Note</dt>
              <dd>
                {prepared.note
                  ? `Sealed · ${prepared.note.readers > 1 ? `${first} and you` : `only ${first}`}`
                  : "None"}
              </dd>
            </div>
          </dl>
          {method === "manual" ? (
            <p className={s.manualHow}>
              Send exactly{" "}
              <b>
                {prepared.total} {prepared.token}
              </b>{" "}
              to the address above with the memo above. Without the memo the payment still arrives, but your note will
              not be linked to it.
            </p>
          ) : null}
          {review?.problem ? <Oops title="Can't pay this way">{review.problem}</Oops> : null}
          <div className={s.row}>
            <Button variant="line" icon="back" onClick={() => setPhase("method")}>
              Back
            </Button>
            {method === "manual" ? (
              <Button variant="cord" size="lg" className={s.grow} icon="check" onClick={() => void startWaiting()}>
                I&apos;ve sent it
              </Button>
            ) : (
              <Button
                variant="cord"
                size="lg"
                className={s.grow}
                icon="coin"
                disabled={
                  !!review?.problem || (method === "mizuhiki" && (review?.fee === null || review?.fee === undefined))
                }
                onClick={() => void runPay()}
              >
                Pay {prepared.total} {prepared.token}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      {phase === "sending" ? (
        <SealMoment
          steps={steps}
          progress={steps.filter((x) => x.state === "done").length / Math.max(1, steps.length)}
        />
      ) : null}

      {phase === "waiting" && prepared ? (
        <div className={s.pay} aria-live="polite">
          <div className={s.waitBox}>
            <span className={s.spin} />
            <div>
              <b>
                Waiting for {prepared.total} {prepared.token} with reference {prepared.ref}
              </b>
              <span>
                This page checks QoreChain every few seconds. You can close it; {first} still gets the payment
                {prepared.note ? " and your sealed note" : ""}.
              </span>
            </div>
          </div>
          <CopyValue value={owner.address} label="Recipient address" />
          <CopyValue value={prepared.memo} label="Memo" />
          <Button variant="ghost" onClick={() => setPhase("review")}>
            Back
          </Button>
        </div>
      ) : null}

      {phase === "done" && result && prepared ? (
        <SealDone
          headline={`Paid ${first} ${prepared.total} ${prepared.token}.`}
          onDone={() => {
            reset();
            onClose();
          }}
          onCopy={() => {
            const t = `Mizuhiki payment receipt\nTo: @${owner.name} (${owner.address})\nAmount: ${prepared.total} ${prepared.token}\nReference: ${prepared.ref}\nTransaction: ${result.txHash}\n${explorerTx(result.txHash)}`;
            void navigator.clipboard.writeText(t).then(
              () => toast.show("Receipt copied"),
              () => toast.show("Copy is not allowed here", { tone: "error" }),
            );
          }}
          receipt={
            <Receipt
              title={`Paid ${first}`}
              when={new Date().toLocaleString("en-GB", {
                day: "numeric",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              lines={[
                { term: "Amount", value: `${prepared.total} ${prepared.token}` },
                { term: "To", value: `@${owner.name}` },
                { term: "Reference", value: prepared.ref },
                {
                  term: "Note",
                  value: prepared.note
                    ? result.noteDelivered === false
                      ? "Sealed, not delivered yet"
                      : "Sealed and delivered"
                    : "None",
                },
                { term: "On chain", value: `Block ${result.height}` },
              ]}
              hash={result.txHash}
            />
          }
          extra={
            <div className={s.doneExtra}>
              {block.thanks ? (
                <p className={s.thanks}>
                  “{block.thanks}” · {first}
                </p>
              ) : null}
              {result.noteDelivered === false ? (
                <Oops
                  title="Your payment arrived; the note did not"
                  action={
                    <Button
                      size="sm"
                      variant="line"
                      busy={resending}
                      onClick={() => {
                        const n = prepared.note;
                        if (!n) return;
                        setResending(true);
                        void deliverNote(owner.address, prepared.ref, n.envelope, n.hash)
                          .then(() => {
                            setResult({ ...result, noteDelivered: true });
                            toast.show("Note delivered");
                          })
                          .catch(() => toast.show("Still not delivered. It is kept on this device.", { tone: "error" }))
                          .finally(() => setResending(false));
                      }}
                    >
                      Send the note again
                    </Button>
                  }
                >
                  It is kept on this device. Its fingerprint is in the payment, so {first} will see it once it arrives.
                </Oops>
              ) : null}
              <div className={s.row}>
                <ButtonLink
                  variant="ghost"
                  icon="link"
                  href={explorerTx(result.txHash)}
                  target="_blank"
                  rel="noreferrer"
                >
                  Transaction
                </ButtonLink>
                <Button
                  variant="ghost"
                  icon="share"
                  onClick={() => {
                    const text = `I paid @${owner.name} ${prepared.total} ${prepared.token} on QoreChain (reference ${prepared.ref}).`;
                    const url = explorerTx(result.txHash);
                    // Web Share where the device has it; otherwise copy the same text and link.
                    if (typeof navigator.share === "function")
                      void navigator.share({ title: "Mizuhiki payment", text, url }).catch(() => undefined);
                    else
                      void navigator.clipboard.writeText(`${text}\n${url}`).then(
                        () => toast.show("Payment link copied"),
                        () => toast.show("Copy is not allowed here", { tone: "error" }),
                      );
                  }}
                >
                  Share
                </Button>
                {onMessage ? (
                  <Button
                    variant="ghost"
                    icon="send"
                    onClick={() => {
                      reset();
                      onMessage();
                    }}
                  >
                    Send a message too
                  </Button>
                ) : null}
              </div>
              {block.redirect ? (
                <ButtonLink variant="line" iconRight="arrow" href={block.redirect} rel="noreferrer">
                  Continue to {new URL(block.redirect).host}
                </ButtonLink>
              ) : null}
            </div>
          }
        />
      ) : null}

      {phase === "failed" && failure ? (
        <SealFailed
          title={
            failure.moved === "no"
              ? "Not paid. No money moved."
              : failure.moved === "yes"
                ? "Not paid. Only the network fee was spent."
                : "Not confirmed yet."
          }
          detail={failure.message}
          txHash={failure.txHash}
          onClose={() => {
            reset();
            onClose();
          }}
          onRetry={() => setPhase("review")}
          retryLabel="Back to review"
        />
      ) : null}
    </Sheet>
  );
}
