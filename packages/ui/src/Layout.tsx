"use client";
import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { Icon } from "./Icon";
import { firstGrapheme } from "./motion";
import s from "./Layout.module.css";

/** Stepper with collapsing check lines (Google inactive account stepper, spec 5.14 and 5.2 step 7). */
export interface StepItem {
  title: string;
  detail?: ReactNode | undefined;
  state: "waiting" | "running" | "done" | "failed";
  /** Shown only while the step is the current one. */
  body?: ReactNode | undefined;
}
export function Stepper({ steps }: { steps: StepItem[] }) {
  return (
    <ol className={s.stepper}>
      {steps.map((st, i) => (
        <li
          key={st.title}
          className={[s.step, s[st.state]].join(" ")}
          aria-current={st.state === "running" ? "step" : undefined}
        >
          <span className={s.num} aria-hidden="true">
            {st.state === "done" ? (
              <Icon name="check" size={16} />
            ) : st.state === "failed" ? (
              <Icon name="x" size={16} />
            ) : (
              i + 1
            )}
          </span>
          <div className={s.stepText}>
            <b>{st.title}</b>
            {st.detail ? <small>{st.detail}</small> : null}
            {st.state === "running" || st.state === "failed" ? st.body : null}
          </div>
          <span className="sr-only">{st.state}</span>
        </li>
      ))}
    </ol>
  );
}

/** Accessible tabs with arrow-key movement. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: { value: T; label: string; badge?: number | undefined }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const base = useId();
  const list = useRef<HTMLDivElement>(null);
  const onKey = (e: KeyboardEvent) => {
    const i = tabs.findIndex((t) => t.value === value);
    const next =
      e.key === "ArrowRight" ? (i + 1) % tabs.length : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length : -1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next];
    if (!t) return;
    onChange(t.value);
    list.current?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
  };
  return (
    <div ref={list} role="tablist" aria-label={label} className={s.tabs} onKeyDown={onKey}>
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          id={`${base}-${t.value}`}
          aria-selected={t.value === value}
          tabIndex={t.value === value ? 0 : -1}
          onClick={() => onChange(t.value)}
        >
          {t.label}
          {t.badge ? <span className={s.badge}>{t.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** A phone frame for the live preview and landing scenes. */
export function PhoneFrame({
  children,
  tilt = 0,
  width = 300,
}: {
  children: ReactNode;
  tilt?: number | undefined;
  width?: number | undefined;
}) {
  return (
    <div className={s.phone} style={{ width, transform: tilt ? `rotate(${tilt}deg)` : undefined }}>
      <div className={s.screen}>{children}</div>
    </div>
  );
}

/** Avatar: an image, or initials on a pastel ground, with an optional lock badge. */
export function Avatar({
  name,
  src,
  size = 104,
  lock = false,
  tone = "peach",
  blank = false,
}: {
  name: string;
  src?: string | undefined;
  size?: number | undefined;
  lock?: boolean | undefined;
  tone?: "peach" | "sakura" | "sora" | "matcha" | "butter" | "fuji" | undefined;
  /** No letters yet (the name is still being opened): a plain coloured circle. */
  blank?: boolean | undefined;
}) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => firstGrapheme(w).toUpperCase())
      .join("") || "?";
  return (
    <span
      className={[s.avatar, s[`a_${tone}`]].join(" ")}
      style={{ width: size, height: size, fontSize: size * 0.34, borderWidth: size > 60 ? 4 : 2.5 }}
    >
      {src ? (
        <img src={src} alt="" width={size} height={size} />
      ) : blank ? null : (
        <span aria-hidden="true">{initials}</span>
      )}
      <span className="sr-only">{name}</span>
      {lock ? (
        <span className={s.lock} style={{ width: size * 0.3, height: size * 0.3 }} aria-hidden="true">
          <Icon name="lock" size={Math.max(12, size * 0.15)} />
        </span>
      ) : null}
    </span>
  );
}
