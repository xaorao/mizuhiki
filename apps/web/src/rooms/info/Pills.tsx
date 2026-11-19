"use client";
/** Single choice as wrapping pills: a radio group that fits a narrow panel or a phone sheet. */
import type { KeyboardEvent } from "react";
import { ripple } from "@mizuhiki/ui";
import s from "./info.module.css";

export function Pills<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean | undefined;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === value);
    const next = options[(i + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[options.indexOf(next)]?.focus();
  };
  return (
    <div className={s.pills} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          disabled={disabled}
          onPointerDown={ripple}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
