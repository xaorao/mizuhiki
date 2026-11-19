"use client";
/**
 * The seal moment and the receipt (spec 4.1), shared by every send. The
 * sequence follows the real work: the caller reports each step as it happens,
 * so its length is never a fake delay. Knot petals draw one after another, the
 * hub pops, Musubi covers its eyes while sealing and smiles when it is done.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { Knot } from "./Knot";
import { Musubi } from "./Musubi";
import { Icon } from "./Icon";
import { Button } from "./Button";
import { Hanko } from "./Display";
import { burstFrom } from "./motion";
import s from "./Seal.module.css";

export interface SealStep {
  label: string;
  state: "waiting" | "running" | "done" | "failed";
}

export function SealMoment({
  steps,
  progress,
  note,
}: {
  steps: SealStep[];
  progress: number;
  note?: ReactNode | undefined;
}) {
  const current =
    steps.find((x) => x.state === "running") ?? steps.find((x) => x.state === "failed") ?? steps[steps.length - 1];
  const failed = steps.some((x) => x.state === "failed");
  const pct = Math.max(4, Math.min(100, Math.round(progress * 100)));
  return (
    <div className={s.moment} aria-live="polite">
      <div className={s.stage}>
        <Knot size={168} tie tied={progress > 0.05} className={s.ring} color="var(--cord)" />
        <Musubi face={failed ? "worried" : "cover"} size={118} className={s.mm} sticker={false} />
      </div>
      <div
        className={s.bar}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Sealing progress"
      >
        <i style={{ width: `${pct}%` }} />
      </div>
      <p className={s.step}>{current?.label ?? "Getting ready"}</p>
      <small className={s.sub}>
        {note ?? (
          <>
            <span lang="ja">ちょっと待ってね</span> · on your device, nothing sent yet
          </>
        )}
      </small>
      <ol className={s.list}>
        {steps.map((x) => (
          <li key={x.label} className={s[x.state]}>
            <span className={s.dot} aria-hidden="true">
              {x.state === "done" ? (
                <Icon name="check" size={12} />
              ) : x.state === "failed" ? (
                <Icon name="x" size={12} />
              ) : null}
            </span>
            {x.label}
            <span className="sr-only">
              {x.state === "done"
                ? " (done)"
                : x.state === "running"
                  ? " (in progress)"
                  : x.state === "failed"
                    ? " (failed)"
                    : " (waiting)"}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export interface ReceiptLine {
  term: string;
  value: ReactNode;
}

export function Receipt({
  title,
  when,
  lines,
  hash,
  foot = "Keep this to prove what you sealed and when. It holds no part of your message.",
  stamp = "封",
}: {
  title: ReactNode;
  when: string;
  lines: ReceiptLine[];
  hash?: string | undefined;
  foot?: ReactNode | undefined;
  stamp?: string | undefined;
}) {
  return (
    <div className={s.receipt}>
      <div className={s.top}>
        <span>Seal receipt</span>
        <span>{when}</span>
      </div>
      <h3>{title}</h3>
      <div className={s.stamp}>
        <Hanko size={58} rotate={-8}>
          {stamp}
        </Hanko>
      </div>
      <p className={s.tiny}>Tied on this device, opened only by its readers.</p>
      <dl>
        {lines.map((l) => (
          <div key={l.term} className={s.line}>
            <dt>{l.term}</dt>
            <dd>{l.value}</dd>
          </div>
        ))}
      </dl>
      {hash ? <div className={s.hash}>{hash.replace(/(.{8})/g, "$1 ").trim()}</div> : null}
      {foot ? <p className={s.tiny}>{foot}</p> : null}
    </div>
  );
}

/** The finished state: happy Musubi with a sakura burst, the receipt, Copy and Done. */
export function SealDone({
  headline,
  receipt,
  onCopy,
  onDone,
  extra,
}: {
  headline: ReactNode;
  receipt: ReactNode;
  onCopy?: () => void;
  onDone: () => void;
  extra?: ReactNode | undefined;
}) {
  const mm = useRef<HTMLDivElement>(null);
  useEffect(() => {
    burstFrom(mm.current);
  }, []);
  return (
    <div className={s.done}>
      <div ref={mm} className={s.doneMm}>
        <Musubi face="happy" size={96} />
      </div>
      <p className={s.headline}>
        <Icon name="check" />
        {headline} <span lang="ja">できた！</span>
      </p>
      {receipt}
      <div className={s.actions}>
        {onCopy ? (
          <Button variant="line" icon="copy" onClick={onCopy} full>
            Copy receipt
          </Button>
        ) : null}
        <Button variant="cord" onClick={onDone} full>
          Done
        </Button>
      </div>
      {extra}
    </div>
  );
}

/** Failure: what did and did not happen, first (spec 4.1). */
export function SealFailed({
  title,
  detail,
  txHash,
  onRetry,
  onClose,
  retryLabel = "Try again",
}: {
  title: string;
  detail?: ReactNode | undefined;
  txHash?: string | undefined;
  onRetry?: () => void;
  onClose: () => void;
  retryLabel?: string | undefined;
}) {
  return (
    <div className={s.failed} role="alert">
      <Musubi face="worried" size={96} />
      <p className={s.failTitle}>
        <span lang="ja">あれ？ </span>
        {title}
      </p>
      {detail ? <div className={s.failDetail}>{detail}</div> : null}
      {txHash ? (
        <p className={s.tiny}>
          Transaction: <code className="mono">{txHash}</code>
        </p>
      ) : null}
      <div className={s.actions}>
        <Button variant="line" onClick={onClose} full>
          Close
        </Button>
        {onRetry ? (
          <Button variant="cord" onClick={onRetry} full>
            {retryLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
