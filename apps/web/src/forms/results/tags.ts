/**
 * Tags on form answers (spec 5.9: "tags are encrypted too"): one sealed
 * owner-only document per form, {answer hash: tags}, filed as a "formtags"
 * self-note with the bound context "tags" (see selfNote.ts).
 */
import { z } from "zod";
import type { Account } from "@/account/AccountProvider";
import { fileSelfNote, readSelfNote } from "./selfNote";

export type TagMap = Record<string, string[]>;

const TAGS_CONTEXT = "tags";
export const MAX_TAG = 40;
const TagMapSchema = z.record(z.string().regex(/^[0-9a-f]{64}$/), z.array(z.string().min(1).max(MAX_TAG)).max(30));

/** Tidy one tag: single spaces, trimmed, at most 40 characters. */
export const tidyTag = (t: string): string => t.replace(/\s+/g, " ").trim().slice(0, MAX_TAG);

/** The newest tags document for this form that opens here, or none. */
export async function readTags(account: Account, token: string, formId: string): Promise<TagMap> {
  return (
    (await readSelfNote({ account, token, kind: "formtags", formId, context: TAGS_CONTEXT, schema: TagMapSchema })) ??
    {}
  );
}

/** Seal and file the whole tags document. Empty tag lists are dropped. */
export async function saveTags(account: Account, formId: string, tags: TagMap): Promise<void> {
  const clean: TagMap = {};
  for (const [hash, list] of Object.entries(tags)) {
    const l = [...new Set(list.map(tidyTag).filter(Boolean))];
    if (l.length) clean[hash] = l;
  }
  await fileSelfNote({ account, kind: "formtags", formId, context: TAGS_CONTEXT, data: clean });
}
