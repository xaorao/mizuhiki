/**
 * Mizuhiki payment memos: `mzk:<kind>:<ref>[:<noteHash>]`, at most 256 bytes.
 * kind: pay (Pay me), inv (invoice), ord (shop order). The note hash is the
 * SHA-256 of the sealed note envelope dropped to the owner.
 */
export type PayKind = "pay" | "inv" | "ord";
export interface ParsedMemo {
  kind: PayKind;
  ref: string;
  noteHash?: string;
}

const RE = /^mzk:(pay|inv|ord):([A-Za-z0-9_-]{1,64})(?::([0-9a-f]{64}))?$/;

export function parseMemo(memo: string): ParsedMemo | undefined {
  const m = RE.exec(memo.trim());
  if (!m) return undefined;
  const [, kind, ref, note] = m;
  if (!kind || !ref) return undefined;
  return { kind: kind as PayKind, ref, ...(note ? { noteHash: note } : {}) };
}

export function buildMemo(kind: PayKind, ref: string, noteHash?: string): string {
  const memo = `mzk:${kind}:${ref}${noteHash ? `:${noteHash}` : ""}`;
  if (!RE.test(memo)) throw new Error("bad memo parts");
  return memo;
}
