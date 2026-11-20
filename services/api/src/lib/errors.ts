/**
 * Is this error a QoreChain endpoint being unreachable (REST relay, EVM JSON-RPC, or the network under them)?
 * Used to answer 503 "QoreChain could not be reached" instead of a bare 500. viem wraps transport failures
 * (a ContractFunctionExecutionError whose cause is an HttpRequestError), so the whole cause chain is read.
 */
import { ChainError } from "@mizuhiki/chain";

const NETWORK_NAMES = ["HttpRequestError", "TimeoutError", "RpcRequestError", "WebSocketRequestError"];
const NETWORK_TEXT =
  /fetch failed|HTTP request failed|request timed out|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i;

export function isChainUnreachable(err: unknown): boolean {
  let e: unknown = err;
  for (let depth = 0; depth < 8 && e instanceof Error; depth++) {
    if (e instanceof ChainError) return e.code === "NETWORK";
    if (NETWORK_NAMES.includes(e.name) || NETWORK_TEXT.test(e.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}
