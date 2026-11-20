/** Chain reads the server needs to check what clients upload. Cached briefly; keys do not change often. */
import { fetchPqKeyStatus } from "@qorechain/qoresign/network";
import { fetchKemKey } from "@qorechain/qoreseal/network";
import { NETWORK, CONTRACTS, mizuhikiRegistryAbi, publicClient } from "@mizuhiki/chain";
import { parseAddress } from "@qorechain/qoresign";
import { eq } from "drizzle-orm";
import { nameProblem, normalizeNameInput } from "@mizuhiki/core";
import { names, type Db } from "@mizuhiki/db";

const cache = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < ms) return c.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

export function clearChainCache(): void {
  cache.clear();
}

export async function pqKeyOf(
  address: string,
): Promise<{ registered: boolean; publicKey?: Uint8Array; possessionProven: boolean }> {
  return cached(`pq:${address}`, 30_000, async () => {
    const s = await fetchPqKeyStatus({ rest: NETWORK.rest, address });
    return {
      registered: s.registered,
      possessionProven: s.possessionProven === true,
      ...(s.publicKey ? { publicKey: s.publicKey } : {}),
    };
  });
}

export async function kemKeyOf(address: string): Promise<{ registered: boolean; publicKey?: Uint8Array }> {
  return cached(`kem:${address}`, 30_000, async () => {
    const s = await fetchKemKey({ rest: NETWORK.rest, address });
    return { registered: s.registered, ...(s.publicKey ? { publicKey: s.publicKey } : {}) };
  });
}

/** Resolve a name straight from MizuhikiRegistry (the source of truth). */
export async function resolveName(name: string): Promise<{ owner: string | undefined; cardHash: string }> {
  return cached(`name:${name}`, 5_000, async () => {
    const [owner, cardHash] = await publicClient().readContract({
      address: CONTRACTS.registry,
      abi: mizuhikiRegistryAbi,
      functionName: "resolve",
      args: [name],
    });
    const zero = /^0x0{40}$/i.test(owner);
    return { owner: zero ? undefined : parseAddress(owner).bech32, cardHash: cardHash.slice(2) };
  });
}

/**
 * Who owns a name: the indexed copy when it has caught up, otherwise MizuhikiRegistry itself. A name claimed
 * seconds ago is on chain before the indexer has read it; pages, shops, forms and recovery must not 404 then.
 */
export async function ownerOfName(db: Db, name: string): Promise<string | undefined> {
  const n = normalizeNameInput(name);
  if (nameProblem(n)) return undefined;
  const [row] = await db.select({ address: names.address }).from(names).where(eq(names.name, n));
  return row?.address ?? (await resolveName(n)).owner;
}
