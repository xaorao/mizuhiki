import { BaseError, HttpRequestError, TimeoutError } from "viem";
import { denomByBase } from "./config";
/** A chain step that did not complete, with what happened to the person's money and data. */
export type ChainErrorCode =
  | "NO_FUNDS"
  | "NO_ACCOUNT"
  | "REFUSED"
  | "SIMULATION_FAILED"
  | "NOT_COMMITTED"
  | "FAILED_IN_BLOCK"
  | "NETWORK"
  | "NO_WINDOW"
  | "WINDOW_EXHAUSTED"
  | "CONTRACT_REVERT"
  | "WALLET_REFUSED"
  | "WALLET_MISSING";

export class ChainError extends Error {
  readonly code: ChainErrorCode;
  /** Did any value or state change on chain? "no" | "yes" | "unknown" (then the tx hash says more). */
  readonly moved: "no" | "yes" | "unknown";
  readonly txHash: string | undefined;
  readonly detail: string | undefined;

  constructor(
    code: ChainErrorCode,
    message: string,
    opts: { moved?: "no" | "yes" | "unknown"; txHash?: string; detail?: string } = {},
  ) {
    super(message);
    this.name = "ChainError";
    this.code = code;
    this.moved = opts.moved ?? "no";
    this.txHash = opts.txHash;
    this.detail = opts.detail;
  }
}

export const isChainError = (e: unknown, code?: ChainErrorCode): e is ChainError =>
  e instanceof ChainError && (code === undefined || e.code === code);

/**
 * True when a check failed because QoreChain could not be reached (connection refused, timeout, offline), not
 * because the answer was wrong. Screens use it to say "could not be reached, try again" instead of calling a
 * genuine page a mismatch.
 */
export function isUnreachable(e: unknown): boolean {
  if (isChainError(e, "NETWORK")) return true;
  // A read that ran out of time (`AbortSignal.timeout`).
  if (e instanceof Error && e.name === "TimeoutError") return true;
  if (e instanceof BaseError) return !!e.walk((x) => x instanceof HttpRequestError || x instanceof TimeoutError);
  // fetch() itself: Chromium "Failed to fetch", Firefox "NetworkError when attempting…", Safari "Load failed".
  return e instanceof TypeError && /failed to fetch|networkerror|load failed|network/i.test(e.message);
}

const amountOf = (units: string, decimals: number): string => {
  const v = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  const frac = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${(v / scale).toString()}${frac ? `.${frac}` : ""}`;
};

/**
 * Which coin ran short. The bank module names it ("spendable balance 1585000erc20:0x… is smaller than
 * 10000000erc20:0x…"); a payment short of fUSD must not be blamed on the network fee.
 */
function shortfall(log: string): string {
  const fee = "Not enough test QOR to pay the network fee. Nothing was sent.";
  const m = /spendable balance (\d+)([a-z][\w:/.-]*?) is smaller than (\d+)([a-z][\w:/.-]*?):? insufficient/i.exec(log);
  if (!m) return fee;
  const [, haveUnits = "0", , needUnits = "0", base = ""] = m;
  const d = denomByBase(base);
  if (!d) return fee;
  const have = amountOf(haveUnits, d.decimals);
  const need = amountOf(needUnits, d.decimals);
  return `Not enough ${d.label}: this needs ${need} ${d.symbol} and the account has ${have} ${d.symbol}. Nothing was sent.`;
}

/** Map a Cosmos SDK refusal log to a plain sentence. */
export function explainRefusal(
  codespace: string,
  code: number,
  log: string,
): { code: ChainErrorCode; message: string } {
  const l = log.toLowerCase();
  if ((codespace === "sdk" && code === 5) || l.includes("insufficient funds")) {
    return { code: "NO_FUNDS", message: shortfall(log) };
  }
  if (l.includes("not found") && l.includes("account")) {
    return {
      code: "NO_ACCOUNT",
      message: "This account has never received QOR, so the chain does not know it yet. Nothing was sent.",
    };
  }
  if (l.includes("evm authorisation window") || l.includes("evm authorization window")) {
    return { code: "NO_WINDOW", message: "On-chain actions need a fresh permission window. Nothing was sent." };
  }
  return {
    code: "REFUSED",
    message: "The network refused this step. Nothing was sent.",
  };
}
