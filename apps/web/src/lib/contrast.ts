"use client";
/**
 * High-contrast mode (spec 4.8): black ink on white, every tint white, stronger lines (`[data-theme="contrast"]`
 * in tokens.css). It follows the device's "increase contrast" setting unless the person chooses On or Off in
 * Settings; the choice is a device preference, kept on this device. CONTRAST_SCRIPT applies it before the first
 * paint so the page never flashes the other theme.
 */
import { useCallback, useEffect, useState } from "react";

export type ContrastChoice = "device" | "on" | "off";

const KEY = "mz-contrast";
const QUERY = "(prefers-contrast: more)";

/** Runs in <head> before paint, with the page's CSP nonce. Kept tiny and dependency-free. */
export const CONTRAST_SCRIPT = `try{var c=localStorage.getItem("${KEY}");if(c==="on"||(c!=="off"&&matchMedia("${QUERY}").matches))document.documentElement.dataset.theme="contrast"}catch(e){}`;

function readChoice(): ContrastChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === "on" || v === "off" ? v : "device";
  } catch {
    return "device";
  }
}

function apply(choice: ContrastChoice): void {
  const on = choice === "on" || (choice === "device" && matchMedia(QUERY).matches);
  if (on) document.documentElement.dataset.theme = "contrast";
  else delete document.documentElement.dataset.theme;
}

/** Keeps the page in step with the device setting while it is open (choice "device"). Mounted once. */
export function ContrastSync() {
  useEffect(() => {
    const mq = matchMedia(QUERY);
    const onChange = () => apply(readChoice());
    mq.addEventListener("change", onChange);
    window.addEventListener("storage", onChange);
    return () => {
      mq.removeEventListener("change", onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);
  return null;
}

/** The person's choice on this device, and a setter that applies it at once. */
export function useContrast(): [ContrastChoice, (c: ContrastChoice) => void] {
  const [choice, setChoice] = useState<ContrastChoice>("device");
  useEffect(() => setChoice(readChoice()), []);
  const set = useCallback((c: ContrastChoice) => {
    try {
      if (c === "device") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, c);
    } catch {
      // Storage refused (private mode): the choice still applies to this page.
    }
    apply(c);
    setChoice(c);
  }, []);
  return [choice, set];
}
