"use client";
/**
 * The owner's invoices (spec 5.6): PayPal's list (Customer, No., Date, Due,
 * Status, Amount) with filters and search on this device; status worked out
 * here from the sealed invoice and on-chain payments. Opening a sent invoice
 * shows it with its actions (PayPal's row menu, adapted).
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  ButtonLink,
  Chip,
  EmptyState,
  Icon,
  Oops,
  Sheet,
  Skeleton,
  StatusChip,
  TextField,
  useToast,
} from "@mizuhiki/ui";
import { explorerTx } from "@mizuhiki/chain";
import { useAccount } from "@/account/AccountProvider";
import { useOwner } from "@/owner/OwnerProvider";
import { api } from "@/lib/api";
import { ProveSheet } from "@/proof/ProveSheet";
import { sha256Hex, canonicalJson, utf8 } from "@mizuhiki/core";
import {
  STATUS_LABEL,
  blankDoc,
  dueDate,
  invoiceLink,
  money,
  numberLabel,
  statusOf,
  totals,
  type PrivateCopy,
  type Status,
} from "./model";
import { useInvoices, saveDraft, type Loaded } from "./useInvoices";
import { InvoiceView, STATUS_CHIP } from "./InvoiceView";
import { ShareSheet } from "./ShareSheet";
import { invoicePdf } from "@/lib/pdfs";
import s from "./invoices.module.css";
import { failureText } from "@/lib/failure";

type Filter = "all" | "draft" | "due" | "overdue" | "paid" | "cancelled" | "archived";

const customer = (c: PrivateCopy | null) =>
  !c
    ? "Unreadable here"
    : c.doc.billTo.business ||
      (c.doc.billTo.kind === "name" && c.doc.billTo.name
        ? `@${c.doc.billTo.name}`
        : c.doc.billTo.kind === "address"
          ? `${c.doc.billTo.address.slice(0, 10)}…`
          : c.doc.billTo.label || "Anyone with the link");

export function InvoiceList() {
  const acct = useAccount();
  const owner = useOwner();
  const router = useRouter();
  const toast = useToast();
  const account = acct.account;
  if (!account) throw new Error("Invoices need an unlocked account");
  const inv = useInvoices(account, owner.token);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Loaded | null>(null);
  const [share, setShare] = useState<{ copy: PrivateCopy; link: string; reminder: boolean } | null>(null);
  const [prove, setProve] = useState<{ hash: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      (inv.items ?? []).map((l) => ({
        l,
        status: l.copy ? statusOf(l.copy.doc, l.rec) : l.rec.state === "draft" ? "draft" : "due",
      })),
    [inv.items],
  );
  const shown = rows.filter(({ l, status }) => {
    if (filter === "archived" ? !l.rec.archived : l.rec.archived) return false;
    if (filter === "due" && status !== "due" && status !== "partly") return false;
    if (filter === "paid" && status !== "paid" && status !== "recorded") return false;
    if (!["all", "archived", "due", "paid"].includes(filter) && status !== filter) return false;
    const n = q.trim().toLowerCase();
    if (!n) return true;
    const c = l.copy;
    return `${customer(c)} ${c ? numberLabel(c.doc.number) : ""} ${c?.doc.items.map((i) => i.name).join(" ") ?? ""} ${c ? money(totals(c.doc).total, c.doc.token) : ""}`
      .toLowerCase()
      .includes(n);
  });

  const patch = async (id: string, body: Record<string, unknown>, done: string) => {
    setBusy(id);
    try {
      await api.patch(`/owner/invoices/${id}`, body, { token: await owner.token() });
      toast.show(done);
      await inv.reload();
      setOpen(null);
    } catch (e) {
      toast.show(failureText(e, "The invoice was not changed. Try again."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const duplicate = async (c: PrivateCopy) => {
    const fresh = blankDoc(account, { name: c.doc.from.name, displayName: c.doc.from.displayName }, inv.nextNumber());
    const copy: PrivateCopy = {
      v: 1,
      memo: c.memo,
      doc: { ...c.doc, id: fresh.id, number: fresh.number, issued: fresh.issued },
    };
    await saveDraft(account, await owner.token(), copy);
    router.push(`/app/invoices/${fresh.id}`);
  };

  const pdf = async (l: Loaded, status: Status) => {
    if (!l.copy) return;
    const bytes = await invoicePdf({
      doc: l.copy.doc,
      status,
      link: l.copy.linkSeed ? invoiceLink(l.copy.doc.id, l.copy.doc.number, l.copy.linkSeed) : null,
      sentAt: l.rec.sentAt,
    });
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `invoice-${l.copy.doc.number.padStart(4, "0")}.pdf`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const filters: [Filter, string][] = [
    ["all", "All"],
    ["draft", "Drafts"],
    ["due", "Due"],
    ["overdue", "Overdue"],
    ["paid", "Paid"],
    ["cancelled", "Cancelled"],
    ["archived", "Archived"],
  ];
  const openStatus = open ? (rows.find((r) => r.l.rec.id === open.rec.id)?.status ?? "due") : "due";

  return (
    <div className={s.listPage}>
      <header className={s.listTop}>
        <h1>Invoices</h1>
        <Chip icon="lock" tone="white">
          Line items sealed to you and your client
        </Chip>
        <ButtonLink href="/app/invoices/new" variant="cord" icon="plus" className={s.newBtn}>
          New invoice
        </ButtonLink>
      </header>
      <div className={s.tools}>
        <TextField
          label="Search"
          hideLabel
          type="search"
          prefix={<Icon name="search" size={16} />}
          placeholder="Search customers, items, amounts"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className={s.filters} role="group" aria-label="Filter">
          {filters.map(([f, label]) => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      {inv.error ? (
        <Oops title="Not loaded" action={<button onClick={() => void inv.reload()}>Try again</button>}>
          {inv.error}
        </Oops>
      ) : inv.items === null ? (
        <Skeleton lines={4} />
      ) : shown.length === 0 ? (
        <EmptyState
          title={rows.length === 0 ? "No invoices yet" : "Nothing matches"}
          face="sleepy"
          action={
            rows.length === 0 ? (
              <ButtonLink href="/app/invoices/new" variant="cord" icon="plus">
                New invoice
              </ButtonLink>
            ) : undefined
          }
        >
          {rows.length === 0
            ? "Bill a client in a minute. Line items are sealed; only the payment is public."
            : "Try another filter or search."}
        </EmptyState>
      ) : (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">No.</th>
                <th scope="col">Date</th>
                <th scope="col">Due</th>
                <th scope="col">Status</th>
                <th scope="col" className={s.num}>
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map(({ l, status }) => {
                const c = l.copy;
                const due = c ? dueDate(c.doc, l.rec.sentAt) : null;
                return (
                  <tr key={l.rec.id}>
                    <td>
                      {l.rec.state === "draft" ? (
                        <Link href={`/app/invoices/${l.rec.id}`} className={s.rowLink}>
                          {customer(c)}
                        </Link>
                      ) : (
                        <button type="button" className={s.rowLink} onClick={() => setOpen(l)}>
                          {customer(c)}
                        </button>
                      )}
                      {l.rec.viewedAt ? <small className={s.viewed}>Viewed (reported by their browser)</small> : null}
                    </td>
                    <td>{c ? numberLabel(c.doc.number) : "—"}</td>
                    <td>
                      {new Date(l.rec.sentAt ?? l.rec.createdAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                      })}
                    </td>
                    <td>
                      {c
                        ? due
                          ? due.toLocaleDateString("en-GB", { day: "numeric", month: "short" })
                          : "No due date"
                        : "—"}
                    </td>
                    <td>
                      <StatusChip status={STATUS_CHIP[status]}>{STATUS_LABEL[status]}</StatusChip>
                    </td>
                    <td className={s.num}>{c ? money(totals(c.doc).total, c.doc.token) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {open?.copy ? (
        <Sheet open onClose={() => setOpen(null)} title={`Invoice ${numberLabel(open.copy.doc.number)}`} wide>
          <div className={s.detail}>
            <InvoiceView doc={open.copy.doc} status={openStatus} sentAt={open.rec.sentAt} />
            {open.rec.payments.length ? (
              <ul className={s.payList}>
                {open.rec.payments.map((p) => (
                  <li key={p.txHash}>
                    <Icon name="coin" size={15} /> Paid on chain{" "}
                    {new Date(p.at).toLocaleString("en-GB", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}{" "}
                    ·{" "}
                    <a href={explorerTx(p.txHash)} target="_blank" rel="noreferrer">
                      {p.txHash.slice(0, 12)}…
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            {open.rec.recordedPaidAt ? (
              <p className={s.recorded}>
                <Icon name="alert" size={14} /> Marked paid by you on{" "}
                {new Date(open.rec.recordedPaidAt).toLocaleDateString("en-GB")}. Not verified on chain.
              </p>
            ) : null}
            {open.copy.memo ? (
              <p className={s.memo}>
                <Icon name="lock" size={14} /> Memo to self: {open.copy.memo}
              </p>
            ) : null}
            <div className={s.actions}>
              {open.copy.linkSeed && open.rec.state === "sent" ? (
                <Button
                  variant="cord"
                  icon="share"
                  onClick={() =>
                    open.copy?.linkSeed &&
                    setShare({
                      copy: open.copy,
                      link: invoiceLink(open.copy.doc.id, open.copy.doc.number, open.copy.linkSeed),
                      reminder: false,
                    })
                  }
                >
                  Share link
                </Button>
              ) : null}
              {open.rec.state === "sent" && openStatus !== "paid" ? (
                <Button
                  variant="line"
                  icon="bell"
                  onClick={() =>
                    open.copy?.linkSeed &&
                    setShare({
                      copy: open.copy,
                      link: invoiceLink(open.copy.doc.id, open.copy.doc.number, open.copy.linkSeed),
                      reminder: true,
                    })
                  }
                >
                  Send reminder
                </Button>
              ) : null}
              <Button variant="line" icon="copy" onClick={() => open.copy && void duplicate(open.copy)}>
                Duplicate
              </Button>
              <Button variant="line" icon="download" onClick={() => void pdf(open, openStatus)}>
                Download PDF
              </Button>
              <Button
                variant="line"
                icon="check"
                onClick={() =>
                  open.copy &&
                  setProve({
                    hash: sha256Hex(utf8(canonicalJson(open.copy.doc))),
                    name: `Invoice ${numberLabel(open.copy.doc.number)}`,
                  })
                }
              >
                Prove it existed
              </Button>
              {open.rec.state === "sent" && openStatus !== "paid" ? (
                <Button
                  variant="ghost"
                  icon="coin"
                  busy={busy === open.rec.id}
                  onClick={() =>
                    void patch(
                      open.rec.id,
                      { recordPaid: !open.rec.recordedPaidAt },
                      open.rec.recordedPaidAt ? "Recorded payment removed" : "Marked paid (unverified)",
                    )
                  }
                >
                  {open.rec.recordedPaidAt ? "Remove recorded payment" : "Record payment (unverified)"}
                </Button>
              ) : null}
              {open.rec.state === "sent" ? (
                <Button
                  variant="ghost"
                  icon="x"
                  busy={busy === open.rec.id}
                  onClick={() => void patch(open.rec.id, { cancel: true }, "Invoice cancelled. The link now says so.")}
                >
                  Cancel invoice
                </Button>
              ) : null}
              <Button
                variant="ghost"
                icon="archive"
                busy={busy === open.rec.id}
                onClick={() =>
                  void patch(
                    open.rec.id,
                    { archived: !open.rec.archived },
                    open.rec.archived ? "Moved back" : "Archived",
                  )
                }
              >
                {open.rec.archived ? "Unarchive" : "Archive"}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
      {share ? (
        <ShareSheet
          account={account}
          copy={share.copy}
          link={share.link}
          reminder={share.reminder}
          onClose={() => setShare(null)}
        />
      ) : null}
      {prove ? (
        <ProveSheet
          account={account}
          target={{ hash: prove.hash, file: { name: prove.name, size: 0, type: "application/json" } }}
          defaultKind="invoice"
          onClose={() => setProve(null)}
        />
      ) : null}
    </div>
  );
}
