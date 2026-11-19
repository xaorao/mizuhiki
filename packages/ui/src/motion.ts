"use client";
import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";
const subscribe = (cb: () => void) => {
  const m = matchMedia(QUERY);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};

/** True when the person asked for reduced motion. Server render assumes motion is allowed. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(QUERY).matches,
    () => false,
  );
}

export const prefersReducedMotion = (): boolean => typeof matchMedia !== "undefined" && matchMedia(QUERY).matches;

/** Sakura petals bursting from a point (Level 3 preview `burst`). No-op with reduced motion. */
export function burst(x: number, y: number, n = 12): void {
  if (typeof document === "undefined" || prefersReducedMotion()) return;
  for (let i = 0; i < n; i++) {
    const p = document.createElement("span");
    p.className = "mz-burst";
    p.setAttribute("aria-hidden", "true");
    const a = (Math.PI * 2 * i) / n + Math.random() * 0.4;
    const d = 60 + Math.random() * 70;
    p.style.left = `${x}px`;
    p.style.top = `${y}px`;
    p.style.setProperty("--dx", `${Math.cos(a) * d}px`);
    p.style.setProperty("--dy", `${Math.sin(a) * d - 30}px`);
    p.style.setProperty("--r", `${Math.random() * 540 - 270}deg`);
    p.innerHTML =
      '<svg viewBox="0 0 40 40"><path d="M20 4 C30 10 34 22 20 36 C6 22 10 10 20 4Z" fill="#ffb3c3" stroke="#f08aa3" stroke-width="1.5"/><path d="M20 4 L20 13" stroke="#f08aa3" stroke-width="1.5"/></svg>';
    document.body.appendChild(p);
    setTimeout(() => p.remove(), 1100);
  }
}

export function burstFrom(el: Element | null | undefined, n = 12): void {
  if (!el) return;
  const r = el.getBoundingClientRect();
  burst(r.left + r.width / 2, r.top + r.height / 2, n);
}

/** Press ripple from the pointer position, on any element. */
export function ripple(e: { clientX: number; clientY: number; currentTarget: HTMLElement }): void {
  if (prefersReducedMotion()) return;
  const b = e.currentTarget;
  const r = b.getBoundingClientRect();
  const s = document.createElement("span");
  s.className = "mz-ripple";
  const d = Math.max(r.width, r.height);
  s.style.width = s.style.height = `${d}px`;
  s.style.left = `${e.clientX - r.left - d / 2}px`;
  s.style.top = `${e.clientY - r.top - d / 2}px`;
  b.appendChild(s);
  setTimeout(() => s.remove(), 600);
}

/** User-visible characters (grapheme clusters), so an emoji counts as one. */
export function graphemeCount(s: string): number {
  if (typeof Intl.Segmenter === "function") {
    let n = 0;
    for (const _ of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) n++;
    return n;
  }
  return Array.from(s).length;
}

export function firstGrapheme(s: string): string {
  if (typeof Intl.Segmenter === "function") {
    for (const g of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)) return g.segment;
    return "";
  }
  return Array.from(s)[0] ?? "";
}
