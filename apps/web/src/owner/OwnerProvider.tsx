"use client";
/**
 * Everything the owner app shares: the published page, the sealed draft with
 * undo and redo, autosave, publish, and the content-blind stats. Edits apply
 * locally at once; the draft is sealed to the owner and saved 800 ms after the
 * last change; Publish signs the manifest and bumps its version.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { signRecord, type Manifest } from "@mizuhiki/core";
import { useAccount, type Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import { draftFromManifest, differsFromPublished, loadDraft, publishable, saveDraft, type Draft } from "@/editor/state";
import { blockProblem } from "@/editor/blocks";

export type SaveState = "idle" | "saving" | "saved" | "offline" | "error";

export interface Stats {
  views: { week: number; previousWeek: number };
  taps: Record<string, number>;
  items: Record<string, { count: number; unread: number }>;
  paid: { denom: string; total: string; count: number }[];
}

interface OwnerCtx {
  account: Account;
  loading: boolean;
  loadError: string | null;
  published: Manifest | null;
  draft: Draft | null;
  /** Apply a change (pushes undo history, schedules a sealed save). */
  edit: (fn: (d: Draft) => Draft, opts?: { coalesce?: string }) => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
  save: SaveState;
  publish: () => Promise<void>;
  publishing: boolean;
  stats: Stats | null;
  refreshStats: () => void;
  token: () => Promise<string>;
}

const Ctx = createContext<OwnerCtx | null>(null);
const HISTORY = 100;

export function OwnerProvider({ account, children }: { account: Account; children: ReactNode }) {
  const acct = useAccount();
  const [published, setPublished] = useState<Manifest | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>("idle");
  const [publishing, setPublishing] = useState(false);
  const [stats, setStats] = useState<Stats | null>(null);
  const past = useRef<Draft[]>([]);
  const future = useRef<Draft[]>([]);
  const lastCoalesce = useRef<{ key: string; at: number } | null>(null);
  const [, bump] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<Draft | null>(null);
  latest.current = draft;

  const token = useCallback(async () => {
    try {
      return await acct.token();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) acct.dropToken();
      throw e;
    }
  }, [acct]);

  const refreshStats = useCallback(() => {
    void token()
      .then((t) => api.get<Stats>("/owner/stats", { token: t }))
      .then(setStats)
      .catch(() => undefined);
  }, [token]);

  useEffect(() => {
    const life = { alive: true };
    void (async () => {
      try {
        const t = await token();
        const own = await api.get<{ page: { record: { body: Manifest } } | null }>("/owner/page", { token: t });
        const pub = own.page?.record.body ?? null;
        const d = await loadDraft(account, t).catch(() => null);
        if (!life.alive) return;
        setPublished(pub);
        if (d) setDraft(d);
        else if (pub) setDraft(draftFromManifest(pub));
        else setLoadError("This account has no page yet. Finish sign-up first.");
      } catch (e) {
        if (life.alive) setLoadError(e instanceof ApiFailure ? e.message : "Could not open your page.");
      } finally {
        if (life.alive) setLoading(false);
      }
    })();
    refreshStats();
    return () => {
      life.alive = false;
    };
  }, [account, token, refreshStats]);

  const persist = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const d = latest.current;
      if (!d) return;
      setSave("saving");
      void token()
        .then((t) => saveDraft(account, t, { ...d, savedAt: new Date().toISOString() }))
        .then(() => setSave("saved"))
        .catch((e: unknown) => setSave(e instanceof ApiFailure && e.code === "OFFLINE" ? "offline" : "error"));
    }, 800);
  }, [account, token]);

  // Retry a failed or offline save when the connection returns.
  useEffect(() => {
    const on = () => {
      if (save === "offline" || save === "error") persist();
    };
    addEventListener("online", on);
    return () => removeEventListener("online", on);
  }, [save, persist]);

  const edit = useCallback(
    (fn: (d: Draft) => Draft, opts?: { coalesce?: string }) => {
      setDraft((cur) => {
        if (!cur) return cur;
        const next = fn(cur);
        if (next === cur) return cur;
        // Typing in one field within 1.2 s is one undo step.
        const now = Date.now();
        const c = opts?.coalesce;
        const merge = c && lastCoalesce.current?.key === c && now - lastCoalesce.current.at < 1200;
        if (!merge) {
          past.current = [...past.current.slice(-HISTORY + 1), cur];
          future.current = [];
        }
        lastCoalesce.current = c ? { key: c, at: now } : null;
        return next;
      });
      bump((x) => x + 1);
      persist();
    },
    [persist],
  );

  const undo = useCallback(() => {
    const prev = past.current.at(-1);
    if (!prev || !latest.current) return;
    past.current = past.current.slice(0, -1);
    future.current = [latest.current, ...future.current];
    lastCoalesce.current = null;
    setDraft(prev);
    bump((x) => x + 1);
    persist();
  }, [persist]);

  const redo = useCallback(() => {
    const nxt = future.current[0];
    if (!nxt || !latest.current) return;
    future.current = future.current.slice(1);
    past.current = [...past.current, latest.current];
    lastCoalesce.current = null;
    setDraft(nxt);
    bump((x) => x + 1);
    persist();
  }, [persist]);

  // Keyboard: Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z (not while typing in a field, where the browser's own undo applies).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [undo, redo]);

  const publish = useCallback(async () => {
    const d = latest.current;
    if (!d) return;
    setPublishing(true);
    try {
      const t = await token();
      const body: Manifest = publishable(
        {
          ...d.manifest,
          version: Math.max(d.manifest.version, published?.version ?? 0) + 1,
          updatedAt: new Date().toISOString(),
        },
        blockProblem,
      );
      const record = signRecord({
        kind: "manifest",
        body,
        signer: account.owner.address,
        classical: account.keys.classical,
        pq: account.keys.pq,
      });
      await api.put("/pages", { record }, { token: t });
      setPublished(body);
      // Keep unfinished blocks in the draft; only the version moves.
      const next = { ...d, manifest: { ...d.manifest, version: body.version, updatedAt: body.updatedAt } };
      setDraft(next);
      latest.current = next;
      await saveDraft(account, t, next);
      setSave("saved");
    } finally {
      setPublishing(false);
    }
  }, [account, token, published]);

  const value = useMemo<OwnerCtx>(
    () => ({
      account,
      loading,
      loadError,
      published,
      draft,
      edit,
      undo,
      redo,
      canUndo: past.current.length > 0,
      canRedo: future.current.length > 0,
      dirty: draft ? differsFromPublished(draft, published, blockProblem) : false,
      save,
      publish,
      publishing,
      stats,
      refreshStats,
      token,
    }),
    // past/future lengths change with `draft`, which is a dependency.
    [
      account,
      loading,
      loadError,
      published,
      draft,
      edit,
      undo,
      redo,
      save,
      publish,
      publishing,
      stats,
      refreshStats,
      token,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useOwner(): OwnerCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useOwner needs <OwnerProvider>");
  return c;
}
