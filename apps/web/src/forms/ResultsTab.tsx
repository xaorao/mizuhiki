"use client";
/**
 * Results (spec 5.9, "owner, all in the browser"). The server gives plain
 * counters it can keep without reading anything (views, starts, submissions,
 * time, how far people got) and the list of sealed answers. Every answer is
 * opened here with the owner's key and kept in memory only; the summary, the
 * table, search, filters, tags (sealed to the owner), exports and snapshots
 * are all worked out on this device.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  Button,
  CopyValue,
  EmptyState,
  Icon,
  Oops,
  Panel,
  ProgressRing,
  Segmented,
  Sheet,
  Skeleton,
} from "@mizuhiki/ui";
import { ApiFailure } from "@/lib/api";
import { pageUrl } from "@/lib/site";
import type { TabProps } from "./tabTypes";
import {
  buildTable,
  earlierKeys,
  funnel,
  localStamp,
  matches,
  resultQuestions,
  summarize,
  type Filter,
  type FormStats,
  type OpenedResponse,
  type TableModel,
} from "./results/aggregate";
import { fetchStats, openResponses, type FailedResponse } from "./results/open";
import { readTags, saveTags, type TagMap } from "./results/tags";
import type { Snapshot } from "./results/schema";
import { CounterTiles, Funnel, SummaryList } from "./results/Summary";
import { FilterBar, ResponsesTable } from "./results/Responses";
import { ResponseDetail } from "./results/ResponsePanel";
import { ExportSheet, SnapshotSheet } from "./results/Dialogs";
import { SharedSnapshots } from "./results/SharedSnapshots";
import {
  deleteSnapshot,
  listSnapshots,
  readSeeds,
  shareSnapshot,
  type SeedMap,
  type SnapshotRow,
} from "./results/snapshot";
import s from "./results.module.css";

type Phase =
  { s: "loading" } | { s: "failed"; why: string } | { s: "opening"; done: number; total: number } | { s: "ready" };

type TagState = "loading" | "ready" | "saving" | "saved" | "failed" | "unavailable";
const TAG_LABEL: Record<TagState, string> = {
  loading: "Opening your tags…",
  ready: "Sealed to you",
  saving: "Saving, sealed to you…",
  saved: "Saved, sealed to you",
  failed: "Not saved. Change a tag to try again.",
  unavailable: "Your tags could not be opened, so they cannot be changed right now.",
};

/** Snapshots carry at most this many text answers per question. */
const SNAPSHOT_TEXTS = 200;

const narrowQuery = "(max-width: 959px)";
function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(narrowQuery);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(narrowQuery).matches,
    () => false,
  );
}

export function ResultsTab(props: TabProps) {
  const { def, account, published, ownerName } = props;
  const formId = def.id;
  const source = published ?? def;
  const questions = useMemo(() => resultQuestions(def, published), [def, published]);
  const narrow = useNarrow();

  // The token getter may be a new function on every render of the editor: keep the latest in a ref.
  const tokenRef = useRef(props.token);
  useEffect(() => {
    tokenRef.current = props.token;
  }, [props.token]);

  const [nonce, setNonce] = useState(0);
  const [phase, setPhase] = useState<Phase>({ s: "loading" });
  const [stats, setStats] = useState<FormStats | null>(null);
  const [opened, setOpened] = useState<OpenedResponse[]>([]);
  const [failed, setFailed] = useState<FailedResponse[]>([]);
  const [tags, setTags] = useState<TagMap>({});
  const [tagState, setTagState] = useState<TagState>("loading");
  const [snaps, setSnaps] = useState<SnapshotRow[] | null>(null);
  const [snapsFailed, setSnapsFailed] = useState(false);
  const [seeds, setSeeds] = useState<SeedMap>({});

  const [view, setView] = useState<"summary" | "responses">("summary");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const live = () => !ctrl.signal.aborted;
    setPhase({ s: "loading" });
    setTagState("loading");
    setSnaps(null);
    setSnapsFailed(false);
    void (async () => {
      try {
        const token = await tokenRef.current();
        const st = await fetchStats(formId, token, ctrl.signal);
        if (!live()) return;
        setStats(st);
        listSnapshots(token, formId, ctrl.signal).then(
          (rows) => {
            if (live()) setSnaps(rows);
          },
          () => {
            if (live()) setSnapsFailed(true);
          },
        );
        readSeeds(account, token, formId).then(
          (m) => {
            if (live()) setSeeds(m);
          },
          () => undefined,
        );
        readTags(account, token, formId).then(
          (m) => {
            if (!live()) return;
            setTags(m);
            setTagState("ready");
          },
          () => {
            if (live()) setTagState("unavailable");
          },
        );
        setPhase({ s: "opening", done: 0, total: st.responses.length });
        const r = await openResponses({
          account,
          formId,
          list: st.responses,
          signal: ctrl.signal,
          onProgress: (done, total) => {
            if (live()) setPhase({ s: "opening", done, total });
          },
        });
        if (!live()) return;
        setOpened(r.opened);
        setFailed(r.failed);
        setPhase({ s: "ready" });
      } catch (e) {
        if (!live()) return;
        setPhase({
          s: "failed",
          why: e instanceof ApiFailure ? e.message : "Your results could not be loaded. Nothing was changed.",
        });
      }
    })();
    return () => ctrl.abort();
  }, [account, formId, nonce]);

  // ---- tags: sealed to the owner, saved a moment after the last change ----
  const pending = useRef<TagMap | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const flush = useCallback(() => {
    clearTimeout(timer.current);
    const m = pending.current;
    if (!m) return;
    pending.current = null;
    chain.current = chain.current
      .then(() => saveTags(account, formId, m))
      .then(
        () => setTagState(pending.current ? "saving" : "saved"),
        () => setTagState("failed"),
      );
  }, [account, formId]);
  useEffect(() => flush, [flush]);
  const tagsEditable = tagState !== "loading" && tagState !== "unavailable";
  const setResponseTags = (hash: string, list: string[]) => {
    if (!tagsEditable) return;
    const next = { ...tags, [hash]: list };
    setTags(next);
    pending.current = next;
    setTagState("saving");
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 1200);
  };

  // ---- derived views ----
  const summary = useMemo(() => summarize(questions, opened), [questions, opened]);
  const earlier = useMemo(() => earlierKeys(questions, opened), [questions, opened]);
  const screen = useMemo(
    () => buildTable({ questions, responses: opened, endings: source.endings, tags, forFile: false }),
    [questions, opened, source.endings, tags],
  );
  const shownSet = useMemo(() => {
    const byHash = new Map(screen.rows.map((r) => [r.hash, r.cells.join(" ")]));
    return new Set(
      opened
        .filter((r) => matches({ response: r, questions, filters, search, haystack: byHash.get(r.hash) ?? "" }))
        .map((r) => r.hash),
    );
  }, [opened, questions, filters, search, screen]);
  const shownTable: TableModel = useMemo(
    () => ({ columns: screen.columns, rows: screen.rows.filter((r) => shownSet.has(r.hash)) }),
    [screen, shownSet],
  );
  const funnelRows = useMemo(() => (stats ? funnel(questions, stats) : []), [questions, stats]);

  const pick = (onlyShown: boolean) => (onlyShown ? opened.filter((r) => shownSet.has(r.hash)) : opened);
  const fileTable = (onlyShown: boolean) =>
    buildTable({ questions, responses: pick(onlyShown), endings: source.endings, tags, forFile: true });
  const makeSnapshot = (o: { table: boolean; onlyShown: boolean; ownerOnly: boolean }): Snapshot => {
    const rs = pick(o.onlyShown);
    const t = buildTable({
      questions,
      responses: rs,
      endings: source.endings,
      tags: o.ownerOnly ? tags : {},
      forFile: true,
    });
    const keep = t.columns.map((c, i) => ({ c, i })).filter((x) => o.ownerOnly || x.c.key !== "@tags");
    const sum = summarize(questions, rs).map((q) =>
      o.ownerOnly
        ? q
        : q.type === "texts"
          ? { ...q, latest: q.latest.slice(0, SNAPSHOT_TEXTS) }
          : q.type === "bars"
            ? { ...q, others: q.others.slice(0, SNAPSHOT_TEXTS) }
            : q,
    );
    return {
      v: 1,
      kind: "form-snapshot",
      formId,
      title: source.title,
      description: source.description,
      createdAt: new Date().toISOString(),
      responses: rs.length,
      counters: {
        views: stats?.views ?? 0,
        starts: stats?.starts ?? 0,
        submissions: stats?.submissions ?? 0,
        secondsTotal: stats?.secondsTotal ?? 0,
      },
      summary: sum,
      table: o.table
        ? { columns: keep.map((x) => x.c.label), rows: t.rows.map((r) => keep.map((x) => String(r.cells[x.i] ?? ""))) }
        : null,
    };
  };

  // ---- shared snapshots ----
  const shareNow = async (withTable: boolean) => {
    const snap = makeSnapshot({ table: withTable, onlyShown: false, ownerOnly: false });
    const r = await shareSnapshot({ account, token: await tokenRef.current(), snap, seeds });
    setSeeds(r.seeds);
    setSnaps((rows) => [
      { hash: r.hash, formId, title: snap.title.slice(0, 200), createdAt: new Date().toISOString() },
      ...(rows ?? []).filter((x) => x.hash !== r.hash),
    ]);
    setSnapsFailed(false);
    return { link: r.link, seedsSaved: r.seedsSaved };
  };
  const deleteNow = async (hash: string) => {
    const next = await deleteSnapshot({ account, token: await tokenRef.current(), formId, hash, seeds });
    setSeeds(next);
    setSnaps((rows) => (rows ?? []).filter((x) => x.hash !== hash));
  };

  // ---- selection ----
  const order = shownTable.rows.map((r) => r.hash);
  const selIndex = sel ? order.indexOf(sel) : -1;
  const selected = sel ? opened.find((r) => r.hash === sel) : undefined;
  const detail = selected ? (
    <ResponseDetail
      r={selected}
      index={opened.length - [...opened].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).indexOf(selected)}
      questions={questions}
      earlier={earlier}
      def={source}
      tags={tags[selected.hash] ?? []}
      onTags={(t) => setResponseTags(selected.hash, t)}
      saving={TAG_LABEL[tagState]}
      tagsDisabled={!tagsEditable}
      onPrev={selIndex > 0 ? () => setSel(order[selIndex - 1] ?? null) : null}
      onNext={selIndex >= 0 && selIndex < order.length - 1 ? () => setSel(order[selIndex + 1] ?? null) : null}
    />
  ) : null;

  const formLink = published ? `${pageUrl(ownerName)}/f/${published.slug}` : null;
  const total = stats?.responses.length ?? 0;
  const ready = phase.s === "ready";

  return (
    <div className={s.wrap}>
      <header className={s.head}>
        <div>
          <p className={s.kicker} lang="ja">
            結果
          </p>
          <h2 className={s.h2}>Results</h2>
          <p className={s.note}>Opened on this device with your key. Mizuhiki cannot read these answers.</p>
        </div>
        <div className={s.headActions}>
          <Button
            variant="ghost"
            size="sm"
            icon="undo"
            onClick={() => setNonce((n) => n + 1)}
            disabled={phase.s === "loading" || phase.s === "opening"}
          >
            Refresh
          </Button>
          <Button
            variant="line"
            size="sm"
            icon="download"
            onClick={() => setExporting(true)}
            disabled={!ready || !opened.length}
          >
            Download
          </Button>
          <Button
            variant="cord"
            size="sm"
            icon="share"
            onClick={() => setSharing(true)}
            disabled={!ready || !opened.length}
          >
            Share a snapshot
          </Button>
        </div>
      </header>

      {phase.s === "failed" ? (
        <Oops
          title="Your results did not load"
          action={
            <Button variant="line" size="sm" onClick={() => setNonce((n) => n + 1)}>
              Try again
            </Button>
          }
        >
          {phase.why}
        </Oops>
      ) : null}

      <Panel
        title="At a glance"
        action={
          <span className={s.blind}>
            <Icon name="shield" size={14} /> Counted without reading answers
          </span>
        }
      >
        {stats ? (
          <>
            <CounterTiles counters={stats} />
            <Funnel rows={funnelRows} hasLogic={source.logic.length > 0} />
          </>
        ) : phase.s === "failed" ? (
          <p className={s.quiet}>The counters could not be loaded.</p>
        ) : (
          <Skeleton lines={3} height={110} />
        )}
      </Panel>

      {phase.s === "opening" && phase.total > 0 ? (
        <div className={s.opening} role="status">
          <ProgressRing done={phase.done} total={phase.total} />
          <div>
            <b>Opening answers on this device…</b>
            <small>
              {phase.done} of {phase.total} opened with your key. They stay in this tab only.
            </small>
          </div>
        </div>
      ) : null}

      {ready && failed.length ? (
        <details className={s.failures}>
          <summary>
            <Icon name="alert" size={15} /> {failed.length} answer{failed.length === 1 ? "" : "s"} could not be opened
            here
          </summary>
          <ul>
            {failed.map((f) => (
              <li key={f.hash}>
                <time dateTime={f.at}>{localStamp(f.at)}</time> <span>{f.why}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {ready && total === 0 ? (
        <EmptyState title="No answers yet" jp="まだだよ" face="sleepy">
          {formLink ? (
            <>
              Share your form, and answers will appear here, opened only on your devices.
              <span className={s.emptyLink}>
                <CopyValue value={formLink} label="form link" />
              </span>
            </>
          ) : (
            "Publish your form and share its link. Answers will appear here, opened only on your devices."
          )}
        </EmptyState>
      ) : null}

      {phase.s === "loading" || (phase.s === "opening" && total > 0) ? <Skeleton lines={5} /> : null}

      {ready && opened.length > 0 ? (
        <>
          <Segmented
            label="Results view"
            value={view}
            onChange={(v) => {
              setView(v);
              setSel(null);
            }}
            options={[
              { value: "summary", label: "Summary" },
              { value: "responses", label: `Responses (${opened.length})` },
            ]}
          />
          {view === "summary" ? (
            <SummaryList summary={summary} />
          ) : (
            <div className={[s.responses, selected && !narrow ? s.withPanel : ""].join(" ")}>
              <div className={s.responsesMain}>
                <FilterBar
                  questions={questions}
                  filters={filters}
                  onFilters={setFilters}
                  search={search}
                  onSearch={setSearch}
                  shown={shownTable.rows.length}
                  total={opened.length}
                />
                {shownTable.rows.length ? (
                  <ResponsesTable table={shownTable} selected={sel} onSelect={setSel} />
                ) : (
                  <p className={s.quiet}>No responses match. Change the search or the filters.</p>
                )}
              </div>
              {selected && !narrow ? (
                <aside className={s.side} aria-label="Response">
                  <div className={s.sideHead}>
                    <b>Response</b>
                    <Button variant="ghost" size="sm" icon="x" onClick={() => setSel(null)}>
                      Close
                    </Button>
                  </div>
                  {detail}
                </aside>
              ) : null}
            </div>
          )}
        </>
      ) : null}

      {ready ? <SharedSnapshots rows={snaps} seeds={seeds} failed={snapsFailed} onDelete={deleteNow} /> : null}

      {narrow ? (
        <Sheet open={!!selected} onClose={() => setSel(null)} title="Response" wide>
          {detail}
        </Sheet>
      ) : null}

      <ExportSheet
        open={exporting}
        onClose={() => setExporting(false)}
        title={source.title}
        allCount={opened.length}
        shownCount={shownTable.rows.length}
        table={fileTable}
        snapshot={(onlyShown) => makeSnapshot({ table: true, onlyShown, ownerOnly: true })}
      />
      <SnapshotSheet open={sharing} onClose={() => setSharing(false)} count={opened.length} onShare={shareNow} />
    </div>
  );
}
