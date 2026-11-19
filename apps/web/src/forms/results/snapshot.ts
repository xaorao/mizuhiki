/**
 * Shareable snapshots of results (spec 5.9: "Export a snapshot. Anyone with
 * the link can read it."). The owner's browser builds the snapshot, seals it
 * to a fresh link key and to the owner, uploads the sealed copy, signs
 * {formId, envelope} with the owner's post-quantum key and asks the server to
 * keep it (PUT /owner/snapshots) until the owner deletes it. The link key's
 * seed and the form id travel only in the link's fragment (after #), which
 * browsers never send to a server, the same pattern as invoice links. So the
 * owner can copy a link again from any device, the seeds are kept in a sealed
 * owner-only self-note ("formsnaps", one per form).
 */
import { z } from "zod";
import {
  Purpose,
  fromBase64Url,
  fromUtf8,
  linkKeys,
  newLinkSeed,
  openItem,
  publicRecipient,
  sealItem,
  sha256Hex,
  signRecord,
  toBase64Url,
  utf8,
} from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { SITE_URL } from "@/lib/site";
import { SnapshotSchema, type Snapshot } from "./schema";
import { fileSelfNote, readSelfNote } from "./selfNote";

const SNAPSHOT_CONTEXT = "snapshot";
const SEEDS_CONTEXT = "snapshot-keys";

/** Snapshot hash → its link key seed (base64url), sealed to the owner. */
export type SeedMap = Record<string, string>;
const SeedMapSchema = z.record(z.string().regex(/^[0-9a-f]{64}$/), z.string().regex(/^[A-Za-z0-9_-]{43}$/));

/** One of the owner's shared snapshots, as `GET /owner/snapshots` lists it. */
export interface SnapshotRow {
  hash: string;
  formId: string;
  title: string;
  createdAt: string;
}

export function snapshotLink(hash: string, formId: string, seed: Uint8Array | string): string {
  return `${SITE_URL}/r/${hash}#k=${typeof seed === "string" ? seed : toBase64Url(seed)}&f=${formId}`;
}

export async function listSnapshots(token: string, formId: string, signal?: AbortSignal): Promise<SnapshotRow[]> {
  return (await api.get<{ snapshots: SnapshotRow[] }>(`/owner/snapshots?formId=${formId}`, { token, signal }))
    .snapshots;
}

export async function readSeeds(account: Account, token: string, formId: string): Promise<SeedMap> {
  return (
    (await readSelfNote({
      account,
      token,
      kind: "formsnaps",
      formId,
      context: SEEDS_CONTEXT,
      schema: SeedMapSchema,
    })) ?? {}
  );
}

const saveSeeds = (account: Account, formId: string, seeds: SeedMap) =>
  fileSelfNote({ account, kind: "formsnaps", formId, context: SEEDS_CONTEXT, data: seeds });

/**
 * Seal, upload, sign and keep a snapshot, then file its link key for the
 * owner's other devices. `seedsSaved` is false when only that last step failed:
 * the link works, but can be copied again only from this screen.
 */
export async function shareSnapshot(args: {
  account: Account;
  token: string;
  snap: Snapshot;
  seeds: SeedMap;
}): Promise<{ link: string; hash: string; seeds: SeedMap; seedsSaved: boolean }> {
  const { account } = args;
  const checked = SnapshotSchema.parse(args.snap);
  const seed = newLinkSeed();
  const sealed = sealItem({
    purpose: Purpose.form(checked.formId),
    readers: [publicRecipient(account.keys.seal), publicRecipient(linkKeys(seed))],
    plaintext: utf8(JSON.stringify(checked)),
    context: SNAPSHOT_CONTEXT,
    anonymous: true,
  });
  const r = await api.put<{ hash: string }>("/blobs", sealed.envelope);
  if (r.hash !== sealed.hash) throw new Error("The server stored something else than what was sealed.");
  const sig = signRecord({
    kind: "snapshot",
    body: { formId: checked.formId, envelope: sealed.hash },
    signer: account.owner.address,
    classical: account.keys.classical,
    pq: account.keys.pq,
  });
  await api.put(
    "/owner/snapshots",
    { hash: sealed.hash, formId: checked.formId, title: checked.title.slice(0, 200), sig },
    { token: args.token },
  );
  const seeds = { ...args.seeds, [sealed.hash]: toBase64Url(seed) };
  let seedsSaved = true;
  try {
    await saveSeeds(account, checked.formId, seeds);
  } catch {
    seedsSaved = false;
  }
  return { link: snapshotLink(sealed.hash, checked.formId, seed), hash: sealed.hash, seeds, seedsSaved };
}

/** Delete a snapshot (the server drops the sealed copy at its next sweep) and forget its link key. */
export async function deleteSnapshot(args: {
  account: Account;
  token: string;
  formId: string;
  hash: string;
  seeds: SeedMap;
}): Promise<SeedMap> {
  await api.del(`/owner/snapshots/${args.hash}`, { token: args.token });
  if (!(args.hash in args.seeds)) return args.seeds;
  const seeds = Object.fromEntries(Object.entries(args.seeds).filter(([h]) => h !== args.hash));
  // The snapshot is gone either way; a stale key in the note opens nothing.
  await saveSeeds(args.account, args.formId, seeds).catch(() => undefined);
  return seeds;
}

/** The key and form id from a link's fragment, or null when the link is incomplete. */
export function parseSnapshotFragment(fragment: string): { seed: Uint8Array; formId: string } | null {
  const p = new URLSearchParams(fragment.replace(/^#/, ""));
  const k = p.get("k");
  const f = p.get("f");
  if (!k || !f || !/^[A-Za-z0-9_-]{1,40}$/.test(f)) return null;
  try {
    const seed = fromBase64Url(k);
    return seed.length === 32 ? { seed, formId: f } : null;
  } catch {
    return null;
  }
}

export class SnapshotFailure extends Error {
  readonly reason: "wrong-key" | "damaged" | "unverified";
  constructor(reason: "wrong-key" | "damaged" | "unverified", message: string) {
    super(message);
    this.reason = reason;
  }
}

/** Check the copy against its address, open it with the link's key and check what is inside. */
export function openSnapshot(hash: string, envelope: Uint8Array, seed: Uint8Array, formId: string): Snapshot {
  if (sha256Hex(envelope) !== hash) throw new SnapshotFailure("damaged", "The stored copy does not match its link.");
  let plain: Uint8Array;
  try {
    plain = openItem({ purpose: Purpose.form(formId), envelope, keys: linkKeys(seed), context: SNAPSHOT_CONTEXT });
  } catch {
    throw new SnapshotFailure("wrong-key", "The key in this link does not open this snapshot.");
  }
  const damaged = new SnapshotFailure("damaged", "This snapshot opened, but what is inside is not a results snapshot.");
  let json: unknown;
  try {
    json = JSON.parse(fromUtf8(plain));
  } catch {
    throw damaged;
  }
  const parsed = SnapshotSchema.safeParse(json);
  if (!parsed.success || parsed.data.formId !== formId) throw damaged;
  return parsed.data;
}
