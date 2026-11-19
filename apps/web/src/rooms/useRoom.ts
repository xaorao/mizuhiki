"use client";
/**
 * One room on this device: its server record, its opened lines, the derived
 * state, live updates, and the chores an admin's device does on its own
 * (changing the key after someone left; letting invites in when approval is off).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "@/account/AccountProvider";
import { readRoom } from "@mizuhiki/chain";
import { membershipHash, roomIdBytes32 } from "@mizuhiki/core";
import { API_URL } from "@/lib/api";
import {
  admitWaiting,
  markRead,
  rotateAfterLeave,
  syncRoom,
  withToken,
  type JoinRequest,
  type Line,
  type RoomDetail,
} from "./engine";
import { derive, snippetOf, type Derived } from "./derive";
import { publishSummary } from "./summaries";

export type Tokened = ReturnType<typeof withToken>;

/**
 * One live socket per tab, shared by every room screen in it. It carries no
 * content, only "something new" with a kind; subscribers decide what to reload.
 */
const listeners = new Set<(kind: string) => void>();
const liveness = new Set<(on: boolean) => void>();
let socket: { ws: WebSocket | null; stop: boolean; retry?: ReturnType<typeof setTimeout> } | null = null;
let isLive = false;

function openSocket(token: () => Promise<string>) {
  const state: NonNullable<typeof socket> = { ws: null, stop: false };
  socket = state;
  const connect = async () => {
    const t = await token().catch(() => null);
    if (state.stop || !t) return;
    const ws = new WebSocket(`${API_URL.replace(/^http/, "ws")}/owner/events`);
    state.ws = ws;
    ws.onopen = () => ws.send(t);
    ws.onmessage = (m) => {
      const msg = JSON.parse(String(m.data)) as { type: string; kind?: string };
      if (msg.type === "ready") {
        isLive = true;
        for (const f of liveness) f(true);
      }
      if (msg.type === "new" && msg.kind) for (const f of listeners) f(msg.kind);
    };
    ws.onclose = () => {
      isLive = false;
      for (const f of liveness) f(false);
      if (!state.stop) state.retry = setTimeout(() => void connect(), 5000);
    };
  };
  void connect();
}

export function useRoomEvents(onEvent: (kind: string) => void): boolean {
  const { token } = useAccount();
  const [live, setLive] = useState(isLive);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    const f = (k: string) => cb.current(k);
    listeners.add(f);
    liveness.add(setLive);
    if (!socket) openSocket(token);
    return () => {
      listeners.delete(f);
      liveness.delete(setLive);
      if (listeners.size === 0 && socket) {
        socket.stop = true;
        clearTimeout(socket.retry);
        socket.ws?.close();
        socket = null;
      }
    };
  }, [token]);
  return live;
}

/** Collapse a burst of events into one call after a short pause. */
export function useDebounced(fn: () => void, ms = 350): () => void {
  const t = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => () => clearTimeout(t.current), []);
  return useCallback(() => {
    clearTimeout(t.current);
    t.current = setTimeout(() => f.current(), ms);
  }, [ms]);
}

export interface RoomState {
  detail: RoomDetail | null;
  lines: Line[];
  derived: Derived | null;
  requests: JoinRequest[];
  loading: boolean;
  error: string | null;
  live: boolean;
  /** What the device is doing on its own, said plainly while it runs. */
  chore: string | null;
  /**
   * The member list from the server checked against the room's record on QoreChain:
   * "ok" when the hash matches, "mismatch" when it does not (shown to the person), "unknown" while checking
   * or when there is nothing to check (someone no longer in the room).
   */
  chainCheck: "ok" | "mismatch" | "unknown";
  /** A token-bearing account for engine calls. */
  acct: () => Promise<Tokened>;
  reload: () => Promise<void>;
}

export function useRoom(roomId: string): RoomState {
  const { account, token } = useAccount();
  const [detail, setDetail] = useState<RoomDetail | null>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [requests, setRequests] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [chore, setChore] = useState<string | null>(null);
  const busy = useRef(false);
  const again = useRef(false);
  const choring = useRef(false);
  // A reload asked for while one runs is folded into one more pass.
  const pendingReload = useCallback(() => again.current, []);

  const acct = useCallback(async () => {
    if (!account) throw new Error("Unlock your account first.");
    return withToken(account, await token());
  }, [account, token]);

  const reload = useCallback(async () => {
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      do {
        again.current = false;
        const a = await acct();
        const r = await syncRoom(a, roomId);
        setDetail(r.detail);
        setLines(r.lines);
        setRequests(r.requests);
        setError(null);
      } while (pendingReload());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [acct, roomId, pendingReload]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const soon = useDebounced(() => void reload());
  const live = useRoomEvents((kind) => {
    if (kind === "room" || kind === "roomreq") soon();
  });

  const derived = useMemo(() => (detail ? derive(lines, detail.members, detail.epochs) : null), [detail, lines]);

  // The room list does not reopen the room that is open here; this screen hands it the summary.
  useEffect(() => {
    if (!derived || !detail) return;
    const last = [...derived.items].reverse().find((i) => i.type === "message");
    publishSummary(roomId, {
      lastSeq: derived.lastSeq.toString(),
      name: derived.info.name,
      type: derived.info.type,
      photo: derived.info.photo,
      preview: last?.type === "message" ? { author: last.author, text: snippetOf(last.body) } : null,
    });
  }, [derived, detail, roomId]);

  // Mark what is on screen as read.
  const lastSeq = derived?.lastSeq ?? 0n;
  useEffect(() => {
    if (lastSeq > 0n && detail?.me.status === "active") void acct().then((a) => markRead(a, roomId, lastSeq)).catch(() => undefined);
  }, [lastSeq, detail?.me.status, acct, roomId]);

  // Admin chores. They run once at a time and say what they are doing.
  useEffect(() => {
    if (!detail || !derived || choring.current) return;
    const admin = detail.me.status === "active" && (detail.me.role === "owner" || detail.me.role === "admin");
    if (!admin) return;
    const waitingAuto = detail.settings && !detail.settings.approval && requests.length > 0;
    if (!detail.needsRotation && !waitingAuto) return;
    choring.current = true;
    void (async () => {
      try {
        const a = await acct();
        if (detail.needsRotation) {
          setChore("Someone left. Changing the room key so they cannot read new messages…");
          await rotateAfterLeave(a, roomId);
        } else if (waitingAuto) {
          setChore(`Letting ${requests.length === 1 ? "1 person" : `${requests.length} people`} in from an invite link…`);
          await admitWaiting(a, roomId, derived.info.historyDefault);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setChore(null);
        choring.current = false;
        void reload();
      }
    })();
  }, [detail, derived, requests, acct, roomId, reload]);

  // Check the member list against QoreChain once per key period.
  const [chainCheck, setChainCheck] = useState<RoomState["chainCheck"]>("unknown");
  const checkedFor = useRef<string>("");
  useEffect(() => {
    if (detail?.me.status !== "active") {
      setChainCheck("unknown");
      return;
    }
    const active = detail.members.filter((m) => m.status === "active");
    const key = `${detail.epoch}:${active.map((m) => m.address).sort().join(",")}`;
    if (checkedFor.current === key) return;
    let alive = true;
    void readRoom(roomIdBytes32(roomId)).then(
      (c) => {
        if (!alive) return;
        // QoreChain is ahead when another admin's change has not reached this server yet: check again on the next refresh.
        if (c.epoch !== BigInt(detail.epoch)) return setChainCheck("unknown");
        checkedFor.current = key;
        setChainCheck(c.membershipHash === membershipHash(roomId, c.epoch, active) ? "ok" : "mismatch");
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [detail, roomId]);

  return { detail, lines, derived, requests, loading, error, live, chore, chainCheck, acct, reload };
}
