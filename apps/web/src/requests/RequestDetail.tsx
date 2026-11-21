"use client";
/**
 * /app/requests/<id> (spec 5.7): the request's uploads, opened on this device,
 * with their files to save; and Dropbox's actions: share, edit, close request,
 * reactivate request, delete (only once closed). Live as uploads arrive.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Button,
  Chip,
  EmptyState,
  Icon,
  Kicker,
  Oops,
  Panel,
  Sheet,
  Skeleton,
  StatusChip,
  useToast,
} from "@mizuhiki/ui";
import { NAMING_LABEL, fileRequestRef, requestState, type FileRequest } from "@mizuhiki/core";
import { useOwner, useOwnerSession } from "@/owner/OwnerProvider";
import { ApiFailure } from "@/lib/api";
import { useRoomEvents } from "@/rooms/useRoom";
import { openRowWith, type OpenedMessage } from "@/inbox/model";
import { FileItem } from "@/inbox/Detail";
import { fmtBytes } from "@/public/MessageSheet";
import { deleteRequest, getRequest, updateRequest, type Tokened } from "./engine";
import { deadlineText, STATE_LABEL, type UploadRow } from "./model";
import { RequestSheet } from "./RequestSheet";
import { ShareRequest } from "./ShareRequest";
import s from "./requests.module.css";
import { failureText } from "@/lib/failure";

type Opened = { s: "opening" } | { s: "ok"; m: OpenedMessage } | { s: "failed"; why: string };
const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

export function RequestDetail({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const { account, token } = useOwnerSession();
  const name = useOwner().published?.name ?? "";
  const tokened = useCallback(async (): Promise<Tokened> => ({ ...account, token: await token() }), [account, token]);
  const [req, setReq] = useState<{ body: FileRequest; createdAt: string } | null>(null);
  const [uploads, setUploads] = useState<UploadRow[] | null>(null);
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Once deleted here, live events must not fetch it again on the way out.
  const deleted = useRef(false);
  const load = useCallback(async () => {
    if (deleted.current) return;
    try {
      const r = await getRequest(await tokened(), id);
      setReq({ body: r.record.body, createdAt: r.createdAt });
      setUploads(r.uploads);
      setError(null);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 404) setMissing(true);
      else setError(failureText(e, "This request could not be loaded. Nothing changed."));
    }
  }, [id, tokened]);
  useEffect(() => {
    void load();
  }, [load]);
  useRoomEvents((kind) => {
    if (kind === "drop" || kind === "freq") void load();
  });

  // Open each upload on this device, once.
  useEffect(() => {
    if (!uploads) return;
    for (const u of uploads) {
      if (opened[u.hash]) continue;
      setOpened((o) => ({ ...o, [u.hash]: { s: "opening" } }));
      openRowWith(account.keys.seal, { kind: "filedrop", ref: fileRequestRef(id), envelope: u.hash, at: u.at }).then(
        (m) =>
          setOpened((o) => ({
            ...o,
            [u.hash]: m.kind === "message" ? { s: "ok", m } : { s: "failed", why: "Not an upload." },
          })),
        () =>
          setOpened((o) => ({
            ...o,
            [u.hash]: { s: "failed", why: "This upload could not be opened on this device. It may have expired." },
          })),
      );
    }
  }, [uploads, opened, account.keys.seal, id]);

  const act = async (label: string, fn: () => Promise<unknown>, done: string, reload = true) => {
    setBusy(label);
    try {
      await fn();
      toast.show(done);
      if (reload) await load();
    } catch (e) {
      toast.show(failureText(e, "That did not work. Nothing changed."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  if (missing)
    return (
      <div className={s.page}>
        <EmptyState
          title="This request does not exist"
          face="worried"
          jp="あれ？"
          action={<Link href="/app/requests">All requests</Link>}
        >
          It may have been deleted. Uploads it received are still in your inbox.
        </EmptyState>
      </div>
    );
  if (error && !req)
    return (
      <div className={s.page}>
        <Oops
          title="Not loaded"
          action={
            <Button variant="line" icon="undo" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {error}
        </Oops>
      </div>
    );
  if (!req || !uploads)
    return (
      <div className={s.page}>
        <Skeleton lines={5} />
      </div>
    );

  const r = req.body;
  const st = requestState(r);
  const due = deadlineText(r);
  const total = uploads.reduce((n, u) => n + u.size, 0);
  return (
    <div className={s.page}>
      <Link href="/app/requests" className={s.back}>
        <Icon name="back" size={16} /> All requests
      </Link>
      <header className={s.top}>
        <div className={s.titleBlock}>
          <Kicker>あつめる</Kicker>
          <h1>{r.title}</h1>
          {r.description ? <p className={s.lede}>{r.description}</p> : null}
        </div>
        <span className={s.stateChip}>
          <StatusChip status={st === "open" ? "ok" : st === "late" ? "wait" : "neutral"}>{STATE_LABEL[st]}</StatusChip>
        </span>
      </header>

      <div className={s.detail}>
        <section aria-label="Uploads">
          {uploads.length === 0 ? (
            <div className={s.emptyWrap}>
              <EmptyState
                title="No uploads yet"
                face="sleepy"
                jp="まってるね"
                action={
                  r.status === "open" ? (
                    <Button variant="cord" icon="share" onClick={() => setSharing(true)}>
                      Share the link
                    </Button>
                  ) : undefined
                }
              >
                {r.status === "open"
                  ? "Send the link to the people you are asking. Uploads appear here as they arrive."
                  : "This request is closed."}
              </EmptyState>
            </div>
          ) : (
            <ul className={s.uploadsList}>
              {uploads.map((u) => {
                const o = opened[u.hash];
                const signed = (u.senderSig as { signer?: string } | null)?.signer;
                return (
                  <li key={u.hash} className={s.up}>
                    <div className={s.upHead}>
                      <b>{o?.s === "ok" && o.m.contact ? o.m.contact : signed ? "A signed upload" : "Anonymous"}</b>
                      {u.late ? (
                        <Chip tone="butter" icon="clock">
                          Late
                        </Chip>
                      ) : null}
                      {!u.read ? <Chip tone="sakura">New</Chip> : null}
                      <small>
                        {when(u.at)} · {fmtBytes(u.size)}
                      </small>
                    </div>
                    {o === undefined || o.s === "opening" ? (
                      <Skeleton lines={2} />
                    ) : o.s === "failed" ? (
                      <Oops title="Not opened">{o.why}</Oops>
                    ) : (
                      <>
                        {o.m.text ? <p className={s.note}>{o.m.text}</p> : null}
                        <ul className={s.files} aria-label="Files">
                          {o.m.files.map((f) => (
                            <FileItem key={f.chunks[0] ?? f.name} f={f} />
                          ))}
                        </ul>
                      </>
                    )}
                    <Link href={`/app/inbox?item=${u.hash}`} className={s.back}>
                      {signed ? "Check the signature and more in the inbox" : "Open in the inbox"}{" "}
                      <Icon name="chev" size={14} />
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <aside className={s.side}>
          <Panel title="This request" kicker="くわしく">
            <dl className={s.facts}>
              <div>
                <dt>Uploads</dt>
                <dd>
                  {uploads.length} {uploads.length === 1 ? "upload" : "uploads"}
                  {uploads.length ? ` · ${fmtBytes(total)}` : ""}
                </dd>
              </div>
              <div>
                <dt>Deadline</dt>
                <dd>{due ? due.replace(/^Due /, "") : "None"}</dd>
              </div>
              {r.deadline ? (
                <div>
                  <dt>Late uploads</dt>
                  <dd>{r.allowLate ? "Taken and marked late" : "Refused"}</dd>
                </div>
              ) : null}
              <div>
                <dt>File names</dt>
                <dd>{NAMING_LABEL[r.naming]}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{when(req.createdAt)}</dd>
              </div>
            </dl>
          </Panel>
          <div className={s.row}>
            {r.status === "open" ? (
              <>
                <Button variant="cord" icon="share" className={s.grow} onClick={() => setSharing(true)}>
                  Share
                </Button>
                <Button variant="line" icon="pen" className={s.grow} onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  icon="x"
                  full
                  busy={busy === "close"}
                  onClick={() =>
                    void act(
                      "close",
                      async () => updateRequest(await tokened(), r, { status: "closed" }),
                      "Request closed. The link no longer takes uploads.",
                    )
                  }
                >
                  Close request
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="cord"
                  icon="undo"
                  className={s.grow}
                  busy={busy === "reopen"}
                  onClick={() =>
                    void act(
                      "reopen",
                      async () => updateRequest(await tokened(), r, { status: "open" }),
                      "Request reopened. The same link takes uploads again.",
                    )
                  }
                >
                  Reopen request
                </Button>
                <Button variant="danger" icon="trash" className={s.grow} onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              </>
            )}
          </div>
          <p className={s.lockNote}>
            <Icon name="lock" size={14} />
            Names, notes and files are sealed to you. The server only sees how many uploads arrived, their size and
            when.
          </p>
        </aside>
      </div>

      <RequestSheet
        open={editing}
        editing={r}
        onClose={() => setEditing(false)}
        onSave={async (input) => {
          await updateRequest(await tokened(), r, input);
          setEditing(false);
          toast.show("Changes saved");
          await load();
        }}
      />
      <ShareRequest open={sharing} onClose={() => setSharing(false)} request={r} name={name} />
      <Sheet open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete this request?">
        <div className={s.form}>
          <p className={s.help}>
            The link stops working for good and the request leaves your list. The {uploads.length}{" "}
            {uploads.length === 1 ? "upload it received stays" : "uploads it received stay"} in your inbox.
          </p>
          <div className={s.row}>
            <Button variant="line" className={s.grow} onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              icon="trash"
              className={s.grow}
              busy={busy === "delete"}
              onClick={() =>
                void act(
                  "delete",
                  async () => {
                    deleted.current = true;
                    try {
                      await deleteRequest(await tokened(), r.id);
                    } catch (e) {
                      deleted.current = false;
                      throw e;
                    }
                    router.push("/app/requests");
                  },
                  "Request deleted. Its uploads are still in your inbox.",
                  false,
                )
              }
            >
              Delete request
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
