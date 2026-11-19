"use client";
/**
 * Private delivery (spec 11, decision 1): while the owner's dashboard is open,
 * this device seals paid orders to their buyers. One runner for the whole app,
 * so the dashboard's background pass and the Sales tab never deliver the same
 * order twice at once; a run asked for while one is going runs right after.
 */
import { useSyncExternalStore } from "react";
import { deliverPaid, listMyProducts, listSales, type OrderView, type Tokened } from "../engine";

export interface Outcome {
  ref: string;
  ok: boolean;
  why?: string | undefined;
  at: number;
}

let running: Promise<Outcome[]> | null = null;
let again = false;
let outcomes = new Map<string, Outcome>();
let busyNow = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Per order: what the last delivery attempt on this device did. */
export const useOutcomes = () =>
  useSyncExternalStore(
    subscribe,
    () => outcomes,
    () => outcomes,
  );
export const useDelivering = () =>
  useSyncExternalStore(
    subscribe,
    () => busyNow,
    () => false,
  );

async function once(a: Tokened, only: string | undefined, orders: OrderView[] | undefined): Promise<Outcome[]> {
  const all = orders ?? (await listSales(a));
  const waiting = all.filter((o) => o.status === "paid" && !o.delivery && (!only || o.ref === only));
  if (waiting.length === 0) return [];
  const mine = await listMyProducts(a);
  const at = Date.now();
  const done = (await deliverPaid(a, waiting, mine)).map((r) => ({ ...r, at }));
  outcomes = new Map(outcomes);
  for (const r of done) outcomes.set(r.ref, r);
  return done;
}

/**
 * Seal every paid, undelivered order this device can (or just `only`).
 * Resolves to what this call did; never throws for one order's problem.
 */
export async function deliverNow(a: Tokened, opts: { only?: string; orders?: OrderView[] } = {}): Promise<Outcome[]> {
  if (running) {
    // The pass already going runs once more when it finishes, and that result includes this request.
    again = true;
    return running;
  }
  busyNow = true;
  emit();
  running = (async () => {
    try {
      let out = await once(a, opts.only, opts.orders);
      while (again) {
        again = false;
        out = [...out, ...(await once(a, undefined, undefined))];
      }
      return out;
    } finally {
      running = null;
      busyNow = false;
      emit();
    }
  })();
  return running;
}

/** One line for a toast after a pass: null when there is nothing to say. */
export function summary(done: Outcome[]): { text: string; tone: "ok" | "error" } | null {
  const ok = done.filter((d) => d.ok).length;
  const bad = done.filter((d) => !d.ok);
  if (ok && !bad.length)
    return {
      text: ok === 1 ? "Sealed to the buyer. できた！" : `Sealed ${ok} orders to their buyers. できた！`,
      tone: "ok",
    };
  if (bad.length) {
    const first = bad[0]?.why ?? "It could not be sealed here.";
    return {
      text: ok
        ? `Sealed ${ok}; ${bad.length} not sealed: ${first}`
        : bad.length === 1
          ? `An order was not sealed: ${first}`
          : `${bad.length} orders were not sealed: ${first}`,
      tone: "error",
    };
  }
  return null;
}
