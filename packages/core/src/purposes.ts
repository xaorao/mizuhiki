import { MizuhikiError } from "./errors";

/** QoreSeal's purpose rule (spec qoreseal-v1, section 3). */
const PURPOSE_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const ID_RE = /^[A-Za-z0-9._-]{1,96}$/;

function scoped(kind: string, id: string): string {
  if (!ID_RE.test(id)) throw new MizuhikiError("INVALID_PURPOSE", `"${id}" is not a valid ${kind} id`);
  return check(`mzk:${kind}:${id}`);
}

export function check(p: string): string {
  if (!PURPOSE_RE.test(p)) throw new MizuhikiError("INVALID_PURPOSE", `"${p}" is not a valid purpose`);
  return p;
}

/** Every purpose Mizuhiki seals under. A purpose binds an envelope to one use. */
export const Purpose = {
  message: "mzk:msg",
  file: "mzk:file",
  payNote: "mzk:paynote",
  draft: "mzk:draft",
  /** The owner's private label for a proof anchor (file name, note). */
  proofNote: "mzk:proofnote",
  vaultExport: "mzk:export",
  form: (id: string) => scoped("form", id),
  invoice: (id: string) => scoped("inv", id),
  room: (id: string) => scoped("room", id),
  roomHistory: (id: string) => scoped("roomhist", id),
  pass: (id: string) => scoped("pass", id),
  capsule: (id: string) => scoped("capsule", id),
  capsuleShare: (id: string) => scoped("capshare", id),
  order: (id: string) => scoped("order", id),
  product: (id: string) => scoped("product", id),
  recoveryShare: (id: string) => scoped("recovery", id),
  reply: (id: string) => scoped("reply", id),
} as const;
