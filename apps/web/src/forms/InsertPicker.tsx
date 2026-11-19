"use client";
/**
 * Tally's "Insert anything": a search box, the list on the left and a live
 * explanation on the right. ↑ and ↓ browse, Enter inserts, Esc closes.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Sheet } from "@mizuhiki/ui";
import { KINDS, type KindInfo } from "./model";
import s from "./forms.module.css";

export function InsertPicker({
  open,
  initial = "",
  onPick,
  onClose,
}: {
  open: boolean;
  initial?: string;
  onPick: (k: KindInfo["kind"]) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState(initial);
  const [at, setAt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) {
      setQ(initial);
      setAt(0);
      setTimeout(() => input.current?.focus(), 30);
    }
  }, [open, initial]);
  const list = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? KINDS.filter((k) => `${k.label} ${k.group} ${k.help}`.toLowerCase().includes(n)) : KINDS;
  }, [q]);
  const cur = list[Math.min(at, list.length - 1)];

  return (
    <Sheet open={open} onClose={onClose} title="Insert anything" wide>
      <div className={s.picker}>
        <div className={s.pickerList}>
          <label className={s.pickerSearch}>
            <Icon name="search" size={16} />
            <input
              ref={input}
              value={q}
              aria-label="Search blocks"
              placeholder="Search for a question or layout block"
              onChange={(e) => {
                setQ(e.target.value);
                setAt(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setAt((i) => Math.min(list.length - 1, i + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setAt((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter" && cur) {
                  e.preventDefault();
                  onPick(cur.kind);
                }
              }}
            />
          </label>
          <p className={s.pickerHelp}>Use ↑ and ↓ to browse the list, then hit ↵ to insert the selected block.</p>
          <ul role="listbox" aria-label="Blocks">
            {list.map((k, i) => (
              <li key={k.kind}>
                <button
                  type="button"
                  role="option"
                  aria-selected={i === at}
                  className={i === at ? s.pickOn : undefined}
                  onMouseEnter={() => setAt(i)}
                  onClick={() => onPick(k.kind)}
                >
                  <Icon name={k.icon} size={16} />
                  {k.label}
                  <small>{k.group}</small>
                </button>
              </li>
            ))}
            {list.length === 0 ? <li className={s.pickerNone}>Nothing called that. Try “email” or “choice”.</li> : null}
          </ul>
        </div>
        {cur ? (
          <div className={s.pickerPreview} aria-live="polite">
            <span className={s.pickerIcon}>
              <Icon name={cur.icon} size={22} />
            </span>
            <h3>{cur.label}</h3>
            <p>{cur.help}</p>
            <div className={s.pickerExample}>
              <small>Example</small>
              <span>{cur.example}</span>
            </div>
            <button type="button" className={s.pickerInsert} onClick={() => onPick(cur.kind)}>
              Insert →
            </button>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
