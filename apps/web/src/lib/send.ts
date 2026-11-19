/**
 * Sending something sealed to a Mizuhiki account, all on this device. One path
 * for a visitor's message (spec 5.7), an owner's reply and a forward (5.8):
 * 1. resolve the recipient (ML-DSA key from the EVM precompile with proof of
 *    possession, signed card checked, KEM key must match the card);
 * 2. encrypt each new file in 4 MiB pieces and upload the pieces (ciphertext);
 * 3. seal one envelope holding the text, the optional contact line and each
 *    file's key and facts (no recipient hints). A signing sender is also a
 *    reader, so their own sent copy opens for them on any device;
 * 4. optionally sign the envelope hash with the sender's own Mizuhiki keys;
 * 5. solve the anti-spam stamp, then drop the envelope.
 * Nothing unsealed leaves the device at any step.
 */
import {
  Purpose,
  encryptFile,
  publicRecipient,
  sealItem,
  signRecord,
  solvePowAsync,
  toBase64Url,
  utf8,
  type FileFacts,
  type RecipientCard,
} from "@mizuhiki/core";
import { resolveOwner } from "@mizuhiki/chain";
import type { Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";

export interface MessagePayload {
  v: 1;
  kind: "message";
  text: string;
  /** Optional name or contact line the sender chose to include (sealed). */
  contact: string;
  files: FileFacts[];
  sentAt: string;
  /** Present only when the sender signed: their address (the signature travels beside the envelope). */
  from?: string;
  /** A reply: the envelope it answers and a short quote of it, so the thread reads on its own. */
  inReplyTo?: string;
  quote?: string;
  /** A forward: who forwarded it, and who originally sent it ("anonymous" when nobody signed). */
  forwardedBy?: string;
  originalFrom?: string;
  /** The forwarder's own short note, shown above the forwarded item. */
  forwardNote?: string;
  /** A link the item points to (an invoice, with its key in the fragment). */
  link?: string;
}

export type SendStep = "keys" | "files" | "seal" | "sign" | "stamp" | "send";
export const SEND_STEP_LABEL: Record<SendStep, string> = {
  keys: "Reading the sealing key from QoreChain",
  files: "Sealing your files in pieces",
  seal: "Sealing with ML-KEM-1024",
  sign: "Signing with your post-quantum key",
  stamp: "Passing the anti-spam check",
  send: "Uploading the sealed copy",
};

export interface SendResult {
  hash: string;
  expiresAt: string;
  readers: number;
  bytes: number;
  files: number;
  signedBy?: string;
}

export class SendFailure extends Error {
  /** "nothing" = nothing left the device; "pieces" = some sealed file pieces were uploaded (they expire within a day). */
  readonly left: "nothing" | "pieces";
  constructor(message: string, left: "nothing" | "pieces") {
    super(message);
    this.left = left;
  }
}

/** Look up a recipient's signed card. Replies and forwards go to accounts that may have no page. */
export async function cardOf(address: string): Promise<RecipientCard> {
  try {
    return (await api.get<{ card: RecipientCard }>(`/cards/${address}`)).card;
  } catch (e) {
    if (e instanceof ApiFailure && e.status === 404)
      throw new SendFailure(
        "That account has not set up sealing yet, so nothing can be sealed to it. Nothing left your device.",
        "nothing",
      );
    throw e;
  }
}

export async function sendSealed(args: {
  to: { address: string; card: RecipientCard | null };
  kind?: "message" | "reply" | "invoice";
  ref?: string | undefined;
  text: string;
  contact: string;
  /** New files picked on this device: encrypted and uploaded here. */
  files: File[];
  /** Files already sealed elsewhere (a forward): their keys are re-sealed, their pieces reused. */
  sealedFiles?: FileFacts[] | undefined;
  extra?:
    Pick<MessagePayload, "inReplyTo" | "quote" | "forwardedBy" | "originalFrom" | "forwardNote" | "link"> | undefined;
  maxFileBytes: number;
  signer?: Account | undefined;
  onStep: (s: SendStep, progress: number) => void;
  signal?: AbortSignal | undefined;
}): Promise<SendResult> {
  const { to, signal } = args;
  // An object, not a boolean: the flag is set inside upload callbacks.
  const uploaded = { pieces: false };
  const fail = (e: unknown, fallback: string): never => {
    if ((e as Error).name === "AbortError")
      throw new SendFailure(
        uploaded.pieces
          ? "Cancelled. Sealed pieces already uploaded will be deleted within a day."
          : "Cancelled. Nothing left your device.",
        uploaded.pieces ? "pieces" : "nothing",
      );
    const msg = e instanceof ApiFailure || e instanceof SendFailure ? e.message : fallback;
    throw new SendFailure(msg, uploaded.pieces ? "pieces" : "nothing");
  };
  try {
    // Old or locked-down browsers can lack Web Crypto even though the DOM types always declare it.
    if (!(globalThis.crypto as Crypto | undefined)?.subtle)
      throw new SendFailure("This browser cannot seal files (no Web Crypto). Nothing left your device.", "nothing");
    args.onStep("keys", 0.05);
    const card = to.card ?? (await cardOf(to.address));
    const recipient = await resolveOwner(to.address, card);
    signal?.throwIfAborted();

    const cfg = await api.get<{ powBits: number; chunkBytes: number; maxChunks: number }>("/drop/config");
    const total = args.files.reduce((n, f) => n + f.size, 0);
    const facts: FileFacts[] = [...(args.sealedFiles ?? [])];
    const chunks: string[] = facts.flatMap((f) => f.chunks);
    if (args.files.length > 0) {
      args.onStep("files", 0.1);
      let done = 0;
      for (const file of args.files) {
        const f = await encryptFile({
          source: file,
          name: file.name,
          type: file.type,
          maxBytes: args.maxFileBytes,
          ...(signal ? { signal } : {}),
          onChunk: async (c) => {
            await api.put("/blobs", c.bytes, { signal });
            uploaded.pieces = true;
            chunks.push(c.hash);
          },
          onProgress: (d) => args.onStep("files", 0.1 + 0.55 * ((done + d) / Math.max(1, total))),
        });
        done += file.size;
        facts.push(f);
      }
    }
    if (chunks.length > cfg.maxChunks)
      throw new SendFailure(
        "These files are too large to send at once. Send fewer at a time.",
        uploaded.pieces ? "pieces" : "nothing",
      );

    args.onStep("seal", 0.7);
    const payload: MessagePayload = {
      v: 1,
      kind: "message",
      text: args.text,
      contact: args.contact.trim(),
      files: facts,
      sentAt: new Date().toISOString(),
      ...(args.signer ? { from: args.signer.owner.address } : {}),
      ...(args.extra ?? {}),
    };
    const readers =
      args.signer && args.signer.owner.address !== to.address
        ? [recipient, publicRecipient(args.signer.keys.seal)]
        : [recipient];
    const sealed = sealItem({
      purpose: Purpose.message,
      readers,
      plaintext: utf8(JSON.stringify(payload)),
      anonymous: true,
    });

    let sender: ReturnType<typeof signRecord<{ envelope: string; to: string; at: string }>> | undefined;
    if (args.signer) {
      args.onStep("sign", 0.78);
      sender = signRecord({
        kind: "sender",
        body: { envelope: sealed.hash, to: to.address, at: new Date().toISOString() },
        signer: args.signer.owner.address,
        classical: args.signer.keys.classical,
        pq: args.signer.keys.pq,
      });
    }

    args.onStep("stamp", 0.84);
    const pow = await solvePowAsync(to.address, sealed.hash, cfg.powBits, signal);
    args.onStep("send", 0.92);
    const r = await api.post<{ hash: string; expiresAt: string; readers: number }>(
      `/drop/${to.address}`,
      {
        envelope: toBase64Url(sealed.envelope),
        kind: args.kind ?? "message",
        ...(args.ref ? { ref: args.ref } : {}),
        chunks,
        pow,
        ...(sender ? { sender } : {}),
      },
      { signal },
    );
    if (r.hash !== sealed.hash)
      throw new SendFailure(
        "The server stored something else than what was sealed. Do not trust this receipt.",
        "pieces",
      );
    return {
      hash: r.hash,
      expiresAt: r.expiresAt,
      readers: r.readers,
      bytes: sealed.envelope.length + total,
      files: facts.length,
      ...(sender ? { signedBy: sender.signer } : {}),
    };
  } catch (e) {
    return fail(e, "Not sent. Something went wrong while sealing.");
  }
}
