"use client";
/**
 * New or draft invoice (spec 5.6). PayPal's editor: number in the title, Send
 * always at the top right, bill to, line items with per-line totals and a
 * totals rail, due presets, Message to customer vs Memo to self, attachments,
 * Preview. Drafts autosave sealed to the owner only.
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Chip, Icon, IconButton, LockLine, Oops, Segmented, TextArea, TextField, useToast } from "@mizuhiki/ui";
import { normalizeNameInput } from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { fmtBytes } from "@/public/MessageSheet";
import {
  DUE_LABEL,
  DUE_PRESETS,
  blankDoc,
  money,
  numberLabel,
  sendProblems,
  totals,
  type DuePreset,
  type InvoiceDoc,
  type Item,
  type PrivateCopy,
} from "./model";
import { attach, saveDraft, sendInvoice } from "./useInvoices";
import { InvoiceView } from "./InvoiceView";
import { ShareSheet } from "./ShareSheet";
import s from "./invoices.module.css";
import { ownerOfName } from "@mizuhiki/chain";
import { failureText } from "@/lib/failure";

type Save = "idle" | "saving" | "saved" | "error";

export function InvoiceEditor({
  account,
  token,
  owner,
  initial,
  nextNumber,
}: {
  account: Account;
  token: () => Promise<string>;
  owner: { name: string | null; displayName: string };
  initial: PrivateCopy | null;
  nextNumber: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [copy, setCopy] = useState<PrivateCopy>(
    () => initial ?? { v: 1, doc: blankDoc(account, owner, nextNumber), memo: "" },
  );
  const [save, setSave] = useState<Save>("idle");
  const [preview, setPreview] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const [shared, setShared] = useState<{ link: string; readers: number } | null>(null);
  const [nameInput, setNameInput] = useState(initial?.doc.billTo.name ?? "");
  const [nameState, setNameState] = useState<{ state: "idle" | "checking" | "ok" | "bad"; message?: string }>({
    state: initial?.doc.billTo.address ? "ok" : "idle",
  });
  const [uploading, setUploading] = useState<number | null>(null);
  const dirty = useRef(false);
  const doc = copy.doc;
  const t = totals(doc);

  const set = (patch: Partial<InvoiceDoc>) => {
    dirty.current = true;
    setProblems([]);
    setCopy((c) => ({ ...c, doc: { ...c.doc, ...patch } }));
  };
  /** Merge into the latest "bill to" (a lookup can finish after the person typed more). */
  const setBillTo = (patch: Partial<InvoiceDoc["billTo"]>) => {
    dirty.current = true;
    setProblems([]);
    setCopy((c) => ({ ...c, doc: { ...c.doc, billTo: { ...c.doc.billTo, ...patch } } }));
  };
  const setItem = (id: string, patch: Partial<Item>) =>
    set({ items: doc.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) });

  // Autosave the sealed draft a moment after the last change.
  const persist = useCallback(async () => {
    if (!dirty.current) return;
    dirty.current = false;
    setSave("saving");
    try {
      await saveDraft(account, await token(), copy);
      setSave("saved");
      if (!window.location.pathname.endsWith(copy.doc.id))
        window.history.replaceState(window.history.state, "", `/app/invoices/${copy.doc.id}`);
    } catch {
      dirty.current = true;
      setSave("error");
    }
  }, [account, copy, token]);
  useEffect(() => {
    const h = setTimeout(() => void persist(), 900);
    return () => clearTimeout(h);
  }, [persist]);

  // Only the newest lookup may write: an older, slower answer for a name the person already changed is dropped.
  const lookup = useRef(0);
  const checkName = async (raw: string) => {
    const name = normalizeNameInput(raw);
    const mine = ++lookup.current;
    if (!name) {
      setNameState({ state: "idle" });
      setBillTo({ name: "", address: "" });
      return;
    }
    setNameState({ state: "checking" });
    try {
      // The owner of a name is read from QoreChain, not taken from our server.
      const r = { owner: await ownerOfName(name) };
      if (mine !== lookup.current) return;
      if (!r.owner) {
        setNameState({ state: "bad", message: `Nobody has @${name} yet. Send it as a link instead.` });
        setBillTo({ name, address: "" });
      } else if (r.owner === account.owner.address) {
        setNameState({ state: "bad", message: "That is you." });
        setBillTo({ name, address: "" });
      } else {
        setNameState({ state: "ok", message: `@${name} is on Mizuhiki. The invoice is sealed to their key too.` });
        setBillTo({ name, address: r.owner });
      }
    } catch {
      if (mine === lookup.current) setNameState({ state: "bad", message: "That name could not be checked right now." });
    }
  };

  // Send pressed while the @name is still being looked up: wait for the answer, then send the invoice as it is
  // then. Sending at once would fail on an empty payer and the lookup's update would wipe that message.
  const [sendQueued, setSendQueued] = useState(false);
  const onSend = async () => {
    if (nameState.state === "checking") {
      setSendQueued(true);
      return;
    }
    const p = sendProblems(doc);
    setProblems(p);
    if (p.length) return;
    setSending(true);
    try {
      const r = await sendInvoice(account, await token(), copy);
      setShared(r);
      dirty.current = false;
    } catch (e) {
      setProblems([failureText(e, "The invoice could not be sent. Nothing was shared.")]);
    } finally {
      setSending(false);
    }
  };

  // Runs the latest onSend (with the invoice as it is now) once the lookup has settled.
  const sendNow = useEffectEvent(() => void onSend());
  useEffect(() => {
    if (!sendQueued || nameState.state === "checking") return;
    setSendQueued(false);
    sendNow();
  }, [sendQueued, nameState.state]);

  const addFiles = async (files: FileList) => {
    for (const f of Array.from(files)) {
      if (doc.attachments.length >= 5) {
        toast.show("Up to five attachments.", { tone: "error" });
        break;
      }
      if (f.size > 25 * 1024 * 1024) {
        toast.show(`“${f.name}” is larger than 25 MB.`, { tone: "error" });
        continue;
      }
      setUploading(0);
      try {
        const facts = await attach(f, setUploading);
        dirty.current = true;
        setCopy((c) => ({ ...c, doc: { ...c.doc, attachments: [...c.doc.attachments, facts] } }));
      } catch {
        toast.show(`“${f.name}” could not be sealed. Nothing was attached.`, { tone: "error" });
      } finally {
        setUploading(null);
      }
    }
  };

  return (
    <div className={s.editor}>
      <header className={s.edTop}>
        <IconButton icon="back" label="Back to invoices" onClick={() => router.push("/app/invoices")} />
        <h1>Invoice {numberLabel(doc.number)}</h1>
        <span className={s.saveState} aria-live="polite">
          {save === "saving"
            ? "Saving sealed draft…"
            : save === "saved"
              ? "Draft saved, sealed"
              : save === "error"
                ? "Not saved. Retrying…"
                : ""}
        </span>
        <div className={s.edActions}>
          <Button variant="line" icon="eye" onClick={() => setPreview((p) => !p)} aria-pressed={preview}>
            {preview ? "Edit" : "Preview"}
          </Button>
          <Button variant="cord" icon="send" busy={sending || sendQueued} onClick={() => void onSend()}>
            Send
          </Button>
        </div>
      </header>
      {problems.length ? (
        <Oops title="Not sent yet">
          <ul className={s.problemList}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Oops>
      ) : null}

      {preview ? (
        <div className={s.previewWrap}>
          <InvoiceView doc={doc} status="due" />
        </div>
      ) : (
        <div className={s.edGrid}>
          <div className={s.edMain}>
            <section className={s.card}>
              <h2>Bill to</h2>
              <Segmented<InvoiceDoc["billTo"]["kind"]>
                label="Bill to"
                stackOnPhone
                value={doc.billTo.kind}
                onChange={(kind) => setBillTo({ kind, ...(kind === "link" ? { address: "", name: "" } : {}) })}
                options={[
                  { value: "name", label: "A Mizuhiki @name" },
                  { value: "address", label: "An address" },
                  { value: "link", label: "Anyone with the link" },
                ]}
              />
              {doc.billTo.kind === "name" ? (
                <TextField
                  label="Their @name"
                  prefix="@"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onBlur={() => void checkName(nameInput)}
                  error={nameState.state === "bad" ? nameState.message : undefined}
                  ok={nameState.state === "ok" ? nameState.message : undefined}
                  hint={nameState.state === "checking" ? "Checking…" : "We look them up when you leave this field."}
                />
              ) : null}
              {doc.billTo.kind === "address" ? (
                <TextField
                  label="Their QoreChain address"
                  value={doc.billTo.address}
                  spellCheck={false}
                  onChange={(e) => setBillTo({ address: e.target.value.trim() })}
                  placeholder="qor1…"
                />
              ) : null}
              {doc.billTo.kind === "link" ? (
                <TextField
                  label="Who it is for (optional, shown on the invoice)"
                  value={doc.billTo.label}
                  maxLength={120}
                  onChange={(e) => setBillTo({ label: e.target.value })}
                />
              ) : null}
              <TextField
                label="Their business name (optional)"
                value={doc.billTo.business}
                maxLength={120}
                onChange={(e) => setBillTo({ business: e.target.value })}
              />
              <TextField
                label="Your business name (optional)"
                value={doc.from.business}
                maxLength={120}
                onChange={(e) => set({ from: { ...doc.from, business: e.target.value } })}
              />
            </section>

            <section className={s.card}>
              <h2>Items</h2>
              <ol className={s.lines}>
                {doc.items.map((it, i) => (
                  <li key={it.id} className={s.line}>
                    <div className={s.lineRow}>
                      <TextField
                        label={`Item ${i + 1} name`}
                        value={it.name}
                        maxLength={120}
                        onChange={(e) => setItem(it.id, { name: e.target.value })}
                      />
                      <TextField
                        label="Qty"
                        inputMode="decimal"
                        value={it.qty}
                        onChange={(e) =>
                          /^\d{0,7}(\.\d{0,2})?$/.test(e.target.value) && setItem(it.id, { qty: e.target.value })
                        }
                      />
                      <TextField
                        label={`Price (${doc.token})`}
                        inputMode="decimal"
                        value={it.price}
                        onChange={(e) =>
                          /^\d{0,12}(\.\d{0,6})?$/.test(e.target.value) && setItem(it.id, { price: e.target.value })
                        }
                      />
                      <IconButton
                        icon="trash"
                        label={`Remove item ${i + 1}`}
                        onClick={() => set({ items: doc.items.filter((x) => x.id !== it.id) })}
                        disabled={doc.items.length === 1}
                      />
                    </div>
                    <TextArea
                      label="Description (optional)"
                      value={it.description}
                      maxLength={1000}
                      counter
                      onChange={(e) => setItem(it.id, { description: e.target.value })}
                    />
                    <p className={s.lineAmount}>Amount: {money(t.lines[i] ?? 0n, doc.token)}</p>
                  </li>
                ))}
              </ol>
              <Button
                variant="line"
                icon="plus"
                onClick={() =>
                  set({
                    items: [...doc.items, { id: crypto.randomUUID(), name: "", qty: "1", price: "", description: "" }],
                  })
                }
                disabled={doc.items.length >= 50}
              >
                Add item
              </Button>
            </section>

            <section className={s.card}>
              <h2>Notes</h2>
              <TextArea
                label="Message to customer"
                value={doc.message}
                maxLength={2000}
                counter
                onChange={(e) => set({ message: e.target.value })}
              />
              <LockLine>Sealed to you and whoever can open the invoice.</LockLine>
              <TextArea
                label="Memo to self"
                value={copy.memo}
                maxLength={2000}
                counter
                onChange={(e) => {
                  dirty.current = true;
                  setCopy((c) => ({ ...c, memo: e.target.value }));
                }}
              />
              <LockLine>Sealed to you only. Never on the invoice.</LockLine>
            </section>

            <section className={s.card}>
              <h2>Attachments</h2>
              {doc.attachments.length ? (
                <ul className={s.attachments}>
                  {doc.attachments.map((f) => (
                    <li key={f.fileId} className={s.attach}>
                      <Icon name="file" size={18} />
                      <span>
                        <b>{f.name}</b>
                        <small>{fmtBytes(f.size)} · sealed</small>
                      </span>
                      <IconButton
                        icon="x"
                        label={`Remove ${f.name}`}
                        onClick={() => set({ attachments: doc.attachments.filter((x) => x.fileId !== f.fileId) })}
                      />
                    </li>
                  ))}
                </ul>
              ) : null}
              <label className={s.attachDrop}>
                <Icon name="upload" size={18} />
                {uploading !== null
                  ? `Sealing ${Math.round(uploading * 100)}%…`
                  : "Add files · up to 5, 25 MB each, sealed on this device"}
                <input
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => e.target.files && void addFiles(e.target.files)}
                  disabled={uploading !== null}
                />
              </label>
            </section>
          </div>

          <aside className={s.rail}>
            <section className={s.card}>
              <h2>Payment</h2>
              <Segmented<"fUSD" | "QOR">
                label="Token"
                value={doc.token}
                onChange={(token) => set({ token })}
                options={[
                  { value: "fUSD", label: "fUSD" },
                  { value: "QOR", label: "QOR" },
                ]}
              />
              <label className={s.selectField}>
                <span>Due</span>
                <select
                  value={doc.due.preset}
                  onChange={(e) => set({ due: { ...doc.due, preset: e.target.value as DuePreset } })}
                >
                  {DUE_PRESETS.map((p) => (
                    <option key={p} value={p}>
                      {DUE_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
              {doc.due.preset === "date" ? (
                <TextField
                  label="Due date"
                  type="date"
                  value={doc.due.date}
                  onChange={(e) => set({ due: { ...doc.due, date: e.target.value } })}
                />
              ) : null}
              <TextField
                label="Discount"
                inputMode="decimal"
                value={doc.discount}
                onChange={(e) => /^\d{0,12}(\.\d{0,6})?$/.test(e.target.value) && set({ discount: e.target.value })}
              />
              <TextField
                label="Other amount"
                inputMode="decimal"
                value={doc.other}
                onChange={(e) => /^\d{0,12}(\.\d{0,6})?$/.test(e.target.value) && set({ other: e.target.value })}
              />
              {doc.other ? (
                <TextField
                  label="Other amount is for"
                  value={doc.otherLabel}
                  maxLength={60}
                  onChange={(e) => set({ otherLabel: e.target.value })}
                  placeholder="Shipping"
                />
              ) : null}
              <dl className={s.sum}>
                <div>
                  <dt>Subtotal</dt>
                  <dd>{money(t.subtotal, doc.token)}</dd>
                </div>
                {t.discount > 0n ? (
                  <div>
                    <dt>Discount</dt>
                    <dd>−{money(t.discount, doc.token)}</dd>
                  </div>
                ) : null}
                {t.other > 0n ? (
                  <div>
                    <dt>{doc.otherLabel || "Other"}</dt>
                    <dd>{money(t.other, doc.token)}</dd>
                  </div>
                ) : null}
                <div className={s.sumTotal}>
                  <dt>Total</dt>
                  <dd>{money(t.total, doc.token)}</dd>
                </div>
              </dl>
              <Chip icon="eye" tone="white">
                Amount public once paid
              </Chip>
            </section>
          </aside>
        </div>
      )}
      {shared ? (
        <ShareSheet
          account={account}
          copy={{ ...copy, linkSeed: new URL(shared.link).hash.match(/k=([^&]+)/)?.[1] ?? copy.linkSeed ?? "" }}
          link={shared.link}
          onClose={() => router.push("/app/invoices")}
        />
      ) : null}
    </div>
  );
}
