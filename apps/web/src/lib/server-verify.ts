/**
 * The same check visitors' browsers make, done on the web server before a record's words go into a page title or
 * a link preview: the name's owner is read from MizuhikiRegistry and the record's ML-DSA-87 signature is checked
 * against that owner's key on QoreChain. A record changed after signing (in the database, say) never reaches a
 * title, a tab or a chat preview; the page says it could not be verified instead.
 */
import "server-only";
import { ownerOfName, pqKeyViaEvm } from "@mizuhiki/chain";
import { verifyRecord, type Signed, type SignedKind } from "@mizuhiki/core";

const TTL = 60_000;
const owners = new Map<string, { at: number; v: Promise<string | null> }>();
const keys = new Map<string, { at: number; v: Promise<Uint8Array | null> }>();

function cached<T>(m: Map<string, { at: number; v: Promise<T> }>, key: string, load: () => Promise<T>): Promise<T> {
  const hit = m.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  const v = load().catch((e: unknown) => {
    m.delete(key);
    throw e;
  });
  m.set(key, { at: Date.now(), v });
  return v;
}

/**
 * The verified body of `record` (kind as signed), if `name` belongs on QoreChain to the record's signer and the
 * signature checks; otherwise null. Chain unreachable also gives null: a title is never shown on trust.
 */
export async function verifiedFor<T>(name: string, record: Signed<T>, kind: SignedKind): Promise<T | null> {
  try {
    const owner = await cached(owners, name, () => ownerOfName(name));
    if (!owner || owner !== record.signer) return null;
    const pub = await cached(keys, owner, async () => {
      const pq = await pqKeyViaEvm(owner);
      return pq.registered && pq.possessionProven && pq.publicKey ? pq.publicKey : null;
    });
    if (!pub) return null;
    return verifyRecord<T>(record, { kind, signer: owner, pqPublicKey: pub });
  } catch {
    return null;
  }
}
