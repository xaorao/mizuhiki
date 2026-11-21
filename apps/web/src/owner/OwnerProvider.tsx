"use client";
/**
 * Everything the owner app shares: the published page, the sealed draft with
 * undo and redo, autosave, publish, and the content-blind stats. Edits apply
 * locally at once; the draft is sealed to the owner and saved 800 ms after the
 * last change; Publish signs the manifest and bumps its version.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseManifest, signRecord, type Manifest } from "@mizuhiki/core";
import { useAccount, type Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "@/lib/api";
import { draftFromManifest, differsFromPublished, loadDraft, publishable, saveDraft, type Draft } from "@/editor/state";
import { blockProblem } from "@/editor/blocks";
import { ownedPasses, periodKeysOf } from "@/passes/engine";
import type { OfflineKey } from "@/passes/model";
import { forgetPassKeys } from "@/lib/passKeys";
import { failureText } from "@/lib/failure";

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
  /** Try the first load again (after it failed: offline, Mizuhiki unreachable). */
  reload: () => void;
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
  /** Re-sign the live page with the live passes' keys (spec 5.12). */
  publishPassKeys: () => Promise<void>;
  /** Move the live page to another of the account's names (Settings › Names). */
  renamePage: (name: string) => Promise<void>;
  publishing: boolean;
  stats: Stats | null;
  refreshStats: () => void;
  token: () => Promise<string>;
}

const Ctx = createContext<OwnerCtx | null>(null);
const HISTORY = 100;

export function OwnerProvider({ account, children }: { account: Account; children: ReactNode }) {
  const acct = useAccount();
  const [published, setPublishedState] = useState<Manifest | null>(null);
  // The newest published page this device knows, read by publish() without waiting for a render.
  const publishedRef = useRef<Manifest | null>(null);
  const setPublished = useCallback((m: Manifest | null) => {
    publishedRef.current = m;
    setPublishedState(m);
  }, []);
  // One publish at a time: a second call waits for the first, then numbers itself after it.
  const publishing$ = useRef<Promise<void> | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => {
    setLoadError(null);
    setLoading(true);
    setAttempt((n) => n + 1);
  }, []);
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

  // Load once per account. The token function changes identity whenever the account context re-renders
  // (a token refresh, say); re-running this would reload an older saved draft over edits made since.
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const refreshRef = useRef(refreshStats);
  refreshRef.current = refreshStats;
  const accountKey = account.owner.address;
  useEffect(() => {
    const life = { alive: true };
    void (async () => {
      try {
        const t = await tokenRef.current();
        const own = await api.get<{ page: { record: { body: Manifest } } | null }>("/owner/page", { token: t });
        const pub = own.page?.record.body ?? null;
        const d = await loadDraft(account, t).catch(() => null);
        if (!life.alive) return;
        setPublished(pub);
        if (d) setDraft(d);
        else if (pub) setDraft(draftFromManifest(pub));
        else setLoadError("This account has no page yet. Finish sign-up first.");
      } catch (e) {
        if (life.alive) setLoadError(failureText(e, "Could not open your page."));
      } finally {
        if (life.alive) setLoading(false);
      }
    })();
    refreshRef.current();
    return () => {
      life.alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately once per account; see above.
  }, [accountKey, setPublished, attempt]);

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
      // History is kept here, not inside a state updater: updaters must be pure (React runs them twice in
      // development), and doing it there once doubled undo steps. `latest` is updated at once so two edits before
      // the next render each build on the one before.
      const cur = latest.current;
      if (!cur) return;
      const next = fn(cur);
      if (next === cur) return;
      // Typing in one field within 1.2 s is one undo step.
      const now = Date.now();
      const c = opts?.coalesce;
      const merge = c && lastCoalesce.current?.key === c && now - lastCoalesce.current.at < 1200;
      if (!merge) {
        past.current = [...past.current.slice(-HISTORY + 1), cur];
        future.current = [];
      }
      lastCoalesce.current = c ? { key: c, at: now } : null;
      latest.current = next;
      setDraft(next);
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
    latest.current = prev;
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
    latest.current = nxt;
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

  const livePeriodKeys = useCallback(
    async (t: string) => {
      forgetPassKeys(account.owner.address);
      const [{ passes }, rec] = await Promise.all([
        ownedPasses({ ...account, token: t }),
        api.get<{ settings: { offlineKey: OfflineKey | null } }>("/owner/recovery", { token: t }),
      ]);
      return periodKeysOf(account, passes, Date.now(), rec.settings.offlineKey);
    },
    [account],
  );

  const publishDraft = useCallback(
    async (t: string, d: Draft) => {
      const body: Manifest = publishable(
        {
          ...d.manifest,
          // Always the live passes' keys, so a page publish never brings back a revoked one.
          periodKeys: await livePeriodKeys(t),
          version: Math.max(d.manifest.version, publishedRef.current?.version ?? 0) + 1,
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
      const next = {
        ...d,
        manifest: { ...d.manifest, periodKeys: body.periodKeys, version: body.version, updatedAt: body.updatedAt },
      };
      setDraft(next);
      latest.current = next;
      await saveDraft(account, t, next);
      setSave("saved");
    },
    [account, setPublished, livePeriodKeys],
  );

  /**
   * The page was published elsewhere (another tab or device) since this tab loaded it. Take the newer page as the
   * base and keep this tab's draft, adding any block this tab has never seen (one added from the other tab), so a
   * publish from here never silently drops work done there.
   */
  const rebaseOnLive = useCallback(
    async (t: string, d: Draft): Promise<Draft | null> => {
      const own = await api.get<{ page: { record: { body: Manifest } } | null }>("/owner/page", { token: t });
      const live = own.page?.record.body ?? null;
      if (!live) return null;
      const known = new Set([...d.manifest.blocks, ...(publishedRef.current?.blocks ?? [])].map((b) => b.id));
      const arrived = live.blocks.filter((b) => !known.has(b.id));
      setPublished(live);
      const next = { ...d, manifest: { ...d.manifest, blocks: [...d.manifest.blocks, ...arrived] } };
      setDraft(next);
      latest.current = next;
      return next;
    },
    [setPublished],
  );

  const publishOnce = useCallback(async () => {
    const first = latest.current;
    if (!first) return;
    setPublishing(true);
    try {
      const t = await token();
      let d = first;
      for (let attempt = 0; ; attempt++) {
        try {
          await publishDraft(t, d);
          return;
        } catch (e) {
          if (attempt > 0 || !(e instanceof ApiFailure) || e.code !== "STALE_VERSION") throw e;
          const rebased = await rebaseOnLive(t, d);
          if (!rebased) throw e;
          d = rebased;
        }
      }
    } finally {
      setPublishing(false);
    }
  }, [token, rebaseOnLive, publishDraft]);

  /** Re-sign the live page with the current pass keys only; unpublished page edits stay in the draft. */
  /** Re-sign the live page with the current pass keys (and, from Settings › Names, a new name) only. */
  const publishKeysOnce = useCallback(
    async (rename?: string) => {
      const live = publishedRef.current;
      if (!live) return;
      const t = await token();
      const d = latest.current;
      const body: Manifest = parseManifest({
        ...live,
        ...(rename ? { name: rename } : {}),
        periodKeys: await livePeriodKeys(t),
        version: Math.max(live.version, d?.manifest.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      });
      const record = signRecord({
        kind: "manifest",
        body,
        signer: account.owner.address,
        classical: account.keys.classical,
        pq: account.keys.pq,
      });
      await api.put("/pages", { record }, { token: t });
      setPublished(body);
      if (d) {
        const next = {
          ...d,
          manifest: {
            ...d.manifest,
            name: body.name,
            periodKeys: body.periodKeys,
            version: body.version,
            updatedAt: body.updatedAt,
          },
        };
        setDraft(next);
        latest.current = next;
        await saveDraft(account, t, next);
      }
    },
    [account, token, setPublished, livePeriodKeys],
  );

  // Page publishes and pass-key publishes run one at a time, in order.
  const serial = useCallback(async (job: () => Promise<void>) => {
    const before = publishing$.current;
    const run = (before ?? Promise.resolve()).catch(() => undefined).then(job);
    publishing$.current = run;
    try {
      await run;
    } finally {
      if (publishing$.current === run) publishing$.current = null;
    }
  }, []);
  const publish = useCallback(() => serial(publishOnce), [serial, publishOnce]);
  const publishPassKeys = useCallback(() => serial(() => publishKeysOnce()), [serial, publishKeysOnce]);
  const renamePage = useCallback((name: string) => serial(() => publishKeysOnce(name)), [serial, publishKeysOnce]);

  const value = useMemo<OwnerCtx>(
    () => ({
      account,
      loading,
      loadError,
      reload,
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
      publishPassKeys,
      renamePage,
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
      reload,
      published,
      draft,
      edit,
      undo,
      redo,
      save,
      publish,
      publishPassKeys,
      renamePage,
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

/**
 * The parts of the owner context that never change while the account is unlocked: the account, a session
 * token getter and the page re-signers. Screens that only need these use this, so their loaders do not run
 * again (and overwrite fresh edits) every time the page draft, stats or publishing state change.
 */
export function useOwnerSession(): Pick<OwnerCtx, "account" | "token" | "publishPassKeys" | "renamePage"> {
  const { account, token, publishPassKeys, renamePage } = useOwner();
  return useMemo(
    () => ({ account, token, publishPassKeys, renamePage }),
    [account, token, publishPassKeys, renamePage],
  );
}
