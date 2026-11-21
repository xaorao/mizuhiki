"use client";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Icon } from "./Icon";
import { graphemeCount } from "./motion";
import s from "./Field.module.css";

interface FieldBits {
  label: ReactNode;
  /** Shown under the field, before any error. */
  hint?: ReactNode | undefined;
  /** Inline, specific, with the fix ("Usernames must be 3 characters or longer"). */
  error?: ReactNode | undefined;
  /** Shown under the field in green with a tick ("It's available"). */
  ok?: ReactNode | undefined;
  /** A fixed prefix inside the field, like "mizuhiki.me/@". */
  prefix?: ReactNode | undefined;
  /** Show a character counter against maxLength. */
  counter?: boolean | undefined;
  hideLabel?: boolean | undefined;
}

function Messages({
  id,
  hint,
  error,
  ok,
  count,
  max,
}: {
  id: string;
  hint?: ReactNode | undefined;
  error?: ReactNode | undefined;
  ok?: ReactNode | undefined;
  count?: number | undefined;
  max?: number | undefined;
}) {
  return (
    <div className={s.msgs}>
      <div id={`${id}-msg`} aria-live="polite">
        {error ? (
          <p className={s.error}>
            <Icon name="alert" size={16} />
            {error}
          </p>
        ) : ok ? (
          <p className={s.ok}>
            <Icon name="check" size={16} />
            {ok}
          </p>
        ) : hint ? (
          <p className={s.hint}>{hint}</p>
        ) : null}
      </div>
      {max !== undefined && count !== undefined ? (
        <span className={[s.count, count > max ? s.over : ""].join(" ")}>
          {count} / {max}
        </span>
      ) : null}
    </div>
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  FieldBits & Omit<InputHTMLAttributes<HTMLInputElement>, "prefix">
>(function TextField(
  { label, hint, error, ok, prefix, counter, hideLabel, className, id: idProp, maxLength, value, ...rest },
  ref,
) {
  const auto = useId();
  const id = idProp ?? auto;
  const count = typeof value === "string" ? graphemeCount(value) : undefined;
  return (
    <div className={[s.field, className ?? ""].join(" ")}>
      <label htmlFor={id} className={hideLabel ? "sr-only" : s.label}>
        {label}
      </label>
      <div className={[s.box, error ? s.bad : "", ok ? s.good : ""].join(" ")}>
        {prefix ? <span className={s.prefix}>{prefix}</span> : null}
        <input
          ref={ref}
          id={id}
          className={s.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-msg`}
          maxLength={maxLength}
          value={value}
          {...rest}
        />
      </div>
      <Messages
        id={id}
        hint={hint}
        error={error}
        ok={ok}
        {...(counter && maxLength ? { count: count ?? 0, max: maxLength } : {})}
      />
    </div>
  );
});

export const TextArea = forwardRef<HTMLTextAreaElement, FieldBits & TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function TextArea(
    { label, hint, error, ok, counter, hideLabel, className, id: idProp, maxLength, value, ...rest },
    ref,
  ) {
    const auto = useId();
    const id = idProp ?? auto;
    const count = typeof value === "string" ? graphemeCount(value) : undefined;
    return (
      <div className={[s.field, className ?? ""].join(" ")}>
        <label htmlFor={id} className={hideLabel ? "sr-only" : s.label}>
          {label}
        </label>
        <textarea
          ref={ref}
          id={id}
          className={[s.area, error ? s.bad : ""].join(" ")}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-msg`}
          maxLength={maxLength}
          value={value}
          {...rest}
        />
        <Messages
          id={id}
          hint={hint}
          error={error}
          ok={ok}
          {...(counter && maxLength ? { count: count ?? 0, max: maxLength } : {})}
        />
      </div>
    );
  },
);

/** On/off switch (role="switch"). */
export function Switch({
  checked,
  onChange,
  label,
  hideLabel = true,
  disabled,
  size = "md",
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hideLabel?: boolean | undefined;
  disabled?: boolean | undefined;
  size?: "sm" | "md" | undefined;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={hideLabel ? label : undefined}
      disabled={disabled}
      className={[s.switch, size === "sm" ? s.switchSm : ""].join(" ")}
      onClick={() => onChange(!checked)}
    >
      <span className={s.knob} aria-hidden="true" />
      {hideLabel ? null : <span className={s.switchLabel}>{label}</span>}
    </button>
  );
}

/** A row with text on the left and a switch on the right (the preview's "toggle"). */
export function ToggleRow({
  title,
  detail,
  checked,
  onChange,
  disabled,
}: {
  title: ReactNode;
  detail?: ReactNode | undefined;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean | undefined;
}) {
  const id = useId();
  return (
    // The whole row is a tap target (phones especially); the switch stays the one focusable control.
    <div
      className={[s.toggleRow, disabled ? "" : s.toggleRowTap].join(" ")}
      onClick={(e) => {
        if (disabled || (e.target as HTMLElement).closest("button")) return;
        onChange(!checked);
      }}
    >
      <span id={id}>
        <b>{title}</b>
        {detail ? <small>{detail}</small> : null}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        className={s.switch}
        onClick={() => onChange(!checked)}
      >
        <span className={s.knob} aria-hidden="true" />
      </button>
    </div>
  );
}

/** Segmented control (Links | Shop). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  stackOnPhone = false,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  /** Long labels: on a phone the options stack as a list instead of wrapping inside the pill. */
  stackOnPhone?: boolean | undefined;
}) {
  return (
    <div className={[s.seg, stackOnPhone ? s.segStack : ""].join(" ")} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Big selectable cards (goal step, type cards). */
export function ChoiceCard({
  selected,
  onSelect,
  title,
  detail,
  icon,
  tone = "sakura",
  role = "radio",
}: {
  selected: boolean;
  onSelect: () => void;
  title: ReactNode;
  detail?: ReactNode | undefined;
  icon?: ReactNode | undefined;
  tone?: "sakura" | "sora" | "matcha" | "butter" | "fuji" | "kinari" | undefined;
  role?: "radio" | "checkbox" | undefined;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      className={[s.choice, s[`tone_${tone}`], selected ? s.chosen : ""].join(" ")}
      onClick={onSelect}
    >
      {icon ? <span className={s.choiceIcon}>{icon}</span> : null}
      <span className={s.choiceText}>
        <b>{title}</b>
        {detail ? <small>{detail}</small> : null}
      </span>
      <span className={s.choiceTick} aria-hidden="true">
        <Icon name="check" size={16} />
      </span>
    </button>
  );
}
