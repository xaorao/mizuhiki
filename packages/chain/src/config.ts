/** QoreChain testnet facts (build-on-qorechain skill; get_chain_info on testnet). */
export const NETWORK = {
  chainId: "qorechain-diana",
  evmChainId: 9800,
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
  evmRpc: "https://evm-testnet.qore.host",
  explorer: "https://explore.qore.network",
  faucet: "https://dashboard.qorechain.io/faucet",
  /** Minimum gas price on the native lane, uqor per gas. */
  minGasPrice: 0.1,
} as const;

/**
 * Where native-lane REST calls go. Node uses the public endpoint. Browsers
 * cannot (the testnet REST and RPC endpoints send no CORS headers, checked
 * 2026-11-18), so the web app points this at the API's allowlisted relay.
 * The EVM JSON-RPC allows browsers and is always called directly.
 */
let restBase: string = NETWORK.rest;
export function configureChain(o: { rest?: string }): void {
  if (o.rest) restBase = o.rest.replace(/\/+$/, "");
}
export const chainRest = (): string => restBase;

export interface Denom {
  denom: string;
  symbol: string;
  decimals: number;
  label: string;
}

/** Tokens a page accepts. fUSD is a bank coin with an `erc20:` denom (case-sensitive). */
export const DENOMS: Record<"QOR" | "fUSD", Denom> = {
  QOR: { denom: "uqor", symbol: "QOR", decimals: 6, label: "test QOR" },
  fUSD: {
    denom: "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA",
    symbol: "fUSD",
    decimals: 6,
    label: "test dollars (fUSD)",
  },
};

export function denomBySymbol(symbol: string): Denom | undefined {
  return symbol === "QOR" ? DENOMS.QOR : symbol === "fUSD" ? DENOMS.fUSD : undefined;
}
export function denomByBase(base: string): Denom | undefined {
  return Object.values(DENOMS).find((d) => d.denom === base);
}

export const explorerTx = (hash: string): string => `${NETWORK.explorer}/tx/${hash}`;
export const explorerAddress = (addr: string): string => `${NETWORK.explorer}/address/${addr}`;

/** "12.5" -> 12500000n for 6 decimals. Refuses more decimals than the token has. */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const s = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("not an amount");
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export function fromBaseUnits(units: bigint | string, decimals: number): string {
  const v = typeof units === "string" ? BigInt(units) : units;
  const neg = v < 0n;
  const a = neg ? -v : v;
  const d = 10n ** BigInt(decimals);
  const whole = a / d;
  const frac = (a % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? `.${frac}` : ""}`;
}
