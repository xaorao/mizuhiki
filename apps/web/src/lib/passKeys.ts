/**
 * Pass keys a sender also seals to (spec 5.12, ARCHITECTURE 8c). They come only
 * from the recipient's own signed page, checked here against their key on
 * QoreChain, so the server cannot add a reader. Anything that fails returns no
 * extra readers: the owner's device catches those items up with "Bring up to date".
 */
import { passReaders, verifyRecord, type Manifest, type PeriodKind, type Signed } from "@mizuhiki/core";
import { pqKeyViaEvm } from "@mizuhiki/chain";
import type { SealRecipient } from "@qorechain/qoreseal";
import { api } from "@/lib/api";

const cache = new Map<string, { at: number; m: Promise<Manifest | null> }>();
const TTL = 60_000;

async function signedManifest(address: string): Promise<Manifest | null> {
  const { name } = await api.get<{ name: string | null }>(`/names/of/${address}`);
  if (!name) return null;
  const r = await api.get<{ record: Signed<Manifest> }>(`/pages/${encodeURIComponent(name)}`);
  if (r.record.signer !== address || r.record.body.address !== address) return null;
  const pq = await pqKeyViaEvm(address);
  if (!pq.registered || !pq.publicKey || !pq.possessionProven) return null;
  return verifyRecord(r.record, { kind: "manifest", signer: address, pqPublicKey: pq.publicKey });
}

export async function passRecipients(
  address: string,
  kind: PeriodKind,
  at: Date = new Date(),
): Promise<SealRecipient[]> {
  let hit = cache.get(address);
  if (!hit || Date.now() - hit.at > TTL) {
    hit = { at: Date.now(), m: signedManifest(address).catch(() => null) };
    cache.set(address, hit);
  }
  const m = await hit.m;
  return m ? passReaders(m, kind, at) : [];
}

/** After the owner changes their passes, their own next seal must see the new list. */
export function forgetPassKeys(address: string): void {
  cache.delete(address);
}
