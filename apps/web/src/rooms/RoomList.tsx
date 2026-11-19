"use client";
/**
 * The room list (Telegram's chat list, adapted): photo, name, last message,
 * time, unread count, muted mark, and admin to-dos. Rooms someone asked to
 * join show as "Waiting for approval" until an admin lets them in.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button, ButtonLink, EmptyState, Icon, Oops, Skeleton, TextField, useToast } from "@mizuhiki/ui";
import { useAccount } from "@/account/AccountProvider";
import { cancelRequest, withToken } from "./engine";
import { ROOM_TEMPLATES } from "@mizuhiki/core";
import { RoomAvatar, label, useNames } from "./people";
import type { ListState } from "./useRoomList";
import s from "./rooms.module.css";

export function when(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days < 6) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function RoomList({ list, activeId }: { list: ListState; activeId?: string | undefined }) {
  const { account, token } = useAccount();
  const toast = useToast();
  const [q, setQ] = useState("");
  const me = account?.owner.address;
  const authors = useMemo(
    () => Object.values(list.summaries).flatMap((x) => (x.preview ? [x.preview.author] : [])),
    [list.summaries],
  );
  const names = useNames(authors);
  const shown = list.rooms
    .filter((r) => r.status !== "blocked")
    .filter((r) => {
      const n = list.summaries[r.id]?.name ?? "";
      return !q.trim() || n.toLowerCase().includes(q.trim().toLowerCase());
    });

  const cancel = async (roomId: string) => {
    if (!account) return;
    try {
      await cancelRequest(withToken(account, await token()), roomId);
      toast.show("Request cancelled.");
      void list.reload();
    } catch (e) {
      toast.show((e as Error).message, { tone: "error" });
    }
  };

  return (
    <section className={s.list} aria-label="Rooms">
      <header className={s.listHead}>
        <div>
          <p className={s.kicker}>へや · Rooms</p>
          <h1>Rooms</h1>
        </div>
        <ButtonLink href="/app/rooms/new" icon="plus" size="sm">
          New room
        </ButtonLink>
      </header>
      {list.rooms.length > 4 ? (
        <div className={s.listSearch}>
          <TextField
            label="Search rooms"
            hideLabel
            placeholder="Search rooms"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            prefix={<Icon name="search" size={18} />}
          />
        </div>
      ) : null}

      {list.error && list.rooms.length === 0 ? (
        <Oops
          title="Rooms did not load"
          action={
            <Button variant="line" size="sm" icon="undo" onClick={() => void list.reload()}>
              Try again
            </Button>
          }
        >
          {list.error} Nothing was changed.
        </Oops>
      ) : list.loading && list.rooms.length === 0 ? (
        <div className={s.rows}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} avatar lines={2} />
          ))}
        </div>
      ) : shown.length === 0 && list.waiting.length === 0 ? (
        q ? (
          <p className={s.none}>No room called “{q}”.</p>
        ) : (
          <EmptyState
            title="No rooms yet"
            jp="へやはまだ"
            face="happy"
            action={
              <ButtonLink href="/app/rooms/new" icon="plus">
                New room
              </ButtonLink>
            }
          >
            A room is a private group for a deal, a team or your family. Messages and files are sealed to the people in
            it, and the lock changes when someone leaves.
          </EmptyState>
        )
      ) : (
        <ul className={s.rows}>
          {list.waiting.map((w) => {
            const card = list.cards[w.roomId];
            return (
              <li key={`w:${w.roomId}`} className={s.row} data-state="waiting">
                <RoomAvatar name={card?.name ?? "Room"} photo={card?.photo} roomId={w.roomId} size={48} />
                <span className={s.rowText}>
                  <b>{card?.name || "A room you asked to join"}</b>
                  <small>
                    {w.status === "declined" ? "An admin declined your request." : "Waiting for an admin to let you in"}
                  </small>
                </span>
                <button type="button" className={s.rowAction} onClick={() => void cancel(w.roomId)}>
                  {w.status === "declined" ? "Dismiss" : "Cancel"}
                </button>
              </li>
            );
          })}
          {shown.map((r) => {
            const sum = list.summaries[r.id];
            const name = sum?.name || (sum ? "Unnamed room" : "Opening…");
            const preview =
              r.status === "removed"
                ? "You were removed from this room"
                : r.status === "left"
                  ? "You left this room"
                  : sum?.preview
                    ? `${label(sum.preview.author, names, me)}: ${sum.preview.text}`
                    : sum
                      ? `${ROOM_TEMPLATES[sum.type].label} room · ${r.members} ${r.members === 1 ? "member" : "members"}`
                      : "Opening on this device…";
            const todo = r.requests > 0 ? `${r.requests} to approve` : null;
            return (
              <li key={r.id}>
                <Link
                  href={`/app/rooms/${r.id}`}
                  className={s.row}
                  data-active={activeId === r.id || undefined}
                  data-state={r.status}
                >
                  <RoomAvatar name={name} photo={sum?.photo} roomId={r.id} size={48} />
                  <span className={s.rowText}>
                    <b>
                      {name}
                      {r.muted ? <Icon name="bell" size={14} label="Muted" /> : null}
                    </b>
                    <small>{preview}</small>
                  </span>
                  <span className={s.rowMeta}>
                    <time dateTime={r.lastAt}>{when(r.lastAt)}</time>
                    {todo ? (
                      <span className={s.todo}>{todo}</span>
                    ) : r.unread > 0 ? (
                      <span className={s.badge} aria-label={`${r.unread} unread`}>
                        {r.unread > 99 ? "99+" : r.unread}
                      </span>
                    ) : null}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
