/**
 * Prove a document existed (spec 5.15), on this device:
 * hash it here (SHA-256, streamed), anchor the hash on QoreChain with the
 * owner's ML-DSA authorisation, then file a private label (file name, size,
 * note) sealed to the owner alone so the proof list reads well on any device.
 * The chain holds only the hash; the label never leaves sealed.
 */
import {
  Purpose,
  fromUtf8,
  openItem,
  publicRecipient,
  sealItem,
  signRecord,
  solvePowAsync,
  toBase64Url,
  utf8,
} from "@mizuhiki/core";
import { anchorDocument, anchorTx, readAnchors, type AnchorKind, type AnchorRecord } from "@mizuhiki/chain";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";

export interface ProofLabel {
  v: 1;
  hash: string;
  name: string;
  size: number;
  type: string;
  note: string;
  kind: AnchorKind;
}

export type ProveStep = "hash" | "window" | "sign" | "send" | "label";
export const PROVE_STEP_LABEL: Record<ProveStep, string> = {
  hash: "Hashing the file on this device",
  window: "Opening a signing window on QoreChain",
  sign: "Signing with your post-quantum key",
  send: "Writing the anchor on QoreChain",
  label: "Sealing your private label",
};

export const certificatePath = (hash: string): string => `/proof/${hash}`;

/** File the private label, sealed to the owner only, through the drop service. */
async function fileLabel(account: Account, label: ProofLabel): Promise<void> {
  const sealed = sealItem({
    purpose: Purpose.proofNote,
    readers: [publicRecipient(account.keys.seal)],
    plaintext: utf8(JSON.stringify(label)),
    anonymous: true,
  });
  const to = account.owner.address;
  const sender = signRecord({
    kind: "sender",
    body: { envelope: sealed.hash, to, at: new Date().toISOString() },
    signer: to,
    classical: account.keys.classical,
    pq: account.keys.pq,
  });
  const cfg = await api.get<{ powBits: number }>("/drop/config");
  const pow = await solvePowAsync(to, sealed.hash, cfg.powBits);
  await api.post(`/drop/${to}`, {
    envelope: toBase64Url(sealed.envelope),
    kind: "proof",
    ref: `proof:${label.hash.slice(0, 64)}`,
    chunks: [],
    pow,
    sender,
  });
}

export async function prove(args: {
  account: Account;
  hash: string;
  kind: AnchorKind;
  file: { name: string; size: number; type: string };
  note: string;
  onStep: (s: ProveStep) => void;
}): Promise<{ record: AnchorRecord; txHash: string | null; fresh: boolean; othersEarlier: number }> {
  const r = await anchorDocument(args.account.owner, args.hash, args.kind, (s) => args.onStep(s));
  if (r.fresh) {
    args.onStep("label");
    await fileLabel(args.account, {
      v: 1,
      hash: args.hash,
      name: args.file.name,
      size: args.file.size,
      type: args.file.type,
      note: args.note.trim(),
      kind: args.kind,
    });
  }
  // Other accounts may hold the same fingerprint (each keeps its own record); say so if one came first.
  const all = await readAnchors(args.hash);
  const othersEarlier = all.filter(
    (a) => a.by.toLowerCase() !== r.record.by.toLowerCase() && a.blockNumber < r.record.blockNumber,
  ).length;
  return { ...r, othersEarlier };
}

/** The owner's private labels, opened here. Labels that fail to open are skipped. */
export async function readLabels(account: Account, token: string): Promise<Record<string, ProofLabel>> {
  const { notes } = await api.get<{ notes: { hash: string; ref: string | null }[] }>("/owner/notes?kind=proof", {
    token,
  });
  const out: Record<string, ProofLabel> = {};
  await Promise.all(
    notes.map(async (n) => {
      try {
        const env = await api.bytes(`/blobs/${n.hash}`);
        const l = JSON.parse(
          fromUtf8(openItem({ purpose: Purpose.proofNote, envelope: env, keys: account.keys.seal })),
        ) as ProofLabel;
        if (!(l.hash in out)) out[l.hash] = l;
      } catch {
        // A label that cannot be opened here is shown as unlabelled; the anchor itself stays valid.
      }
    }),
  );
  return out;
}

export { anchorTx, readAnchors };
