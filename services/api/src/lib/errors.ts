/**
 * Is this error a QoreChain endpoint being unreachable (REST relay, EVM JSON-RPC, or the network under them)?
 * Used to answer 503 "QoreChain could not be reached" instead of a bare 500.
 */
import { ChainError } from "@mizuhiki/chain";

export function isChainUnreachable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err instanceof ChainError) return err.code === "NETWORK";
  if (["HttpRequestError", "TimeoutError", "RpcRequestError"].includes(err.name)) return true;
  const cause = (err as { cause?: unknown }).cause;
  const text = `${err.message} ${cause instanceof Error ? cause.message : ""}`;
  return /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(text);
}
