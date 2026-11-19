"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { Musubi, type MusubiFace } from "./Musubi";
import { ripple, useReducedMotion } from "./motion";
import s from "./Display.module.css";

export type Tone = "sakura" | "sora" | "matcha" | "butter" | "fuji" | "kinari" | "cord" | "white";

/** A public-page block row: round pastel tile, title, detail, chevron. `feature` = the one filled cord row. */
export function Row({
  icon,
  title,
  detail,
  tone = "sakura",
  feature,
  onClick,
  href,
  trailing,
}: {
  icon: IconName;
  title: ReactNode;
  detail?: ReactNode | undefined;
  tone?: Tone | undefined;
  feature?: boolean | undefined;
  onClick?: () => void;
  href?: string | undefined;
  trailing?: ReactNode | undefined;
}) {
  const body = (
    <>
      <span className={[s.tile, s[`t_${feature ? "white" : tone}`]].join(" ")} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <span className={s.rowText}>
        <b>{title}</b>
        {detail ? <small>{detail}</small> : null}
      </span>
      {trailing ?? <Icon name="chev" className={s.chev} />}
    </>
  );
  const cls = [s.row, feature ? s.feature : ""].join(" ");
  if (href)
    return (
      <a className={cls} href={href} onPointerDown={ripple} target="_blank" rel="noopener noreferrer">
        {body}
      </a>
    );
  return (
    <button type="button" className={cls} onClick={onClick} onPointerDown={ripple}>
      {body}
    </button>
  );
}

export function Chip({
  children,
  tone = "sakura",
  icon,
}: {
  children: ReactNode;
  tone?: Tone | undefined;
  icon?: IconName | undefined;
}) {
  return (
    <span className={[s.chip, s[`c_${tone}`]].join(" ")}>
      {icon ? <Icon name={icon} size={14} /> : null}
      {children}
    </span>
  );
}

export type Status = "ok" | "wait" | "danger" | "info" | "neutral";
const STATUS_ICON: Record<Status, IconName> = {
  ok: "check",
  wait: "clock",
  danger: "alert",
  info: "info",
  neutral: "more",
};
/** Status always comes with an icon and a word (brand README). */
export function StatusChip({ status, children }: { status: Status; children: ReactNode }) {
  return (
    <span className={[s.status, s[`s_${status}`]].join(" ")}>
      <Icon name={STATUS_ICON[status]} size={14} />
      {children}
    </span>
  );
}

/** Type chip for inbox rows (Message, Payment, Form answer…). */
export function TypeChip({ children, tone = "white" }: { children: ReactNode; tone?: Tone | undefined }) {
  return <span className={[s.type, s[`c_${tone}`]].join(" ")}>{children}</span>;
}

/** The readers line: "Readers: you and @mila (accountant)". */
export function Readers({
  readers,
  hidden,
}: {
  readers: { label: string; detail?: string | undefined }[];
  hidden?: boolean | undefined;
}) {
  return (
    <div className={s.readers}>
      <span>Readers:</span>
      {hidden ? (
        <Chip icon="lock">Readers hidden from outsiders</Chip>
      ) : (
        readers.map((r) => (
          <Chip key={r.label} icon="lock">
            {r.label}
            {r.detail ? <span className={s.readerDetail}> {r.detail}</span> : null}
          </Chip>
        ))
      )}
    </div>
  );
}

/** One-line honesty label (spec 4.5). */
export function LockLine({ children }: { children: ReactNode }) {
  return (
    <p className={s.lockline}>
      <Icon name="lock" size={14} />
      {children}
    </p>
  );
}

export function Panel({
  title,
  action,
  children,
  kicker,
}: {
  title?: ReactNode | undefined;
  action?: ReactNode | undefined;
  children: ReactNode;
  kicker?: string | undefined;
}) {
  return (
    <section className={s.panel}>
      {title !== undefined || action !== undefined ? (
        <header className={s.panelHead}>
          <div>
            {kicker ? (
              <p className={s.kicker} lang="ja">
                {kicker}
              </p>
            ) : null}
            {title !== undefined ? <h2>{title}</h2> : null}
          </div>
          {action}
        </header>
      ) : null}
      <div className={s.panelBody}>{children}</div>
    </section>
  );
}

/** Animated count-up for stat tiles (numbers count up; reduced motion shows the value). */
export function CountUp({
  value,
  format = (n) => n.toLocaleString("en-US"),
  duration = 900,
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number | undefined;
}) {
  const reduced = useReducedMotion();
  const [shown, setShown] = useState(reduced ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (reduced) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      const e = 1 - Math.pow(1 - k, 3);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, reduced, duration]);
  return <>{format(Number.isInteger(value) ? Math.round(shown) : shown)}</>;
}

export function StatTile({
  label,
  value,
  format,
  detail,
  tone = "sakura",
}: {
  label: string;
  value: number;
  format?: (n: number) => string;
  detail?: ReactNode | undefined;
  tone?: Tone | undefined;
}) {
  return (
    <div className={[s.stat, s[`st_${tone}`]].join(" ")}>
      <small>{label}</small>
      <b>
        <CountUp value={value} {...(format ? { format } : {})} />
      </b>
      {detail ? <em>{detail}</em> : null}
    </div>
  );
}

/** Pastel skeleton blocks for loading states (spec 4.6). */
export function Skeleton({
  lines = 3,
  avatar = false,
  height,
}: {
  lines?: number | undefined;
  avatar?: boolean | undefined;
  height?: number | undefined;
}) {
  return (
    <div className={s.skeleton} aria-hidden="true" style={height ? { minHeight: height } : undefined}>
      {avatar ? <span className={s.skAvatar} /> : null}
      <span className={s.skLines}>
        {Array.from({ length: lines }, (_, i) => (
          <span key={i} className={s.skLine} style={{ width: `${92 - i * 17}%` }} />
        ))}
      </span>
    </div>
  );
}

/** Empty: Musubi, one sentence, one primary action, one learn-more link (spec 4.6). */
export function EmptyState({
  title,
  children,
  action,
  face = "sleepy",
  jp,
}: {
  title: ReactNode;
  children?: ReactNode | undefined;
  action?: ReactNode | undefined;
  face?: MusubiFace | undefined;
  jp?: string | undefined;
}) {
  return (
    <div className={s.empty}>
      <Musubi face={face} size={120} bob />
      {jp ? (
        <p className={s.emptyJp} lang="ja">
          {jp}
        </p>
      ) : null}
      <b>{title}</b>
      {children ? <span>{children}</span> : null}
      {action ? <div className={s.emptyAction}>{action}</div> : null}
    </div>
  );
}

/** Error notice: worried Musubi, what happened to the data first, then the fix. */
export function Oops({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode | undefined;
  action?: ReactNode | undefined;
}) {
  return (
    <div className={s.oops} role="alert">
      <Musubi face="worried" size={58} />
      <div>
        <b>
          <span lang="ja">あれ？ </span>
          {title}
        </b>
        {children ? <span>{children}</span> : null}
        {action ? <div className={s.oopsAction}>{action}</div> : null}
      </div>
    </div>
  );
}

/** Offline banner: the dashboard still opens loaded items; sends queue (spec 4.6). */
export function OfflineBanner({ queued = 0 }: { queued?: number | undefined }) {
  return (
    <div className={s.offline} role="status">
      <Icon name="wifi-off" size={18} />
      <span>
        <b>You are offline.</b> Items you already opened stay readable.
        {queued > 0
          ? ` ${queued} ${queued === 1 ? "send is" : "sends are"} waiting on this device and will go when you are back.`
          : " Anything you send waits on this device."}
      </span>
    </div>
  );
}

/** Hanko stamp: cord-red rounded square, white kanji, rotated. */
export function Hanko({
  children = "封",
  size = 64,
  rotate = 8,
}: {
  children?: ReactNode | undefined;
  size?: number | undefined;
  rotate?: number | undefined;
}) {
  return (
    <span
      className={s.hanko}
      lang="ja"
      style={{ width: size, height: size, fontSize: size * 0.36, transform: `rotate(${rotate}deg)` }}
      aria-hidden="true"
    >
      {children}
    </span>
  );
}

/** Circular progress (setup checklist ring). */
export function ProgressRing({ done, total, size = 48 }: { done: number; total: number; size?: number | undefined }) {
  const c = 2 * Math.PI * 18;
  const pct = total === 0 ? 0 : Math.min(1, done / total);
  return (
    <svg viewBox="0 0 44 44" width={size} height={size} role="img" aria-label={`${done} of ${total} complete`}>
      <circle cx="22" cy="22" r="18" fill="none" stroke="var(--sakura)" strokeWidth="5" />
      <circle
        cx="22"
        cy="22"
        r="18"
        fill="none"
        stroke="var(--cord)"
        strokeWidth="5"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - pct)}
        strokeLinecap="round"
        transform="rotate(-90 22 22)"
        style={{ transition: "stroke-dashoffset .6s var(--ease-out)" }}
      />
      <text
        x="22"
        y="26"
        textAnchor="middle"
        fontSize="11"
        fontWeight="900"
        fill="var(--ink)"
        fontFamily="var(--font-round)"
      >
        {done}/{total}
      </text>
    </svg>
  );
}

/** Japanese kicker with the short rule, above a heading. */
export function Kicker({ children }: { children: string }) {
  return (
    <p className={s.jpKicker} lang="ja">
      {children}
    </p>
  );
}

/** Falling sakura petals over a region. Decorative; off with reduced motion. */
export function Sakura({ count = 5 }: { count?: number | undefined }) {
  const reduced = useReducedMotion();
  if (reduced) return null;
  const spots = [8, 22, 41, 63, 80, 92, 31, 54];
  return (
    <div className={s.sakura} aria-hidden="true">
      {spots.slice(0, count).map((left, i) => (
        <svg
          key={left}
          viewBox="0 0 40 40"
          style={{ left: `${left}%`, animationDelay: `${-((i * 2.3) % 9)}s`, animationDuration: `${9 + (i % 4)}s` }}
        >
          <path d="M20 4 C30 10 34 22 20 36 C6 22 10 10 20 4Z" fill="#ffb3c3" stroke="#f08aa3" strokeWidth="1.5" />
          <path d="M20 4 L20 13" stroke="#f08aa3" strokeWidth="1.5" />
        </svg>
      ))}
    </div>
  );
}

/** Mono value with copy: hashes, addresses. */
export function CopyValue({
  value,
  label,
  short = false,
  onCopied,
}: {
  value: string;
  label: string;
  short?: boolean | undefined;
  onCopied?: (ok: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const shown = short && value.length > 20 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
  return (
    <span className={s.copy}>
      <code title={value}>{shown}</code>
      <button
        type="button"
        aria-label={`Copy ${label}`}
        onClick={() => {
          navigator.clipboard.writeText(value).then(
            () => {
              setCopied(true);
              onCopied?.(true);
              setTimeout(() => setCopied(false), 1600);
            },
            () => onCopied?.(false),
          );
        }}
      >
        <Icon name={copied ? "check" : "copy"} size={16} />
      </button>
    </span>
  );
}
