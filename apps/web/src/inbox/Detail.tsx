"use client";
/**
 * One opened item: who sent it and what that means, what is inside, files to
 * preview or save, the payment with its transaction, the replies you sent,
 * and the actions (reply, forward, archive, export, mark unread).
 */
import { useEffect, useState } from "react";
import {
  Button,
  ButtonLink,
  Icon,
  IconButton,
  Oops,
  Readers,
  Skeleton,
  StatusChip,
  TypeChip,
  useToast,
} from "@mizuhiki/ui";
import { decryptFile, type FileFacts } from "@mizuhiki/core";
import { explorerTx } from "@mizuhiki/chain";
import type { Account } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import { SITE_URL } from "@/lib/site";
import { TYPE_LABEL, openRow, type InboxRow, type Opened } from "./model";
import type { Box, OpenState, SenderCheck } from "./useInbox";
import { TYPE_TONE, amountLabel, shortAddr, when, whoLabel } from "./Inbox";
import { ComposeSheet, type ComposeMode } from "./ComposeSheet";
import { fmtBytes } from "@/public/MessageSheet";
import { ProveSheet } from "@/proof/ProveSheet";
import type { Hashed } from "@/proof/HashDrop";
import s from "./inbox.module.css";

/** Who can open this envelope: you, plus the other party when it was sealed to both (signed replies and forwards). */
function readersOf(row: InboxRow, box: Box): { label: string }[] {
  if (box === "sent") return [{ label: "you" }, { label: row.to?.name ? `@${row.to.name}` : "them" }];
  // Signed messages and payment notes from Mizuhiki payers are sealed to the sender too.
  if (row.readers > 1 && row.sender)
    return [{ label: "you" }, { label: row.sender.name ? `@${row.sender.name}` : shortAddr(row.sender.address) }];
  return [{ label: "you" }];
}

/** Only invoice links on this site are offered as a button; anything else stays plain text. */
function safeInvoiceLink(link: string): boolean {
  try {
    const u = new URL(link);
    return u.origin === new URL(SITE_URL).origin && /^\/i\/[a-z0-9]{10,32}$/.test(u.pathname);
  } catch {
    return false;
  }
}

function SenderPanel({
  row,
  check,
  opened,
  box,
}: {
  row: InboxRow;
  check: SenderCheck;
  opened: Opened | undefined;
  box: Box;
}) {
  if (box === "sent")
    return (
      <div className={[s.who, s.whoOk].join(" ")}>
        <Icon name="send" size={18} />
        <div>
          <b>You sent this, signed with your key.</b>
          <span>
            It is sealed to {row.to?.name ? `@${row.to.name}` : "them"} and to you, so it opens on any of your devices.
          </span>
        </div>
      </div>
    );
  if (row.payment && row.sender)
    return (
      <div className={s.who}>
        <Icon name="wallet" size={18} />
        <div>
          <b>
            Paid from wallet {row.sender.name ? `@${row.sender.name} · ` : ""}
            {shortAddr(row.sender.address)}
          </b>
          <span>
            The payer, amount and time are public on QoreChain.{" "}
            {row.envelope ? "Only the note is sealed." : "No note was attached."}
          </span>
        </div>
      </div>
    );
  if (!row.sender) {
    const claims = opened?.kind === "message" && opened.from;
    return (
      <div className={s.who}>
        <Icon name="eye" size={18} />
        <div>
          <b>Anonymous</b>
          <span>
            Nothing about the sender was attached, so nobody, including Mizuhiki, can tell you who sent it.
            {claims ? " The note names an account, but it is not signed, so treat that as a claim." : ""}
          </span>
        </div>
      </div>
    );
  }
  const name = row.sender.name ? `@${row.sender.name}` : shortAddr(row.sender.address);
  if (check === "checking")
    return (
      <div className={s.who}>
        <span className={s.spin} />
        <div>
          <b>{name}</b>
          <span>Checking the signature against their key on QoreChain…</span>
        </div>
      </div>
    );
  if (check === "verified") {
    const mismatch = opened?.kind === "message" && opened.from !== undefined && opened.from !== row.sender.address;
    return (
      <div className={[s.who, mismatch ? s.whoBad : s.whoOk].join(" ")}>
        <Icon name={mismatch ? "alert" : "shield"} size={18} />
        <div>
          <b>{mismatch ? `Signed by ${name}, but the note names someone else` : `Verified: ${name}`}</b>
          <span>
            {mismatch
              ? "The signature is real, but what is inside claims a different sender. Be careful."
              : "Signed with their post-quantum key, checked on this device against QoreChain just now."}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className={[s.who, s.whoBad].join(" ")}>
      <Icon name="alert" size={18} />
      <div>
        <b>The signature did not check out</b>
        <span>It claims to be from {name}, but it does not match their key on QoreChain. Treat it as anonymous.</span>
      </div>
    </div>
  );
}

function FileItem({ f, onProve }: { f: FileFacts; onProve: () => void }) {
  const [state, setState] = useState<
    { s: "idle" } | { s: "busy"; p: number } | { s: "ready"; url: string } | { s: "failed"; why: string }
  >({ s: "idle" });
  const isImage = f.type.startsWith("image/") && !f.type.includes("svg");
  useEffect(
    () => () => {
      if (state.s === "ready") URL.revokeObjectURL(state.url);
    },
    [state],
  );
  const unseal = async (): Promise<string | null> => {
    if (state.s === "ready") return state.url;
    setState({ s: "busy", p: 0 });
    try {
      const parts = await decryptFile({
        facts: f,
        fetchChunk: (h) => api.bytes(`/blobs/${h}`),
        onProgress: (d, t) => setState({ s: "busy", p: d / Math.max(1, t) }),
      });
      const url = URL.createObjectURL(new Blob(parts as BlobPart[], { type: f.type || "application/octet-stream" }));
      setState({ s: "ready", url });
      return url;
    } catch {
      setState({ s: "failed", why: "This file could not be unsealed. It may have expired, or a piece was changed." });
      return null;
    }
  };
  const save = async () => {
    const url = await unseal();
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = f.name;
    a.click();
  };
  return (
    <li className={s.file}>
      <span className={s.fileIcon}>
        <Icon name={isImage ? "image" : "file"} size={20} />
      </span>
      <span className={s.fileText}>
        <b>{f.name}</b>
        <small>
          {fmtBytes(f.size)} ·{" "}
          {state.s === "busy"
            ? `Unsealing ${Math.round(state.p * 100)}%`
            : state.s === "ready"
              ? "Unsealed on this device"
              : "Sealed"}
        </small>
      </span>
      {isImage && state.s !== "ready" ? (
        <Button variant="line" size="sm" icon="eye" onClick={() => void unseal()} disabled={state.s === "busy"}>
          Preview
        </Button>
      ) : null}
      <Button variant="cord" size="sm" icon="download" onClick={() => void save()} disabled={state.s === "busy"}>
        Save
      </Button>
      <button type="button" className={s.proveLink} onClick={onProve}>
        <Icon name="check" size={13} /> Prove it existed
      </button>
      {state.s === "ready" && isImage ? (
        <img className={s.preview} src={state.url} alt={`Preview of ${f.name}`} />
      ) : null}
      {state.s === "failed" ? <p className={s.fileErr}>{state.why}</p> : null}
    </li>
  );
}

function SentReply({ row, account }: { row: InboxRow; account: Account }) {
  const [item, setItem] = useState<Opened | null | "failed">(null);
  useEffect(() => {
    void openRow(account, row).then(setItem, () => setItem("failed"));
  }, [account, row]);
  return (
    <div className={s.mine}>
      <small>You replied · {when(row.at)}</small>
      {item === null ? (
        <Skeleton lines={2} />
      ) : item === "failed" ? (
        <p>This reply could not be opened here.</p>
      ) : item.kind === "message" ? (
        <p>{item.text}</p>
      ) : null}
    </div>
  );
}

export function Detail({
  row,
  box,
  state,
  check,
  account,
  token,
  sent,
  onBack,
  onRetry,
  onFlag,
  onSent,
}: {
  row: InboxRow;
  box: Box;
  state: OpenState;
  check: SenderCheck;
  account: Account;
  token: () => Promise<string>;
  sent: InboxRow[];
  onBack: () => void;
  onRetry: () => void;
  onFlag: (f: { read?: boolean; archived?: boolean }) => Promise<void>;
  onSent: () => void;
}) {
  const toast = useToast();
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [proving, setProving] = useState<Hashed | null>(null);
  const opened = state.state === "open" ? state.item : undefined;
  const msg = opened?.kind === "message" ? opened : undefined;
  const replyTo =
    box === "sent" ? null : row.sender && (row.sender.how === "payment" || check === "verified") ? row.sender : null;

  const exportItem = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      envelope: row.envelope,
      kind: row.kind,
      received: row.at,
      sender: row.sender ? { ...row.sender, signature: check } : "anonymous",
      payment: row.payment ? { ...row.payment, explorer: explorerTx(row.payment.txHash) } : null,
      content: opened ?? null,
      note: "Exported from Mizuhiki on the owner's device. File keys inside let anyone holding this file open the files: keep it private.",
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `mizuhiki-${row.kind}-${(row.envelope ?? row.id).slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.show("Exported to your downloads");
  };

  return (
    <article className={s.detail}>
      <header className={s.dHead}>
        <IconButton icon="back" label="Back to the list" onClick={onBack} className={s.back} />
        <TypeChip tone={TYPE_TONE[row.kind] ?? "white"}>{TYPE_LABEL[row.kind] ?? row.kind}</TypeChip>
        <h2>{whoLabel(row, box)}</h2>
        <time dateTime={row.at}>
          {new Date(row.at).toLocaleString("en-GB", {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </time>
      </header>

      <SenderPanel row={row} check={check} opened={opened} box={box} />

      {row.payment ? (
        <div className={s.pay}>
          <span className={s.amount}>{amountLabel(row.payment)}</span>
          <StatusChip status="ok">Settled on QoreChain</StatusChip>
          <a href={explorerTx(row.payment.txHash)} target="_blank" rel="noreferrer" className={s.tx}>
            Transaction {row.payment.txHash.slice(0, 10)}… <Icon name="link" size={14} />
          </a>
        </div>
      ) : null}

      {state.state === "opening" ? (
        <div className={s.opening} aria-live="polite">
          <Skeleton lines={4} />
          <small>
            <Icon name="lock" size={13} /> Opening on this device with your key…
          </small>
        </div>
      ) : state.state === "failed" ? (
        <Oops
          title="Not opened"
          action={
            <Button variant="line" size="sm" onClick={onRetry}>
              Try again
            </Button>
          }
        >
          {state.reason}
        </Oops>
      ) : state.state === "open" ? (
        <div className={s.body}>
          {msg?.forwardedBy ? (
            <p className={s.fwd}>
              <Icon name="send" size={14} /> Forwarded by {shortAddr(msg.forwardedBy)}
              {msg.originalFrom
                ? ` · originally from ${msg.originalFrom === "anonymous" ? "an anonymous sender" : shortAddr(msg.originalFrom)}`
                : ""}
              {msg.forwardNote ? <q>{msg.forwardNote}</q> : null}
            </p>
          ) : null}
          {msg?.quote ? <blockquote className={s.quote}>{msg.quote}</blockquote> : null}
          {opened?.kind === "paynote" ? <p className={s.text}>{opened.note || "No note."}</p> : null}
          {msg ? <p className={s.text}>{msg.text || <em>No message, files only.</em>}</p> : null}
          {msg?.link && safeInvoiceLink(msg.link) ? (
            <ButtonLink href={msg.link} variant="cord" icon="invoice" className={s.openLink}>
              Open the invoice
            </ButtonLink>
          ) : null}
          {msg?.contact ? (
            <p className={s.contact}>
              <Icon name="info" size={14} /> They left: <b>{msg.contact}</b>
            </p>
          ) : null}
          {msg?.files.length ? (
            <ul className={s.files}>
              {msg.files.map((f) => (
                <FileItem
                  key={f.fileId}
                  f={f}
                  onProve={() => setProving({ hash: f.sha256, file: { name: f.name, size: f.size, type: f.type } })}
                />
              ))}
            </ul>
          ) : null}
          <Readers readers={readersOf(row, box)} />
          {row.expiresAt ? (
            <p className={s.expires}>
              <Icon name="clock" size={13} /> Sealed copy kept until{" "}
              {new Date(row.expiresAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
              . Save files you want to keep.
            </p>
          ) : null}
        </div>
      ) : null}

      {sent.length ? (
        <div className={s.thread}>
          {sent.map((r) => (
            <SentReply key={r.id} row={r} account={account} />
          ))}
        </div>
      ) : null}

      <footer className={s.actions}>
        {replyTo ? (
          <Button
            variant="cord"
            icon="reply"
            onClick={() =>
              setCompose({
                kind: "reply",
                to: replyTo.address,
                toLabel: replyTo.name ? `@${replyTo.name}` : shortAddr(replyTo.address),
              })
            }
          >
            Reply sealed
          </Button>
        ) : box !== "sent" && !row.payment ? (
          <span className={s.noReply}>
            <Icon name="info" size={14} />{" "}
            {msg?.contact ? "Anonymous: reply using what they left above." : "Anonymous: there is no way to reply."}
          </span>
        ) : null}
        {msg ? (
          <Button variant="line" icon="send" onClick={() => setCompose({ kind: "forward" })}>
            Forward
          </Button>
        ) : null}
        {box !== "sent" && row.type === "envelope" ? (
          <Button
            variant="line"
            icon="archive"
            onClick={() =>
              void onFlag({ archived: box !== "archived" }).then(() =>
                toast.show(box === "archived" ? "Moved back to the inbox" : "Archived"),
              )
            }
          >
            {box === "archived" ? "Move to inbox" : "Archive"}
          </Button>
        ) : null}
        {box === "inbox" && row.envelope && row.read ? (
          <Button
            variant="ghost"
            icon="mail"
            onClick={() => void onFlag({ read: false }).then(() => toast.show("Marked unread"))}
          >
            Mark unread
          </Button>
        ) : null}
        {opened || row.payment ? (
          <Button variant="ghost" icon="download" onClick={exportItem}>
            Export
          </Button>
        ) : null}
        {row.payment ? (
          <ButtonLink
            variant="ghost"
            icon="link"
            href={explorerTx(row.payment.txHash)}
            target="_blank"
            rel="noreferrer"
          >
            Explorer
          </ButtonLink>
        ) : null}
      </footer>

      {proving ? (
        <ProveSheet account={account} target={proving} defaultKind="file" onClose={() => setProving(null)} />
      ) : null}
      {compose ? (
        <ComposeSheet
          mode={compose}
          account={account}
          token={token}
          original={{ row, opened: msg, check }}
          onClose={() => setCompose(null)}
          onSent={onSent}
        />
      ) : null}
    </article>
  );
}
