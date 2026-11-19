"use client";
/**
 * Progress through a room-key change (engine `onStep`), said plainly while it
 * runs, and a failure message that says what happened to the room first.
 */
import { useCallback, useState } from "react";
import { Icon } from "@mizuhiki/ui";
import { STEP_LABEL, type Step } from "../engine";
import s from "./info.module.css";

const ORDER: Step[] = ["keys", "seal", "chain", "relay", "announce"];

export function useSteps() {
  const [at, setAt] = useState<Step | null>(null);
  const onStep = useCallback((st: Step) => setAt(st), []);
  const reset = useCallback(() => setAt(null), []);
  return { at, onStep, reset };
}

/** Where a failed key change left the room, from the step it reached. */
export function changeFailure(e: unknown, at: Step | null): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (at === "relay" || at === "announce")
    return `The change is recorded on QoreChain, but it did not finish here: ${msg} Reopen the room to pick it up.`;
  if (at === "chain") return `Nothing was recorded on QoreChain and the room key did not change. ${msg}`;
  return `Nothing changed in the room. ${msg}`;
}

export function StepList({ at }: { at: Step | null }) {
  if (!at) return null;
  const idx = ORDER.indexOf(at);
  return (
    <ol className={s.steps} aria-live="polite">
      {ORDER.map((k, i) => {
        const state = i < idx ? "done" : i === idx ? "running" : "waiting";
        return (
          <li key={k} data-state={state}>
            <span className={s.dot} aria-hidden="true">
              {state === "done" ? <Icon name="check" size={12} /> : null}
            </span>
            <span>
              {STEP_LABEL[k]}
              {state === "running" ? "…" : ""}
              <span className="sr-only">{state === "done" ? " (done)" : state === "running" ? " (in progress)" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function InlineError({ children }: { children: string | null }) {
  if (!children) return null;
  return (
    <p className={s.err} role="alert">
      <Icon name="alert" size={16} />
      <span>{children}</span>
    </p>
  );
}
