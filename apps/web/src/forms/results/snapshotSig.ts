/**
 * Who shared a snapshot, checked in the viewer's browser: the owner signs
 * {formId, envelope} with their post-quantum key (kind "snapshot"); the viewer
 * reads that account's ML-DSA key from QoreChain and checks the signature,
 * that it names this sealed copy, and that it names the form in the link.
 * Pure: the caller reads the key from the chain and passes it in.
 */
import { z } from "zod";
import { verifyRecord, type Signed } from "@mizuhiki/core";

const HASH = /^[0-9a-f]{64}$/;

/** What `GET /snapshots/:hash` returns: signed metadata, never content. */
export const SnapshotMetaSchema = z.object({
  owner: z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/),
  ownerName: z.string().max(64).nullable(),
  formId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  title: z.string().max(200),
  sig: z.object({
    kind: z.literal("snapshot"),
    signer: z.string(),
    body: z.object({ formId: z.string(), envelope: z.string().regex(HASH) }),
    signature: z.unknown(),
  }),
  createdAt: z.string().max(40),
});
export type SnapshotMeta = z.infer<typeof SnapshotMetaSchema>;

export interface ChainKey {
  registered: boolean;
  publicKey?: Uint8Array | undefined;
  possessionProven: boolean;
}

/** True only when every check holds; never throws. */
export function snapshotSignedBy(args: { meta: SnapshotMeta; hash: string; formId: string; key: ChainKey }): boolean {
  const { meta, hash, formId, key } = args;
  if (!key.registered || !key.possessionProven || !key.publicKey) return false;
  if (meta.sig.signer !== meta.owner || meta.formId !== formId) return false;
  try {
    const body = verifyRecord(meta.sig as unknown as Signed<{ formId: string; envelope: string }>, {
      kind: "snapshot",
      signer: meta.owner,
      pqPublicKey: key.publicKey,
    });
    return body.envelope === hash && body.formId === formId;
  } catch {
    return false;
  }
}
