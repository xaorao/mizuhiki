"use client";
/** An invoice as the payer reads it (also the owner's Preview). */
import { useState } from "react";
import { Button, Icon, StatusChip, type Status as ChipStatus } from "@mizuhiki/ui";
import { decryptFile, type FileFacts } from "@mizuhiki/core";
import { api } from "@/lib/api";
import { fmtBytes } from "@/public/MessageSheet";
import { DUE_LABEL, STATUS_LABEL, dueDate, money, numberLabel, totals, type InvoiceDoc, type Status } from "./model";
import s from "./invoices.module.css";

export const STATUS_CHIP: Record<Status, ChipStatus> = {
  draft: "neutral",
  due: "wait",
  overdue: "danger",
  partly: "wait",
  paid: "ok",
  recorded: "info",
  cancelled: "neutral",
};

const fmtDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

function Attachment({ f }: { f: FileFacts }) {
  const [busy, setBusy] = useState<number | null>(null);
  const [err, setErr] = useState(false);
  const save = async () => {
    setErr(false);
    setBusy(0);
    try {
      const parts = await decryptFile({
        facts: f,
        fetchChunk: (h) => api.bytes(`/blobs/${h}`),
        onProgress: (d, t) => setBusy(d / Math.max(1, t)),
      });
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: f.type || "application/octet-stream" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch {
      setErr(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className={s.attach}>
      <Icon name="file" size={18} />
      <span>
        <b>{f.name}</b>
        <small>
          {err
            ? "Could not be unsealed here."
            : busy !== null
              ? `Unsealing ${Math.round(busy * 100)}%`
              : `${fmtBytes(f.size)} · sealed`}
        </small>
      </span>
      <Button size="sm" variant="line" icon="download" onClick={() => void save()} disabled={busy !== null}>
        Save
      </Button>
    </li>
  );
}

export function InvoiceView({
  doc,
  status,
  sentAt,
}: {
  doc: InvoiceDoc;
  status?: Status | undefined;
  sentAt?: string | null | undefined;
}) {
  const t = totals(doc);
  const due = dueDate(doc, sentAt);
  return (
    <article className={s.paper} aria-label={`Invoice ${numberLabel(doc.number)}`}>
      <header className={s.paperHead}>
        <div>
          <p className={s.kicker}>せいきゅうしょ · Invoice</p>
          <h2>{numberLabel(doc.number)}</h2>
          {status ? <StatusChip status={STATUS_CHIP[status]}>{STATUS_LABEL[status]}</StatusChip> : null}
        </div>
        <div className={s.fromBlock}>
          <b>{doc.from.business || doc.from.displayName}</b>
          {doc.from.business ? <span>{doc.from.displayName}</span> : null}
          {doc.from.name ? <span>@{doc.from.name}</span> : null}
          <small className={s.mono}>{doc.from.address}</small>
        </div>
      </header>
      <dl className={s.meta}>
        <div>
          <dt>Bill to</dt>
          <dd>
            {doc.billTo.business ? <b>{doc.billTo.business}</b> : null}
            {doc.billTo.kind === "name" && doc.billTo.name ? <span>@{doc.billTo.name}</span> : null}
            {doc.billTo.kind === "address" ? <span className={s.mono}>{doc.billTo.address}</span> : null}
            {doc.billTo.kind === "link" ? <span>{doc.billTo.label || "Anyone with the link"}</span> : null}
          </dd>
        </div>
        <div>
          <dt>Issued</dt>
          <dd>{fmtDate(new Date(sentAt ?? doc.issued))}</dd>
        </div>
        <div>
          <dt>Due</dt>
          <dd>{due ? (doc.due.preset === "receipt" ? "On receipt" : fmtDate(due)) : DUE_LABEL.none}</dd>
        </div>
      </dl>
      <table className={s.items}>
        <thead>
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Qty</th>
            <th scope="col">Price</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {doc.items.map((it, i) => (
            <tr key={it.id}>
              <td>
                <b>{it.name || "Untitled item"}</b>
                {it.description ? <small>{it.description}</small> : null}
                {/* Phones drop the unit-price column; the price stays readable here. */}
                {it.price ? (
                  <small className={s.unitPhone}>
                    {it.qty} × {it.price}
                  </small>
                ) : null}
              </td>
              <td>{it.qty}</td>
              <td>{it.price || "—"}</td>
              <td>{money(t.lines[i] ?? 0n, doc.token)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
      {doc.message ? (
        <section className={s.message}>
          <h3>
            <Icon name="lock" size={14} /> Message
          </h3>
          <p>{doc.message}</p>
        </section>
      ) : null}
      {doc.attachments.length ? (
        <ul className={s.attachments}>
          {doc.attachments.map((f) => (
            <Attachment key={f.fileId} f={f} />
          ))}
        </ul>
      ) : null}
    </article>
  );
}
