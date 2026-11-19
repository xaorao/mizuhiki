/**
 * One sealed, owner-only document per form, filed through the drop service as
 * a self-note (spec 5.9: owner metadata is encrypted too). It is sealed to the
 * owner alone under the form's purpose with a bound context, signed by the
 * owner as sender, and filed with ref "<kind>:<form id>". The newest note that
 * opens wins, so every device of the owner reads the same document. The server
 * sees only that a note exists. Used for tags ("formtags") and for the link
 * keys of shared snapshots ("formsnaps").
 */
import type { z } from "zod";
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
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";

export type SelfNoteKind = "formtags" | "formsnaps";

interface Wrapped<T> {
  v: 1;
  formId: string;
  data: T;
  at: string;
}

/** The newest document of this kind for this form that opens and checks out here, or null. */
export async function readSelfNote<T>(args: {
  account: Account;
  token: string;
  kind: SelfNoteKind;
  formId: string;
  context: string;
  schema: z.ZodType<T>;
}): Promise<T | null> {
  const { notes } = await api.get<{ notes: { hash: string; ref: string | null; at: string }[] }>(
    `/owner/notes?kind=${args.kind}`,
    { token: args.token },
  );
  const mine = notes
    .filter((n) => n.ref === `${args.kind}:${args.formId}`)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const n of mine) {
    try {
      const env = await api.bytes(`/blobs/${n.hash}`);
      const doc = JSON.parse(
        fromUtf8(
          openItem({
            purpose: Purpose.form(args.formId),
            envelope: env,
            keys: args.account.keys.seal,
            context: args.context,
          }),
        ),
      ) as Partial<Wrapped<unknown>>;
      if (doc.v !== 1 || doc.formId !== args.formId) continue;
      const parsed = args.schema.safeParse(doc.data);
      if (parsed.success) return parsed.data;
    } catch {
      // A note that does not open here is skipped; the one before it is tried.
    }
  }
  return null;
}

/** Seal and file the whole document, replacing the previous one for readers. */
export async function fileSelfNote(args: {
  account: Account;
  kind: SelfNoteKind;
  formId: string;
  context: string;
  data: unknown;
}): Promise<void> {
  const wrapped: Wrapped<unknown> = { v: 1, formId: args.formId, data: args.data, at: new Date().toISOString() };
  const sealed = sealItem({
    purpose: Purpose.form(args.formId),
    readers: [publicRecipient(args.account.keys.seal)],
    plaintext: utf8(JSON.stringify(wrapped)),
    context: args.context,
    anonymous: true,
  });
  const to = args.account.owner.address;
  const sender = signRecord({
    kind: "sender",
    body: { envelope: sealed.hash, to, at: new Date().toISOString() },
    signer: to,
    classical: args.account.keys.classical,
    pq: args.account.keys.pq,
  });
  const cfg = await api.get<{ powBits: number }>("/drop/config");
  const pow = await solvePowAsync(to, sealed.hash, cfg.powBits);
  await api.post(`/drop/${to}`, {
    envelope: toBase64Url(sealed.envelope),
    kind: args.kind,
    ref: `${args.kind}:${args.formId}`,
    chunks: [],
    pow,
    sender,
  });
}
