"use client";
/**
 * /app/requests (spec 5.7, Dropbox's file requests list): All, Open and Closed,
 * with Name, Created, Deadline, Uploads and Size, which is what the server can
 * see. Names and contents stay sealed. Updates live when an upload arrives.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, Chip, EmptyState, Icon, Kicker, Oops, Skeleton, StatusChip } from "@mizuhiki/ui";
import { requestState, type FileRequest } from "@mizuhiki/core";
import { useOwner, useOwnerSession } from "@/owner/OwnerProvider";
import { useRoomEvents } from "@/rooms/useRoom";
import { fmtBytes } from "@/public/MessageSheet";
import { createRequest, listRequests, type Tokened } from "./engine";
import { deadlineDay, STATE_LABEL, type RequestRow } from "./model";
import { RequestSheet } from "./RequestSheet";
import { ShareRequest } from "./ShareRequest";
import s from "./requests.module.css";
import { failureText } from "@/lib/failure";

type Filter = "all" | "open" | "closed";
const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export function RequestsHome() {
  const router = useRouter();
  const { account, token } = useOwnerSession();
  const name = useOwner().published?.name ?? "";
  const tokened = useCallback(async (): Promise<Tokened> => ({ ...account, token: await token() }), [account, token]);
  const [rows, setRows] = useState<RequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<FileRequest | null>(null);

  const load = useCallback(async () => {
    try {
      setRows((await listRequests(await tokened())).requests);
      setError(null);
    } catch (e) {
      setError(failureText(e, "Your requests could not be loaded. Nothing changed."));
    }
  }, [tokened]);
  useEffect(() => {
    void load();
  }, [load]);
  useRoomEvents((kind) => {
    if (kind === "drop" || kind === "freq") void load();
  });

  const counts = useMemo(() => {
    const all = rows ?? [];
    return {
      all: all.length,
      open: all.filter((r) => r.record.body.status === "open").length,
      closed: all.filter((r) => r.record.body.status === "closed").length,
    };
  }, [rows]);
  const shown = (rows ?? []).filter((r) => filter === "all" || r.record.body.status === filter);

  return (
    <div className={s.page}>
      <header className={s.top}>
        <div className={s.titleBlock}>
          <Kicker>あつめる</Kicker>
          <h1>File requests</h1>
          <p className={s.lede}>
            Ask for exactly the files you need. Anyone with the link uploads without an account, and everything is
            sealed on their device to you. Uploaders never see each other&rsquo;s files.
          </p>
        </div>
        {/* One main action: an empty list carries its own button. */}
        {rows !== null && rows.length > 0 ? (
          <Button variant="cord" icon="plus" className={s.newBtn} onClick={() => setCreating(true)}>
            New request
          </Button>
        ) : null}
      </header>

      <div className={s.pills} role="group" aria-label="Show">
        {(["all", "open", "closed"] as const).map((f) => (
          <button key={f} type="button" className={s.pill} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "open" ? "Open" : "Closed"} <span>{counts[f]}</span>
          </button>
        ))}
      </div>

      {error ? (
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
      ) : rows === null ? (
        <Skeleton lines={4} />
      ) : shown.length === 0 ? (
        <div className={s.emptyWrap}>
          {filter === "closed" ? (
            <EmptyState title="No closed requests" face="sleepy" jp="まだだよ">
              Requests you close move here. People can no longer upload to them until you reopen one.
            </EmptyState>
          ) : (
            <EmptyState
              title="No requests yet"
              face="normal"
              jp="あつめよう"
              action={
                <Button variant="cord" icon="plus" onClick={() => setCreating(true)}>
                  New request
                </Button>
              }
            >
              Ask a client for their documents, or a family for their photos. You get one link to send.
            </EmptyState>
          )}
        </div>
      ) : (
        <div className={s.table} role="table" aria-label="File requests">
          <div className={s.thead} role="row">
            <span role="columnheader">Name</span>
            <span role="columnheader">Created</span>
            <span role="columnheader">Deadline</span>
            <span role="columnheader">Uploads</span>
            <span role="columnheader">Size</span>
            <span aria-hidden="true" />
          </div>
          {shown.map((r) => {
            const b = r.record.body;
            const st = requestState(b);
            return (
              <Link key={b.id} href={`/app/requests/${b.id}`} className={s.trow} role="row">
                <span className={s.name} role="cell">
                  <b>{b.title}</b>
                  <small>
                    <StatusChip status={st === "open" ? "ok" : st === "late" ? "wait" : "neutral"}>
                      {STATE_LABEL[st]}
                    </StatusChip>
                  </small>
                </span>
                <span className={s.cell} role="cell">
                  <span className={s.cellLabel}>Created</span>
                  {day(r.createdAt)}
                </span>
                <span className={s.cell} role="cell">
                  <span className={s.cellLabel}>Deadline</span>
                  {deadlineDay(b) ?? "None"}
                </span>
                <span className={s.cell} role="cell">
                  <span className={s.cellLabel}>Uploads</span>
                  <span className={s.uploads}>
                    {r.unread ? <span className={s.dot} aria-label={`${r.unread} new`} /> : null}
                    {r.uploads}
                    {r.late ? (
                      <Chip tone="butter" icon="clock">
                        {r.late} late
                      </Chip>
                    ) : null}
                  </span>
                </span>
                <span className={s.cell} role="cell">
                  <span className={s.cellLabel}>Size</span>
                  {r.uploads ? fmtBytes(r.bytes) : "–"}
                </span>
                <Icon name="chev" size={18} />
              </Link>
            );
          })}
        </div>
      )}

      <RequestSheet
        open={creating}
        onClose={() => setCreating(false)}
        onSave={async (input) => {
          const def = await createRequest(await tokened(), input);
          setCreating(false);
          setMade(def);
          void load();
        }}
      />
      {made ? (
        <ShareRequest
          open
          fresh
          request={made}
          name={name}
          onClose={() => {
            const id = made.id;
            setMade(null);
            router.push(`/app/requests/${id}`);
          }}
        />
      ) : null}
    </div>
  );
}
