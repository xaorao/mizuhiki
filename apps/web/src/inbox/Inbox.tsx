"use client";
/**
 * The inbox (spec 5.8). Linktree's messaging inbox layout (list beside the open
 * conversation) with Gmail-style filters; every row says "Sealed" until it is
 * opened on this device, and opening happens here, never on a server.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Chip, EmptyState, Icon, Oops, Skeleton, Tabs, TextField, TypeChip, type Tone, Kicker } from "@mizuhiki/ui";
import { denomByBase, fromBaseUnits } from "@mizuhiki/chain";
import { useAccount } from "@/account/AccountProvider";
import { useOwner } from "@/owner/OwnerProvider";
import { TYPE_LABEL, searchText, type InboxRow, type Opened } from "./model";
import { useInbox, type Box } from "./useInbox";
import { Detail } from "./Detail";
import s from "./inbox.module.css";

type Filter = "all" | "unread" | "messages" | "files" | "payments";

export const TYPE_TONE: Record<string, Tone> = {
  message: "sakura",
  reply: "sakura",
  payment: "matcha",
  "invoice-payment": "sora",
  order: "matcha",
  form: "fuji",
  request: "butter",
  filedrop: "sora",
};

export function shortAddr(a: string): string {
  return `${a.slice(0, 10)}…${a.slice(-4)}`;
}

export function whoLabel(row: InboxRow, box: Box): string {
  if (box === "sent" && row.to) return `To ${row.to.name ? `@${row.to.name}` : shortAddr(row.to.address)}`;
  if (!row.sender) return "Anonymous";
  return row.sender.name ? `@${row.sender.name}` : shortAddr(row.sender.address);
}

export function amountLabel(p: NonNullable<InboxRow["payment"]>): string {
  const d = denomByBase(p.denom);
  return d ? `${fromBaseUnits(p.amount, d.decimals)} ${d.symbol}` : `${p.amount} ${p.denom}`;
}

export function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const day = (x: Date) => x.toDateString();
  if (day(d) === day(now)) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (day(d) === day(y)) return "Yesterday";
  if (now.getTime() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function preview(row: InboxRow, opened: Opened | undefined): string {
  if (row.type === "request") return "Asked to join one of your rooms · tap to review";
  if (row.payment) {
    const note =
      opened?.kind === "paynote" && opened.note
        ? ` · “${opened.note}”`
        : row.envelope && !opened
          ? " · note sealed"
          : "";
    return `${amountLabel(row.payment)}${note}`;
  }
  if (!opened) return "Sealed · tap to open on this device";
  if (opened.kind === "paynote") return opened.note;
  if (opened.kind === "form") {
    const n = Object.keys(opened.answers).filter((k) => !k.includes(":")).length;
    return `${n} answer${n === 1 ? "" : "s"} · opened on this device`;
  }
  const files = opened.files.length
    ? `${opened.files[0]?.name ?? "file"}${opened.files.length > 1 ? ` and ${opened.files.length - 1} more` : ""}`
    : "";
  return (
    [opened.forwardedBy ? "Forwarded" : "", opened.text.trim().split("\n")[0] ?? "", files]
      .filter(Boolean)
      .join(" · ") || "Empty message"
  );
}

function hasFiles(o: Opened | undefined): boolean {
  if (o?.kind === "form") return Object.values(o.files).some((f) => f.length > 0);
  return o?.kind === "message" && o.files.length > 0;
}

export function Inbox() {
  const acct = useAccount();
  const owner = useOwner();
  const account = acct.account;
  if (!account) throw new Error("Inbox needs an unlocked account");
  const ib = useInbox(account, owner.token, owner.refreshStats);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  // "?item=<id>" opens that item (links from a file request's uploads).
  const params = useSearchParams();
  const [sel, setSel] = useState<string | null>(() => params.get("item"));

  const rows = useMemo(() => ib.rows ?? [], [ib.rows]);
  const unread = rows.filter((r) => !r.read).length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows.filter((r) => {
      const o = r.envelope ? ib.opened[r.envelope] : undefined;
      if (filter === "unread" && r.read) return false;
      if (filter === "payments" && !r.payment) return false;
      if (filter === "messages" && (r.payment || !["message", "reply"].includes(r.kind))) return false;
      if (filter === "files" && !hasFiles(o)) return false;
      if (!needle) return true;
      const hay =
        `${whoLabel(r, ib.box)} ${TYPE_LABEL[r.kind] ?? r.kind} ${o ? searchText(o) : ""} ${r.payment ? amountLabel(r.payment) : ""}`.toLowerCase();
      return hay.includes(needle);
    });
  }, [rows, ib.opened, ib.box, filter, q]);
  const selected = rows.find((r) => r.id === sel) ?? null;
  const sealedCount = rows.filter((r) => r.envelope && !ib.opened[r.envelope]).length;

  const choose = (r: InboxRow) => {
    setSel(r.id);
    void ib.open(r);
  };
  // An item named in the address is opened once its row has loaded, as a tap would.
  const linked = useRef(params.get("item"));
  useEffect(() => {
    const id = linked.current;
    if (!id) return;
    const r = rows.find((x) => x.id === id);
    if (!r) return;
    linked.current = null;
    void ib.open(r);
  }, [rows, ib]);

  return (
    <div className={[s.page, selected ? s.hasSel : ""].join(" ")}>
      <section className={s.listCol} aria-label="Inbox list">
        <header className={s.top}>
          <span className={s.topKicker}>
            <Kicker>とどいた</Kicker>
          </span>
          <h1>Inbox</h1>
          <span className={s.topChip}>
            <Chip icon="lock" tone="white">
              Opens on this device only
            </Chip>
          </span>
          <span
            className={[s.live, ib.live ? s.liveOn : ""].join(" ")}
            title={ib.live ? "New items appear here as they arrive" : "Reconnecting"}
          >
            <span />
            {ib.live ? "Live" : "Connecting"}
          </span>
        </header>
        <Tabs
          label="Boxes"
          value={ib.box}
          onChange={(b) => {
            ib.setBox(b);
            setSel(null);
            setFilter("all");
          }}
          tabs={[
            { value: "inbox", label: "Inbox", badge: ib.box === "inbox" ? unread : undefined },
            { value: "archived", label: "Archived" },
            { value: "sent", label: "Sent" },
          ]}
        />
        <div className={s.tools}>
          <TextField
            label="Search"
            hideLabel
            type="search"
            prefix={<Icon name="search" size={16} />}
            placeholder="Search opened items and senders"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className={s.filters} role="group" aria-label="Filter">
            {(
              [
                ["all", "All"],
                ["unread", `Unread${unread ? ` ${unread}` : ""}`],
                ["messages", "Messages"],
                ["files", "Files"],
                ["payments", "Payments"],
              ] as const
            )
              .filter(([f]) => ib.box === "inbox" || (f !== "unread" && f !== "payments"))
              .map(([f, label]) => (
                <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {label}
                </button>
              ))}
          </div>
          {q.trim() && sealedCount > 0 ? (
            <p className={s.searchNote}>
              <Icon name="lock" size={13} /> Search reads only what you have opened here. {sealedCount} still sealed.
            </p>
          ) : null}
        </div>
        {ib.error ? (
          <Oops title="The inbox did not load" action={<button onClick={() => void ib.reload()}>Try again</button>}>
            {ib.error}
          </Oops>
        ) : ib.rows === null ? (
          <div className={s.loading}>
            <Skeleton avatar lines={2} />
            <Skeleton avatar lines={2} />
            <Skeleton avatar lines={2} />
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            title={
              rows.length === 0
                ? ib.box === "sent"
                  ? "Nothing sent yet"
                  : ib.box === "archived"
                    ? "Nothing archived"
                    : "All caught up"
                : "Nothing matches"
            }
            jp={rows.length === 0 && ib.box === "inbox" ? "おつかれさま" : undefined}
            face={rows.length === 0 ? "sleepy" : "normal"}
          >
            {rows.length === 0
              ? ib.box === "inbox"
                ? "New sealed items will land here. Share your page so people can send you something."
                : ib.box === "sent"
                  ? "Replies and forwards you seal appear here, readable only by you and the person you sent them to."
                  : "Archived items stay sealed and can be moved back any time."
              : "Try another filter or search."}
          </EmptyState>
        ) : (
          <ul className={s.rows}>
            {shown.map((r) => {
              const o = r.envelope ? ib.opened[r.envelope] : undefined;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    className={s.row}
                    aria-current={sel === r.id ? "true" : undefined}
                    onClick={() => choose(r)}
                  >
                    <span
                      className={[s.dot, r.read ? s.read : ""].join(" ")}
                      aria-label={r.read ? undefined : "Unread"}
                    />
                    <TypeChip tone={TYPE_TONE[r.kind] ?? "white"}>{TYPE_LABEL[r.kind] ?? r.kind}</TypeChip>
                    <span className={s.rowText}>
                      <b>{whoLabel(r, ib.box)}</b>
                      <small>{preview(r, o)}</small>
                    </span>
                    <time dateTime={r.at}>{when(r.at)}</time>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className={s.detailCol} aria-label="Opened item">
        {selected ? (
          <Detail
            key={selected.id}
            row={selected}
            box={ib.box}
            state={ib.states[selected.id] ?? { state: "opening" }}
            check={ib.checks[selected.id] ?? "checking"}
            account={account}
            token={owner.token}
            onBack={() => setSel(null)}
            onRetry={() => void ib.open(selected)}
            onFlag={async (f) => {
              await ib.setFlag(selected, f);
              if (f.archived !== undefined) setSel(null);
            }}
            sent={ib.sentFor(selected)}
            onSent={() => void ib.loadSent()}
          />
        ) : (
          <div className={s.nothing}>
            <EmptyState title="Pick something to open" face="normal">
              It opens on this device. Mizuhiki never sees what is inside.
            </EmptyState>
          </div>
        )}
      </section>
    </div>
  );
}
