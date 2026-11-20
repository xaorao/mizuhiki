/**
 * Turning a caught error into words a person can act on. Our own errors already carry such words and pass
 * through; a network failure is named as one (never as "sealing failed" or "your input was wrong"); anything
 * else, such as a library's raw TypeError, gets the caller's fallback instead of its internal message.
 */
import { isChainError, isUnreachable } from "@mizuhiki/chain";
import { MizuhikiError } from "@mizuhiki/core";
import { ApiFailure } from "@/lib/api";

export const OFFLINE_TEXT =
  "This device is offline, or Mizuhiki and QoreChain could not be reached. Check your connection, then try again.";

/** For a payment whose outcome is not known: never claim money did or did not move. */
export const PAY_UNKNOWN_TEXT =
  "The payment did not finish here. Look at your wallet's history before paying again: if no new payment is there, no money moved.";

const RAW = ["TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError", "DOMException"];

export function failureText(e: unknown, fallback: string): string {
  if (e instanceof ApiFailure || e instanceof MizuhikiError || isChainError(e)) return e.message;
  if (isUnreachable(e) || (typeof navigator !== "undefined" && "onLine" in navigator && !navigator.onLine))
    return OFFLINE_TEXT;
  if (e instanceof Error && e.message && !RAW.includes(e.name) && !/^[A-Z][a-zA-Z]+Error$/.test(e.name))
    return e.message;
  return fallback;
}
