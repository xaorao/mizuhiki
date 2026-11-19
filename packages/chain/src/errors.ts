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

/** Map a Cosmos SDK refusal log to a plain sentence. */
export function explainRefusal(
  codespace: string,
  code: number,
  log: string,
): { code: ChainErrorCode; message: string } {
  const l = log.toLowerCase();
  if ((codespace === "sdk" && code === 5) || l.includes("insufficient funds")) {
    return { code: "NO_FUNDS", message: "Not enough test QOR to pay the network fee. Nothing was sent." };
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
    message: `The network refused this step (${codespace || "chain"} ${code}). Nothing was sent.`,
  };
}
