"use client";
/** The owner's invoices: records from the API, private copies opened on this device. */
import { useCallback, useEffect, useState } from "react";
import { encryptFile, fromBase64Url, toBase64Url, type FileFacts } from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import { sendSealed } from "@/lib/send";
import {
  dueDate,
  invoiceLink,
  money,
  numberLabel,
  openPrivate,
  sealInvoice,
  sealPrivate,
  totals,
  type InvoiceDoc,
  type InvoiceRecord,
  type PrivateCopy,
} from "./model";

export interface Loaded {
  rec: InvoiceRecord;
  copy: PrivateCopy | null;
  error?: string;
}

export function useInvoices(account: Account, token: () => Promise<string>) {
  const [items, setItems] = useState<Loaded[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await token();
      const { invoices } = await api.get<{ invoices: InvoiceRecord[] }>("/owner/invoices", { token: t });
      const loaded = await Promise.all(
        invoices.map(async (rec): Promise<Loaded> => {
          try {
            const env = await api.bytes(`/blobs/${rec.privateEnvelope}`);
            return { rec, copy: openPrivate(account, rec.id, env) };
          } catch {
            return { rec, copy: null, error: "This invoice could not be opened on this device." };
          }
        }),
      );
      setItems(loaded);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Your invoices could not be loaded. Nothing changed.");
    }
  }, [account, token]);

  useEffect(() => {
    void load();
    // Payments land on chain while the list is open: refresh every 20 s while it is visible.
    const h = setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 20_000);
    return () => clearInterval(h);
  }, [load]);

  const nextNumber = useCallback(
    () => String((items ?? []).reduce((m, i) => Math.max(m, Number(i.copy?.doc.number ?? 0)), 0) + 1),
    [items],
  );

  return { items, error, reload: load, nextNumber };
}

async function upload(bytes: Uint8Array): Promise<void> {
  await api.put("/blobs", bytes);
}

const keepOf = (doc: InvoiceDoc) => doc.attachments.flatMap((a) => a.chunks);

/** Save the draft: a private copy sealed to the owner only. */
export async function saveDraft(account: Account, token: string, copy: PrivateCopy): Promise<void> {
  const p = sealPrivate(account, copy);
  await upload(p.envelope);
  await api.put("/invoices", { id: copy.doc.id, privateEnvelope: p.hash, keep: keepOf(copy.doc) }, { token });
}

/** Seal, sign and send. Returns the payer link (key in the fragment). */
export async function sendInvoice(
  account: Account,
  token: string,
  copy: PrivateCopy,
): Promise<{ link: string; readers: number }> {
  const sealed = await sealInvoice(account, copy.doc, copy.linkSeed ? fromBase64Url(copy.linkSeed) : undefined);
  await upload(sealed.envelope);
  const nextCopy: PrivateCopy = { ...copy, linkSeed: toBase64Url(sealed.linkSeed) };
  const p = sealPrivate(account, nextCopy);
  await upload(p.envelope);
  await api.put(
    "/invoices",
    {
      id: copy.doc.id,
      privateEnvelope: p.hash,
      keep: keepOf(copy.doc),
      send: { envelope: sealed.hash, sig: sealed.sig },
    },
    { token },
  );
  return { link: invoiceLink(copy.doc.id, copy.doc.number, sealed.linkSeed), readers: sealed.readers };
}

/** Put the invoice (or a reminder) in a Mizuhiki payer's inbox, signed by the owner. */
export async function notifyPayer(account: Account, copy: PrivateCopy, reminder: boolean): Promise<void> {
  const doc = copy.doc;
  if (!doc.billTo.address || !copy.linkSeed) throw new Error("This invoice has no Mizuhiki payer to notify.");
  const due = dueDate(doc);
  const line = `${reminder ? "Reminder: " : ""}Invoice ${numberLabel(doc.number)} from ${doc.from.displayName}: ${money(totals(doc).total, doc.token)}${due ? `, due ${due.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}.`;
  await sendSealed({
    to: { address: doc.billTo.address, card: null },
    kind: "invoice",
    ref: `inv:${doc.id}`,
    text: line,
    contact: "",
    files: [],
    extra: { link: invoiceLink(doc.id, doc.number, copy.linkSeed) },
    maxFileBytes: 0,
    signer: account,
    onStep: () => undefined,
  });
}

export async function attach(file: File, onProgress: (p: number) => void): Promise<FileFacts> {
  return encryptFile({
    source: file,
    name: file.name,
    type: file.type,
    maxBytes: 25 * 1024 * 1024,
    onChunk: async (c) => {
      await api.put("/blobs", c.bytes);
    },
    onProgress: (d) => onProgress(d / Math.max(1, file.size)),
  });
}
