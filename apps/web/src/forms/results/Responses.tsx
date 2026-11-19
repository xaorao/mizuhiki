"use client";
/**
 * The responses table (Typeform's table view): search, a filter builder
 * "[question] is any of [answers]" with Clear all, newest first, one column
 * per question. Everything runs over answers opened on this device.
 */
import { useId, type KeyboardEvent } from "react";
import { Button, Icon, IconButton, TextField } from "@mizuhiki/ui";
import type { Question } from "@mizuhiki/core";
import { optionsOf, type Filter, type TableModel } from "./aggregate";
import s from "../results.module.css";

export function FilterBar({
  questions,
  filters,
  onFilters,
  search,
  onSearch,
  shown,
  total,
}: {
  questions: Question[];
  filters: Filter[];
  onFilters: (f: Filter[]) => void;
  search: string;
  onSearch: (s: string) => void;
  shown: number;
  total: number;
}) {
  const base = useId();
  const filterable = questions.filter((q) => optionsOf(q) !== null);
  const free = filterable.filter((q) => !filters.some((f) => f.qid === q.id));
  const set = (i: number, f: Filter) => onFilters(filters.map((x, j) => (j === i ? f : x)));
  return (
    <div className={s.filterBar}>
      <TextField
        label="Search responses"
        hideLabel
        type="search"
        placeholder="Search responses"
        prefix={<Icon name="search" size={16} />}
        value={search}
        onChange={(e) => onSearch(e.target.value)}
      />
      {filters.map((f, i) => {
        const q = filterable.find((x) => x.id === f.qid);
        const opts = q ? (optionsOf(q) ?? []) : [];
        return (
          <div key={`${f.qid}-${i}`} className={s.filter}>
            <div className={s.filterHead}>
              <label htmlFor={`${base}-${i}`} className="sr-only">
                Question to filter by
              </label>
              <select
                id={`${base}-${i}`}
                className={s.select}
                value={f.qid}
                onChange={(e) => set(i, { qid: e.target.value, keys: [] })}
              >
                {filterable
                  .filter((x) => x.id === f.qid || free.includes(x))
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title || "Untitled question"}
                    </option>
                  ))}
              </select>
              <span className={s.isAnyOf}>is any of</span>
              <IconButton
                icon="x"
                label="Remove this filter"
                size="sm"
                onClick={() => onFilters(filters.filter((_, j) => j !== i))}
              />
            </div>
            <div className={s.chips} role="group" aria-label="Answers to match">
              {opts.map((o) => {
                const on = f.keys.includes(o.key);
                return (
                  <button
                    key={o.key}
                    type="button"
                    aria-pressed={on}
                    className={s.pick}
                    onClick={() => set(i, { ...f, keys: on ? f.keys.filter((k) => k !== o.key) : [...f.keys, o.key] })}
                  >
                    {on ? <Icon name="check" size={12} /> : null}
                    {o.label}
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className={s.filterActions}>
        {free[0] ? (
          <Button
            variant="line"
            size="sm"
            icon="plus"
            onClick={() => onFilters([...filters, { qid: free[0]?.id ?? "", keys: [] }])}
          >
            Add filter
          </Button>
        ) : null}
        {filters.length || search ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onFilters([]);
              onSearch("");
            }}
          >
            Clear all
          </Button>
        ) : null}
        <span className={s.count} aria-live="polite">
          {shown === total ? `${total} response${total === 1 ? "" : "s"}` : `${shown} of ${total} responses`}
        </span>
      </div>
    </div>
  );
}

export function ResponsesTable({
  table,
  selected,
  onSelect,
}: {
  table: TableModel;
  selected: string | null;
  onSelect: (hash: string) => void;
}) {
  const key = (e: KeyboardEvent, hash: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onSelect(hash);
    }
  };
  return (
    <div className={s.tableWrap} tabIndex={0} role="region" aria-label="Responses table">
      <table className={s.table}>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr
              key={r.hash}
              tabIndex={0}
              aria-current={selected === r.hash ? "true" : undefined}
              className={selected === r.hash ? s.rowOn : undefined}
              onClick={() => onSelect(r.hash)}
              onKeyDown={(e) => key(e, r.hash)}
            >
              {r.cells.map((c, i) => (
                <td key={i} title={String(c)}>
                  {String(c) || <span className={s.dash}>–</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
