"use client";
/**
 * The room list. Room names, photos and last messages are sealed inside each
 * room, so the list opens each room on this device (incrementally, from the
 * local encrypted copy) and keeps a small encrypted summary per room.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAccount } from "@/account/AccountProvider";
import {
  getRoom,
  listRooms,
  loadLines,
  readSummaries,
  roomCards,
  withToken,
  writeSummaries,
  type InviteCard,
  type RoomListItem,
  type RoomSummary,
} from "./engine";
import { derive, snippetOf } from "./derive";
import { useDebounced, useRoomEvents } from "./useRoom";
import { onSummary } from "./summaries";

export interface ListState {
  rooms: RoomListItem[];
  waiting: { roomId: string; at: string; status: "pending" | "declined" }[];
  summaries: Record<string, RoomSummary>;
  cards: Record<string, InviteCard>;
  loading: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useRoomList(activeId?: string): ListState {
  const { account, token } = useAccount();
  const [rooms, setRooms] = useState<RoomListItem[]>([]);
  const [waiting, setWaiting] = useState<ListState["waiting"]>([]);
  const [summaries, setSummaries] = useState<Record<string, RoomSummary>>({});
  const summariesRef = useRef(summaries);
  summariesRef.current = summaries;
  const [cards, setCards] = useState<Record<string, InviteCard>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const queued = useRef(false);
  const isQueued = useCallback(() => queued.current, []);
  const active = useRef(activeId);
  active.current = activeId;

  const reload = useCallback(async () => {
    if (!account) return;
    if (running.current) {
      queued.current = true;
      return;
    }
    running.current = true;
    try {
      do {
        queued.current = false;
        const a = withToken(account, await token());
        const r = await listRooms(a);
        setRooms(r.rooms);
        setWaiting(r.waiting);
        setCards(await roomCards(account));
        const known = await readSummaries(account);
        setSummaries(known);
        let changed = false;
        for (const room of r.rooms) {
          if (room.status === "blocked") continue;
          const k = known[room.id];
          if (k && k.lastSeq === room.lastSeq) continue;
          // The open room's screen keeps its own summary current (see summaries.ts).
          if (room.id === active.current && k) continue;
          try {
            const [detail, lines] = await Promise.all([getRoom(a, room.id), loadLines(a, room.id)]);
            const d = derive(lines, detail.members, detail.epochs);
            const last = [...d.items].reverse().find((i) => i.type === "message");
            known[room.id] = {
              lastSeq: room.lastSeq,
              name: d.info.name,
              type: d.info.type,
              photo: d.info.photo,
              preview: last?.type === "message" ? { author: last.author, text: snippetOf(last.body) } : null,
            };
            changed = true;
            setSummaries({ ...known });
          } catch {
            // One room failing to open must not hide the others; it shows without a preview.
          }
        }
        if (changed) await writeSummaries(account, known);
        setError(null);
      } while (isQueued());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      running.current = false;
      setLoading(false);
    }
  }, [account, token, isQueued]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const soon = useDebounced(() => void reload(), 600);
  useRoomEvents((kind) => {
    if (kind === "room" || kind === "roomreq") soon();
  });

  useEffect(
    () =>
      onSummary((roomId, sum) => {
        // Computed outside the state updater, which must stay free of side effects (the device write).
        const all = summariesRef.current;
        const prev = all[roomId];
        if (prev && prev.lastSeq === sum.lastSeq && prev.name === sum.name && prev.photo?.fileId === sum.photo?.fileId)
          return;
        const next = { ...all, [roomId]: sum };
        summariesRef.current = next;
        setSummaries(next);
        if (account) void writeSummaries(account, next);
      }),
    [account],
  );

  return { rooms, waiting, summaries, cards, loading, error, reload };
}
