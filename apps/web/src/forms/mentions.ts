/**
 * Mentions in the builder. Stored as `{{questionId}}` (stable when questions
 * move); shown to the owner as `@Q3` (the question's number) so they can type
 * them by hand. Only questions before the current block can be mentioned.
 */
import { isQuestion, type FormBlock } from "@mizuhiki/core";

export function questionNumbers(blocks: FormBlock[]): Map<string, number> {
  const m = new Map<string, number>();
  let n = 0;
  for (const b of blocks) if (isQuestion(b)) m.set(b.id, ++n);
  return m;
}

export function toDisplay(text: string, blocks: FormBlock[]): string {
  const nums = questionNumbers(blocks);
  return text.replace(/\{\{([A-Za-z0-9_-]{1,40})\}\}/g, (all, id: string) => {
    const n = nums.get(id);
    return n ? `@Q${n}` : all;
  });
}

/** `@Q2` back to `{{id}}`, only for questions before `beforeIndex` in the block list. */
export function fromDisplay(text: string, blocks: FormBlock[], beforeIndex: number): string {
  const earlier = blocks.slice(0, beforeIndex).filter(isQuestion);
  const nums = questionNumbers(blocks);
  return text.replace(/@Q(\d{1,3})\b/g, (all, n: string) => {
    const q = earlier.find((b) => nums.get(b.id) === Number(n));
    return q ? `{{${q.id}}}` : all;
  });
}

/** Earlier questions the owner may mention from block `index`. */
export function mentionable(blocks: FormBlock[], index: number): { tag: string; title: string }[] {
  const nums = questionNumbers(blocks);
  return blocks
    .slice(0, index)
    .filter(isQuestion)
    .map((q) => ({ tag: `@Q${nums.get(q.id) ?? 0}`, title: q.title || "Untitled question" }));
}
