/**
 * Opening answers on the owner's device (spec 5.9). The server hands over
 * content-blind counters and the list of sealed answers; each envelope is
 * fetched and opened here with the owner's key. Opened answers stay in memory
 * only. An answer that does not open is reported with the reason, never hidden.
 */
import { z } from "zod";
import {
  Purpose,
  fromUtf8,
  isMizuhikiError,
  openItem,
  parseFileFacts,
  sha256Hex,
  utf8,
  type FileFacts,
  type FormAnswerPayload,
} from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import type { FormStats, OpenedResponse } from "./aggregate";

export interface FailedResponse {
  hash: string;
  at: string;
  why: string;
}

export async function fetchStats(formId: string, token: string, signal?: AbortSignal): Promise<FormStats> {
  return api.get<FormStats>(`/owner/forms/${formId}/stats`, { token, signal });
}

const Answer = z.union([z.string(), z.array(z.string()), z.number(), z.boolean(), z.null()]);
const PayloadSchema = z.object({
  v: z.literal(1),
  formId: z.string(),
  formVersion: z.number(),
  answers: z.record(z.string(), Answer),
  files: z.record(z.string(), z.array(z.unknown())).default({}),
  hidden: z.record(z.string(), z.string()).default({}),
  ending: z.string().default(""),
  startedAt: z.string().default(""),
  submittedAt: z.string().default(""),
});

/** Check and normalise what a respondent's browser sealed. Throws on anything malformed. */
export function parsePayload(formId: string, json: unknown): FormAnswerPayload {
  const p = PayloadSchema.parse(json);
  if (p.formId !== formId) throw new Error("This answer belongs to another form.");
  const files: Record<string, FileFacts[]> = {};
  for (const [qid, list] of Object.entries(p.files))
    files[qid] = list.map((f) => parseFileFacts(utf8(JSON.stringify(f))));
  return { ...p, files };
}

function reason(e: unknown): string {
  if (e instanceof ApiFailure)
    return e.status === 404
      ? "Its sealed copy is no longer stored (answers are kept for a limited time)."
      : `It could not be fetched: ${e.message}`;
  if (isMizuhikiError(e, "NOT_A_READER")) return "Not sealed to your key (it may be for another reader of this form).";
  if (isMizuhikiError(e, "WRONG_CONTEXT")) return "It was sealed for a different use, or changed in storage.";
  if (isMizuhikiError(e, "TAMPERED")) return "It is damaged and could not be opened.";
  if (e instanceof Error && e.message === "hash") return "The stored copy does not match its fingerprint.";
  return "It opened, but what is inside is not a form answer Mizuhiki understands.";
}

/** Fetch and open every answer here, a few at a time, reporting progress as each one settles. */
export async function openResponses(args: {
  account: Account;
  formId: string;
  list: FormStats["responses"];
  onProgress: (done: number, total: number) => void;
  signal: AbortSignal;
}): Promise<{ opened: OpenedResponse[]; failed: FailedResponse[] }> {
  const { account, formId, list, signal } = args;
  const opened: OpenedResponse[] = [];
  const failed: FailedResponse[] = [];
  let next = 0;
  let done = 0;
  const stopped = () => signal.aborted;
  args.onProgress(0, list.length);
  const worker = async () => {
    while (next < list.length) {
      const item = list[next++];
      if (!item || signal.aborted) return;
      try {
        const env = await api.bytes(`/blobs/${item.hash}`, { signal });
        if (sha256Hex(env) !== item.hash) throw new Error("hash");
        const plain = openItem({ purpose: Purpose.form(formId), envelope: env, keys: account.keys.seal });
        opened.push({
          hash: item.hash,
          at: item.at,
          readers: item.readers,
          payload: parsePayload(formId, JSON.parse(fromUtf8(plain))),
        });
      } catch (e) {
        if (stopped()) return;
        failed.push({ hash: item.hash, at: item.at, why: reason(e) });
      }
      done++;
      args.onProgress(done, list.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, list.length) }, worker));
  return { opened, failed };
}
