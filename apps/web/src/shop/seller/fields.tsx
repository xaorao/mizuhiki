"use client";
/** Inputs the product editor shares: an amount in a token (typed as "12.50", stored in base units) and a whole-number field. */
import { useEffect, useState, type ReactNode } from "react";
import { TextField } from "@mizuhiki/ui";
import { parseAmount, type ShopToken } from "@mizuhiki/core";
import { amountInput } from "./model";

/**
 * Keeps what the person is typing ("12.") while the stored value stays valid
 * base units; an invalid entry shows its error and is not stored.
 */
export function AmountField({
  label,
  value,
  token,
  onChange,
  hint,
  min = 0n,
  allowZero = false,
  error,
}: {
  label: string;
  value: string;
  token: ShopToken;
  onChange: (base: string) => void;
  hint?: ReactNode;
  min?: bigint;
  allowZero?: boolean;
  error?: string | null | undefined;
}) {
  const [text, setText] = useState(() => amountInput(value, token));
  // Follow outside changes (undo, a token switch) without fighting the person's typing.
  useEffect(() => {
    setText((t) => (parseAmount(t, token)?.toString() === value ? t : amountInput(value, token)));
  }, [value, token]);
  const parsed = parseAmount(text, token);
  const own =
    parsed === null
      ? `Use a number in ${token}, like 12 or 4.50.`
      : parsed === 0n && !allowZero
        ? "Use an amount above zero."
        : parsed < min
          ? `At least ${amountInput(min, token)} ${token}.`
          : null;
  return (
    <TextField
      label={`${label} (${token})`}
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const p = parseAmount(e.target.value, token);
        if (p !== null && (p > 0n || allowZero) && p >= min) onChange(p.toString());
      }}
      error={own ?? error ?? undefined}
      hint={hint}
    />
  );
}

/** A whole number, or empty for "no limit" when `optional`. */
export function CountField({
  label,
  value,
  onChange,
  min = 1,
  max = 1_000_000,
  hint,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
  min?: number;
  max?: number;
  hint?: ReactNode;
  placeholder?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    setText((t) => ((t === "" ? null : Number(t)) === value ? t : value === null ? "" : String(value)));
  }, [value]);
  const n = text === "" ? null : Number(text);
  const err = n !== null && (!Number.isInteger(n) || n < min || n > max) ? `Use a whole number from ${min} to ${max.toLocaleString("en-GB")}.` : null;
  return (
    <TextField
      label={label}
      inputMode="numeric"
      value={text}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value.replace(/\D/g, "").slice(0, 7);
        setText(t);
        const v = t === "" ? null : Number(t);
        if (v === null || (v >= min && v <= max)) onChange(v);
      }}
      error={err ?? undefined}
      hint={hint}
    />
  );
}
