/**
 * Sending form answers, all on the respondent's device (spec 5.9):
 * readers are resolved from QoreChain (owner and any extra readers, each
 * card checked against the keys on chain), files and drawn signatures are
 * encrypted in pieces before upload, the answers are sealed under
 * `mzk:form:<id>`, an anti-spam stamp is solved, and the envelope is dropped.
 * Only content-blind events (view, start, reached question, submit) are counted.
 */
import {
  Purpose,
  encryptFile,
  sealItem,
  solvePowAsync,
  toBase64Url,
  utf8,
  type FileFacts,
  type FormAnswerPayload,
  type FormDef,
  type RecipientCard,
  type SealRecipient,
} from "@mizuhiki/core";
import { resolveOwner } from "@mizuhiki/chain";
import { api, ApiFailure } from "@/lib/api";
import { passRecipients } from "@/lib/passKeys";

export function formEvent(
  id: string,
  body: { kind: "view" | "start" | "reach" | "submit"; q?: string; seconds?: number },
): void {
  void api.post(`/forms/${id}/event`, body).catch(() => undefined);
}

async function recipient(address: string, card?: RecipientCard | null): Promise<SealRecipient> {
  const c = card ?? (await api.get<{ card: RecipientCard }>(`/cards/${address}`)).card;
  return resolveOwner(address, c);
}

export type SubmitStep = "keys" | "files" | "seal" | "stamp" | "send";
export const SUBMIT_LABEL: Record<SubmitStep, string> = {
  keys: "Reading the sealing keys from QoreChain",
  files: "Sealing your files",
  seal: "Sealing your answers",
  stamp: "Passing the anti-spam check",
  send: "Sending the sealed copy",
};

export class SubmitFailure extends Error {}

export async function submitAnswers(args: {
  def: FormDef;
  ownerCard: RecipientCard | null;
  payload: Omit<FormAnswerPayload, "files">;
  files: Record<string, File[]>;
  onStep: (s: SubmitStep, progress: number) => void;
}): Promise<{ hash: string }> {
  const { def } = args;
  try {
    args.onStep("keys", 0.05);
    const readers = [await recipient(def.owner, args.ownerCard)];
    for (const r of def.readers) readers.push(await recipient(r.address));
    readers.push(...(await passRecipients(def.owner, "forms")));

    const files: Record<string, FileFacts[]> = {};
    const chunks: string[] = [];
    const all = Object.entries(args.files);
    const total = all.reduce((n, [, fs]) => n + fs.reduce((m, f) => m + f.size, 0), 0);
    if (total > 0) {
      args.onStep("files", 0.1);
      let done = 0;
      for (const [qid, list] of all) {
        const q = def.blocks.find((b) => b.id === qid);
        const maxBytes = q?.kind === "file" ? q.maxMB * 1024 * 1024 : 5 * 1024 * 1024;
        files[qid] = [];
        for (const f of list) {
          const facts = await encryptFile({
            source: f,
            name: f.name,
            type: f.type,
            maxBytes,
            onChunk: async (c) => {
              await api.put("/blobs", c.bytes);
              chunks.push(c.hash);
            },
            onProgress: (d) => args.onStep("files", 0.1 + 0.55 * ((done + d) / Math.max(1, total))),
          });
          done += f.size;
          files[qid].push(facts);
        }
      }
    }

    args.onStep("seal", 0.7);
    const payload: FormAnswerPayload = { ...args.payload, files };
    const sealed = sealItem({
      purpose: Purpose.form(def.id),
      readers,
      plaintext: utf8(JSON.stringify(payload)),
      anonymous: true,
    });
    args.onStep("stamp", 0.8);
    const cfg = await api.get<{ powBits: number }>("/drop/config");
    const pow = await solvePowAsync(def.owner, sealed.hash, cfg.powBits);
    args.onStep("send", 0.92);
    const r = await api.post<{ hash: string }>(`/drop/${def.owner}`, {
      envelope: toBase64Url(sealed.envelope),
      kind: "form",
      ref: `form:${def.id}`,
      chunks,
      pow,
    });
    if (r.hash !== sealed.hash) throw new SubmitFailure("The server stored something other than what was sealed.");
    return { hash: r.hash };
  } catch (e) {
    if (e instanceof SubmitFailure) throw e;
    if (e instanceof ApiFailure) throw new SubmitFailure(e.message);
    throw new SubmitFailure("Your answers could not be sent. They are still on this device; try again.");
  }
}
