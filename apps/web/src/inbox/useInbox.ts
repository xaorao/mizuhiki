"use client";
/**
 * Inbox state: the metadata index from the API, the items opened on this
 * device (kept in an encrypted local cache so search is local and reopening
 * is instant), sender checks done here against QoreChain, and a live socket
 * that only says "something new arrived".
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { verifyRecord, isMizuhikiError, type Signed } from "@mizuhiki/core";
import { pqKeyViaEvm } from "@mizuhiki/chain";
import type { Account } from "@/account/AccountProvider";
import { API_URL, api, ApiFailure } from "@/lib/api";
import { openRow, readCache, writeCache, type InboxRow, type Opened } from "./model";

export type Box = "inbox" | "archived" | "sent";
export type OpenState =
  { state: "idle" } | { state: "opening" } | { state: "open"; item: Opened } | { state: "failed"; reason: string };
export type SenderCheck = "none" | "checking" | "verified" | "failed";

export function openFailure(e: unknown): string {
  if (isMizuhikiError(e, "NOT_A_READER")) return "This was not sealed to your key, so it cannot be opened here.";
  if (isMizuhikiError(e, "TAMPERED")) return "This item was changed after it was sealed. It was not opened.";
  if (e instanceof ApiFailure && e.status === 404)
    return "The sealed copy has expired or was deleted. Anything on chain is still there.";
  if (e instanceof ApiFailure) return e.message;
  return "It could not be opened on this device. Nothing was changed.";
}

export function useInbox(account: Account, token: () => Promise<string>, onChanged: () => void) {
  const [box, setBox] = useState<Box>("inbox");
  const [rows, setRows] = useState<InboxRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<Record<string, Opened>>({});
  const [states, setStates] = useState<Record<string, OpenState>>({});
  const [checks, setChecks] = useState<Record<string, SenderCheck>>({});
  const [live, setLive] = useState(false);
  const cacheReady = useRef(false);
  const openedRef = useRef(opened);
  openedRef.current = opened;

  const load = useCallback(
    async (which: Box = box) => {
      try {
        const t = await token();
        const r = await api.get<{ rows: InboxRow[] }>(`/owner/inbox?box=${which}`, { token: t });
        setRows(r.rows);
        setError(null);
      } catch (e) {
        setError(e instanceof ApiFailure ? e.message : "The inbox could not be loaded. Nothing was changed.");
      }
    },
    [box, token],
  );

  useEffect(() => {
    setRows(null);
    void load(box);
  }, [box, load]);

  useEffect(() => {
    void readCache(account).then((c) => {
      cacheReady.current = true;
      setOpened((o) => ({ ...c, ...o }));
    });
  }, [account]);

  // Live updates: the socket carries no content, only "new".
  useEffect(() => {
    let ws: WebSocket | null = null;
    let stop = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      const t = await token().catch(() => null);
      if (stop || !t) return;
      ws = new WebSocket(`${API_URL.replace(/^http/, "ws")}/owner/events`);
      ws.onopen = () => ws?.send(t);
      ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data)) as { type: string };
        if (msg.type === "ready") setLive(true);
        if (msg.type === "new") {
          void load();
          onChanged();
        }
      };
      ws.onclose = () => {
        setLive(false);
        if (!stop) retry = setTimeout(() => void connect(), 5000);
      };
    };
    void connect();
    return () => {
      stop = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, [token, load, onChanged]);

  const remember = useCallback(
    (hash: string, item: Opened) => {
      setOpened((o) => {
        const next = { ...o, [hash]: item };
        if (cacheReady.current) void writeCache(account, next).catch(() => undefined);
        return next;
      });
    },
    [account],
  );

  const checkSender = useCallback(
    async (row: InboxRow) => {
      const sig = row.senderSig as Signed<{ envelope: string; to: string; at: string }> | null;
      if (!sig || !row.envelope) {
        setChecks((c) => ({ ...c, [row.id]: "none" }));
        return;
      }
      setChecks((c) => ({ ...c, [row.id]: "checking" }));
      try {
        const to = row.to?.address ?? account.owner.address;
        if (sig.body.envelope !== row.envelope || sig.body.to !== to) throw new Error("signature is for another item");
        const pq = await pqKeyViaEvm(sig.signer);
        if (!pq.registered || !pq.publicKey || !pq.possessionProven) throw new Error("no key on chain");
        verifyRecord(sig, { kind: "sender", signer: sig.signer, pqPublicKey: pq.publicKey });
        setChecks((c) => ({ ...c, [row.id]: "verified" }));
      } catch {
        setChecks((c) => ({ ...c, [row.id]: "failed" }));
      }
    },
    [account.owner.address],
  );

  const open = useCallback(
    async (row: InboxRow) => {
      void checkSender(row);
      if (!row.envelope) return;
      const hash = row.envelope;
      const cached = openedRef.current[hash];
      if (cached) setStates((s) => ({ ...s, [row.id]: { state: "open", item: cached } }));
      else {
        setStates((s) => ({ ...s, [row.id]: { state: "opening" } }));
        try {
          const item = await openRow(account, row);
          remember(hash, item);
          setStates((s) => ({ ...s, [row.id]: { state: "open", item } }));
        } catch (e) {
          setStates((s) => ({ ...s, [row.id]: { state: "failed", reason: openFailure(e) } }));
          return;
        }
      }
      if (!row.read && box !== "sent") {
        setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, read: true } : r)) ?? rs);
        const t = await token();
        await api.patch(`/owner/inbox/${hash}`, { read: true }, { token: t }).catch(() => undefined);
        onChanged();
      }
    },
    [account, box, checkSender, remember, token, onChanged],
  );

  const setFlag = useCallback(
    async (row: InboxRow, flag: { read?: boolean; archived?: boolean }) => {
      if (!row.envelope) return;
      const t = await token();
      await api.patch(`/owner/inbox/${row.envelope}`, flag, { token: t });
      if (flag.archived !== undefined) setRows((rs) => rs?.filter((r) => r.id !== row.id) ?? rs);
      else setRows((rs) => rs?.map((r) => (r.id === row.id ? { ...r, ...flag } : r)) ?? rs);
      onChanged();
    },
    [token, onChanged],
  );

  // Replies you sent, to show under the item they answer (they are sealed to you too).
  const [sent, setSent] = useState<InboxRow[]>([]);
  const loadSent = useCallback(async () => {
    const t = await token();
    const r = await api
      .get<{ rows: InboxRow[] }>("/owner/inbox?box=sent&limit=200", { token: t })
      .catch(() => ({ rows: [] }));
    setSent(r.rows);
  }, [token]);
  useEffect(() => {
    void loadSent();
  }, [loadSent]);
  const sentFor = useCallback(
    (row: InboxRow) => (row.envelope ? sent.filter((r) => r.ref === `re:${row.envelope ?? ""}`) : []),
    [sent],
  );

  return {
    box,
    setBox,
    rows,
    error,
    reload: load,
    opened,
    states,
    checks,
    open,
    setFlag,
    live,
    sentFor,
    loadSent,
    remember,
  };
}
