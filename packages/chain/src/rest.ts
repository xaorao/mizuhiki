import { ChainError } from "./errors";
import { chainRest } from "./config";

export type Fetch = typeof globalThis.fetch;

export interface RestOpts {
  rest?: string;
  fetch?: Fetch;
  signal?: AbortSignal;
}

const f = (o: RestOpts): Fetch => o.fetch ?? ((u, i) => globalThis.fetch(u, i));

/** GET JSON with bounded retries on network errors and 5xx (reads are safe to retry). */
export async function getJson(
  path: string,
  o: RestOpts = {},
  attempts = 3,
): Promise<{ status: number; body: unknown }> {
  const url = `${o.rest ?? chainRest()}${path}`;
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await f(o)(url, o.signal ? { signal: o.signal } : {});
      if (res.status >= 500 && i < attempts - 1) {
        last = new Error(`HTTP ${res.status}`);
      } else {
        const body: unknown = await res.json().catch(() => ({}));
        return { status: res.status, body };
      }
    } catch (e) {
      if (o.signal?.aborted) throw e;
      last = e;
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** i));
  }
  throw new ChainError("NETWORK", "Could not reach QoreChain. Check your connection and try again.", {
    detail: String(last),
  });
}

export interface AccountInfo {
  exists: boolean;
  accountNumber: bigint;
  sequence: bigint;
}

export async function accountInfo(address: string, o: RestOpts = {}): Promise<AccountInfo> {
  const { status, body: raw } = await getJson(`/cosmos/auth/v1beta1/account_info/${address}`, o);
  const body = raw as { info?: { account_number: string; sequence?: string } };
  if (status === 404 || !body.info) return { exists: false, accountNumber: 0n, sequence: 0n };
  return { exists: true, accountNumber: BigInt(body.info.account_number), sequence: BigInt(body.info.sequence ?? "0") };
}

export async function balanceOf(address: string, denom: string, o: RestOpts = {}): Promise<bigint> {
  const { body: raw } = await getJson(
    `/cosmos/bank/v1beta1/balances/${address}/by_denom?denom=${encodeURIComponent(denom)}`,
    o,
  );
  const body = raw as { balance?: { amount: string } };
  return BigInt(body.balance?.amount ?? "0");
}

export interface TxResponse {
  txhash: string;
  height: string;
  code: number;
  codespace?: string;
  raw_log?: string;
  gas_used: string;
  gas_wanted: string;
  timestamp: string;
  tx?: { body?: { memo?: string; messages?: Record<string, unknown>[] } };
  events?: { type: string; attributes: { key: string; value: string }[] }[];
}

export async function getTx(hash: string, o: RestOpts = {}): Promise<TxResponse | undefined> {
  const { status, body: raw } = await getJson(`/cosmos/tx/v1beta1/txs/${hash}`, o, 2);
  const body = raw as { tx_response?: TxResponse };
  if (status !== 200 || !body.tx_response) return undefined;
  return body.tx_response;
}

/** Poll until committed. Throws NOT_COMMITTED (outcome unknown) after the deadline. */
export async function waitForTx(hash: string, o: RestOpts & { timeoutMs?: number } = {}): Promise<TxResponse> {
  const end = Date.now() + (o.timeoutMs ?? 60_000);
  while (Date.now() < end) {
    const tx = await getTx(hash, o).catch(() => undefined);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new ChainError("NOT_COMMITTED", "The network has not confirmed this step yet. It may still go through.", {
    moved: "unknown",
    txHash: hash,
  });
}

/** Search committed transactions by events (memos are not indexed; read them from the body). */
export async function searchTxs(
  query: string,
  o: RestOpts & { page?: number; limit?: number; orderBy?: "ORDER_BY_ASC" | "ORDER_BY_DESC" } = {},
): Promise<{ txs: TxResponse[]; total: number }> {
  const q = new URLSearchParams({
    query,
    page: String(o.page ?? 1),
    limit: String(o.limit ?? 50),
    order_by: o.orderBy ?? "ORDER_BY_DESC",
  });
  const { status, body: raw } = await getJson(`/cosmos/tx/v1beta1/txs?${q.toString()}`, o);
  const body = raw as { tx_responses?: TxResponse[]; total?: string; message?: string };
  if (status !== 200)
    throw new ChainError("NETWORK", "Could not search QoreChain transactions.", {
      detail: body.message ?? String(status),
    });
  return { txs: body.tx_responses ?? [], total: Number(body.total ?? 0) };
}

export async function latestBlock(o: RestOpts = {}): Promise<{ height: bigint; time: Date }> {
  const { body: raw } = await getJson(`/cosmos/base/tendermint/v1beta1/blocks/latest`, o);
  const body = raw as { block?: { header?: { height: string; time: string } } };
  const h = body.block?.header;
  if (!h) throw new ChainError("NETWORK", "Could not read the latest block.");
  return { height: BigInt(h.height), time: new Date(h.time) };
}

export async function blockAt(height: bigint, o: RestOpts = {}): Promise<{ height: bigint; time: Date }> {
  const { body: raw } = await getJson(`/cosmos/base/tendermint/v1beta1/blocks/${height.toString()}`, o);
  const body = raw as { block?: { header?: { height: string; time: string } } };
  const h = body.block?.header;
  if (!h) throw new ChainError("NETWORK", "Could not read a block.");
  return { height: BigInt(h.height), time: new Date(h.time) };
}

/** Average block time over the last `span` blocks, in seconds. */
export async function recentBlockSeconds(o: RestOpts = {}, span = 200n): Promise<number> {
  const now = await latestBlock(o);
  const then = await blockAt(now.height - span, o);
  return (now.time.getTime() - then.time.getTime()) / 1000 / Number(span);
}
