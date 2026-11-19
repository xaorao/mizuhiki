/**
 * The editor's working copy. The draft is sealed to the owner's own key before
 * it is stored (purpose mzk:draft), so the server keeps only ciphertext of
 * unpublished changes. Publishing signs the public part as a manifest.
 */
import {
  Purpose,
  canonicalJson,
  openItem,
  parseManifest,
  sealItem,
  utf8,
  fromUtf8,
  type Block,
  type Manifest,
} from "@mizuhiki/core";
import { recipientOf } from "@qorechain/qoreseal";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";

export type PendingKind = "form" | "shop" | "room" | "pass" | "invoiceRequest" | "fileRequest";

export interface PendingBlock {
  key: string;
  kind: PendingKind;
  title: string;
}

export type ChecklistItem = "profile" | "spareKey" | "block" | "design" | "share" | "firstItem";
export const CHECKLIST: { id: ChecklistItem; title: string }[] = [
  { id: "profile", title: "Add your name and photo" },
  { id: "spareKey", title: "Create your spare-key sheet" },
  { id: "block", title: "Add a block" },
  { id: "design", title: "Customize your design" },
  { id: "share", title: "Share your page" },
  { id: "firstItem", title: "Receive your first sealed item" },
];

export interface Draft {
  v: 1;
  manifest: Manifest;
  pending: PendingBlock[];
  /** Ids of blocks the owner archived (kept in manifest.blocks with archived: true). */
  checklist: { done: ChecklistItem[]; skipped: ChecklistItem[] };
  savedAt: string;
}

export function draftFromManifest(m: Manifest, pending: PendingBlock[] = []): Draft {
  return { v: 1, manifest: m, pending, checklist: { done: [], skipped: [] }, savedAt: new Date().toISOString() };
}

export async function saveDraft(account: Account, token: string, d: Draft): Promise<void> {
  const sealed = sealItem({
    purpose: Purpose.draft,
    readers: [recipientOf(account.keys.seal)],
    plaintext: utf8(JSON.stringify(d)),
  });
  const { hash } = await api.put<{ hash: string }>("/blobs", sealed.envelope);
  await api.put("/drafts", { blobHash: hash }, { token });
}

export async function loadDraft(account: Account, token: string): Promise<Draft | null> {
  const { blobHash } = await api.get<{ blobHash: string | null }>("/drafts", { token });
  if (!blobHash) return null;
  const bytes = await api.bytes(`/blobs/${blobHash}`).catch(() => null);
  if (!bytes) return null;
  // The draft was sealed by this owner; it may hold blocks that are not finished yet,
  // so it is not held to the published-manifest schema (publishing is).
  const raw: unknown = JSON.parse(
    fromUtf8(openItem({ purpose: Purpose.draft, envelope: bytes, keys: account.keys.seal })),
  );
  const d = raw as Partial<Draft> | null;
  if (d?.v !== 1 || !d.manifest || !Array.isArray(d.manifest.blocks) || !Array.isArray(d.pending) || !d.checklist)
    return null;
  return d as Draft;
}

export function visibleBlocks(m: Manifest): Block[] {
  return m.blocks.filter((b) => !b.archived);
}

/** Has the draft changed anything that would be published? */
export function differsFromPublished(
  d: Draft,
  published: Manifest | null,
  isProblem: (b: Block) => string | undefined,
): boolean {
  if (!published) return true;
  // Compare what Publish would send with what is live, in canonical form, so key
  // order and schema defaults never make an unchanged page look changed.
  const norm = (m: Manifest) => canonicalJson({ ...m, version: 0, updatedAt: "" });
  try {
    return norm(publishable(d.manifest, isProblem)) !== norm(parseManifest(published));
  } catch {
    return true;
  }
}

/** The public part of a draft: unfinished blocks stay in the draft and are left out. */
export function publishable(m: Manifest, isProblem: (b: Block) => string | undefined): Manifest {
  return parseManifest({ ...m, blocks: m.blocks.filter((b) => !isProblem(b)) });
}
