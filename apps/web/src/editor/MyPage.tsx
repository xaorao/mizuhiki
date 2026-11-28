"use client";
/**
 * My page (spec 5.3): the editor. Top bar with the Draft badge, undo and redo,
 * View and Publish; content-blind stats; the setup checklist; the block list
 * with drag to reorder; the archive; and the live phone preview.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  Button,
  ButtonLink,
  EmptyState,
  Icon,
  IconButton,
  Musubi,
  Oops,
  Panel,
  PhoneFrame,
  ProgressRing,
  Sheet,
  Skeleton,
  StatTile,
  StatusChip,
  burstFrom,
  useMusubi,
  useToast,
} from "@mizuhiki/ui";
import { kindsLine } from "@/lib/kinds";
import { DENOMS, denomByBase, fromBaseUnits } from "@mizuhiki/chain";
import type { Block } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { PageView } from "@/page/PageView";
import { pageUrl } from "@/lib/site";
import { downloadBytes } from "@/lib/download";
import { buildSpareKeySheet } from "@/lib/pdfs";
import { loadMine, markSheet } from "@/recovery/engine";
import { AddSheet } from "./AddSheet";
import { BlockCard } from "./BlockCard";
import { mapBlocks, moveBlock, updateBlock } from "./blocks";
import { checklistState, markChecklist } from "./checklist";
import s from "./editor.module.css";
import { failureText } from "@/lib/failure";

export function MyPage() {
  const o = useOwner();
  const toast = useToast();
  const mm = useMusubi("normal");
  const publishBtn = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showArchive, setShowArchive] = useState(false);
  const [preview, setPreview] = useState(false);
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const d = o.draft;
  const live = useMemo(() => (d ? d.manifest.blocks.filter((b) => !b.archived) : []), [d]);
  const archived = useMemo(() => (d ? d.manifest.blocks.filter((b) => b.archived) : []), [d]);
  const collections = live.filter((b) => b.type === "collection");
  const firstName = d ? ((d.manifest.displayName || d.manifest.name).split(" ")[0] ?? d.manifest.name) : "";

  // The server's record of the spare-key sheet is the truth: a sheet saved from the Spare key page, or on another
  // device, ticks the checklist here too.
  const loaded = !!d;
  const sheetTicked = !!d?.checklist.done.includes("spareKey");
  const owner = useRef(o);
  owner.current = o;
  useEffect(() => {
    if (!loaded || sheetTicked) return;
    let live = true;
    const cur = owner.current;
    void cur
      .token()
      .then((token) => loadMine({ ...cur.account, token }))
      .then((m) => {
        if (live && m.settings.sheetSavedAt) owner.current.edit((x) => markChecklist(x, "spareKey", "done"));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [loaded, sheetTicked, o.account.owner.address]);

  const share = useCallback(async () => {
    if (!d) return;
    const url = pageUrl(d.manifest.name);
    const nav = navigator as { share?: Navigator["share"] };
    try {
      if (nav.share) await nav.share.call(navigator, { title: `@${d.manifest.name} on Mizuhiki`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast.show("Link copied");
      }
      o.edit((x) => markChecklist(x, "share", "done"));
    } catch {
      // the person closed the share sheet; nothing to do
    }
  }, [d, o, toast]);

  const onDragStart = (id: string) => (e: ReactPointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const list = listRef.current;
    if (!list) return;
    // Row positions are read live, so the page can scroll under the finger.
    const overAt = (y: number) => {
      const mids = [...list.querySelectorAll<HTMLElement>("[data-block]")].map((r) => {
        const rc = r.getBoundingClientRect();
        return rc.top + rc.height / 2;
      });
      const i = mids.findIndex((m) => y < m);
      return i < 0 ? mids.length - 1 : i;
    };
    const from = live.findIndex((b) => b.id === id);
    let lastY = e.clientY;
    let raf = 0;
    // Near the top or bottom edge, scroll the page so long lists can be reordered.
    const edgeScroll = () => {
      const zone = 80;
      const dy =
        lastY < zone ? -(zone - lastY) / 4 : lastY > innerHeight - zone ? (lastY - (innerHeight - zone)) / 4 : 0;
      if (dy !== 0) {
        scrollBy(0, dy);
        setDrag({ id, over: overAt(lastY) });
      }
      raf = requestAnimationFrame(edgeScroll);
    };
    setDrag({ id, over: from });
    raf = requestAnimationFrame(edgeScroll);
    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      setDrag({ id, over: overAt(ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      cancelAnimationFrame(raf);
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      const over = overAt(ev.clientY);
      setDrag(null);
      if (over !== from) o.edit((x) => moveBlock(x, id, over));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  };

  if (o.loading || !d) {
    return (
      <div className={s.page}>
        <div className={s.main}>
          {o.loadError ? (
            <Oops
              title="Your page did not open"
              action={
                <Button variant="line" size="sm" icon="refresh" onClick={o.reload}>
                  Try again
                </Button>
              }
            >
              {o.loadError}
            </Oops>
          ) : (
            <>
              <Skeleton lines={1} height={60} />
              <Skeleton avatar lines={2} />
              <Skeleton avatar lines={2} />
              <Skeleton avatar lines={2} />
            </>
          )}
        </div>
      </div>
    );
  }

  const checklist = checklistState(d, o.stats);
  const items = o.stats?.items ?? {};
  const sealedCount = Object.entries(items)
    .filter(([k]) => k !== "form")
    .reduce((n, [, v]) => n + v.count, 0);
  const sealedLine = kindsLine(
    Object.fromEntries(
      Object.entries(items)
        .filter(([k]) => k !== "form")
        .map(([k, v]) => [k, v.count]),
    ),
  );
  const views = o.stats?.views ?? { week: 0, previousWeek: 0 };
  const change =
    views.previousWeek > 0 ? Math.round(((views.week - views.previousWeek) / views.previousWeek) * 100) : null;

  const doPublish = () => {
    o.publish()
      .then(() => {
        burstFrom(publishBtn.current);
        mm.react("happy", 1600);
        toast.show(`Published to ${pageUrl(d.manifest.name).replace(/^https?:\/\//, "")}`, {
          action: { label: "Share", onClick: () => void share() },
        });
      })
      .catch((e: unknown) => {
        mm.react("worried", 1800, false);
        toast.show(failureText(e, "Not published. Your changes are still saved here."), {
          tone: "error",
          ms: 6000,
        });
      });
  };

  return (
    <div className={s.page}>
      <div className={s.main}>
        <header className={s.topbar}>
          <h1>My page</h1>
          {o.dirty ? (
            <StatusChip status="wait">Draft · not published yet</StatusChip>
          ) : (
            <StatusChip status="ok">Published</StatusChip>
          )}
          <span className={s.saveState} aria-live="polite">
            {o.save === "saving"
              ? "Saving…"
              : o.save === "saved"
                ? "Changes saved"
                : o.save === "offline"
                  ? "Offline · will save when you are back"
                  : o.save === "error"
                    ? "Not saved yet · retrying"
                    : ""}
          </span>
          <div className={s.topActions}>
            <IconButton icon="undo" label="Undo" size="sm" variant="line" onClick={o.undo} disabled={!o.canUndo} />
            <IconButton icon="redo" label="Redo" size="sm" variant="line" onClick={o.redo} disabled={!o.canRedo} />
            <ButtonLink
              variant="line"
              size="sm"
              icon="eye"
              href={`/@${d.manifest.name}`}
              target="_blank"
              rel="noopener"
            >
              View
            </ButtonLink>
            <Button
              ref={publishBtn}
              variant="cord"
              size="sm"
              busy={o.publishing}
              disabled={!o.dirty}
              onClick={doPublish}
              icon={o.dirty ? undefined : "check"}
            >
              {o.dirty ? "Publish" : "Up to date"}
            </Button>
          </div>
        </header>

        <div className={s.stats}>
          <StatTile
            label="Page visits · 7 days"
            value={views.week}
            detail={change === null ? "None last week" : `${change >= 0 ? "+" : ""}${change}% on last week`}
            tone="sakura"
          />
          <StatTile
            label="Sealed items received"
            value={sealedCount}
            detail={sealedLine || "Nothing yet"}
            tone="sora"
          />
          <PaidTile paid={o.stats?.paid ?? []} />
          <StatTile
            label="Form answers"
            value={items.form?.count ?? 0}
            detail={`${items.form?.unread ?? 0} not opened`}
            tone="butter"
          />
        </div>

        {checklist.done < checklist.total ? (
          <section id="checklist" className={s.checklist} aria-labelledby="cl-h">
            <div className={s.checkHead}>
              <ProgressRing done={checklist.done} total={checklist.total} size={56} />
              <div>
                <h2 id="cl-h">Setup checklist</h2>
                <p>
                  {checklist.done} of {checklist.total} complete
                </p>
              </div>
            </div>
            <ul>
              {checklist.items.map((it) => (
                <li key={it.id} className={s[`cl_${it.state}`]}>
                  <span className={s.clDot} aria-hidden="true">
                    {it.state === "done" ? <Icon name="check" size={14} /> : null}
                  </span>
                  <span className={s.clTitle}>
                    {it.title}
                    {it.state === "skipped" ? <small> · skipped</small> : null}
                  </span>
                  {it.state === "todo" ? (
                    <span className={s.clActions}>
                      <ChecklistAction id={it.id} onAddBlock={() => setAdding(true)} onShare={() => void share()} />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => o.edit((x) => markChecklist(x, it.id, "skipped"))}
                      >
                        Skip
                      </Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <Panel
          title="Blocks on your page"
          kicker="ブロック"
          action={
            <Button variant="cord" size="sm" icon="plus" onClick={() => setAdding(true)}>
              Add
            </Button>
          }
        >
          {live.length === 0 ? (
            <EmptyState
              title="No blocks yet"
              jp="はじめよう"
              action={
                <Button variant="cord" icon="plus" onClick={() => setAdding(true)}>
                  Add your first block
                </Button>
              }
            >
              Your page only shows a way to message you. Add what you want people to do.
            </EmptyState>
          ) : (
            <ol className={s.blocks} ref={listRef}>
              {live.map((b, i) => (
                <BlockCard
                  key={b.id}
                  block={b}
                  index={i}
                  count={live.length}
                  taps={o.stats?.taps[b.id] ?? 0}
                  collections={collections}
                  open={openId === b.id}
                  onOpen={(v) => setOpenId(v ? b.id : null)}
                  onChange={(patch, coalesce) => {
                    o.edit((x) => updateBlock(x, b.id, patch), coalesce ? { coalesce } : undefined);
                    if (patch.on !== undefined) mm.react(patch.on ? "wink" : "normal", 900);
                  }}
                  onMove={(to) => o.edit((x) => moveBlock(x, b.id, to))}
                  onArchive={() => {
                    o.edit((x) => updateBlock(x, b.id, { archived: true, on: false }));
                    toast.show("Archived", { action: { label: "Undo", onClick: o.undo } });
                  }}
                  onDelete={() => {
                    o.edit((x) =>
                      mapBlocks(x, (bs) =>
                        bs
                          .filter((y) => y.id !== b.id && y.collection !== b.id)
                          .concat(
                            bs.filter((y) => y.collection === b.id).map((y) => ({ ...y, collection: undefined })),
                          ),
                      ),
                    );
                    toast.show("Deleted", { action: { label: "Undo", onClick: o.undo } });
                  }}
                  onShare={() => {
                    const url = `${pageUrl(d.manifest.name)}#${b.id}`;
                    void navigator.clipboard.writeText(url).then(
                      () => toast.show("Block link copied"),
                      () => toast.show("Copy is not allowed here", { tone: "error" }),
                    );
                  }}
                  onDragStart={onDragStart(b.id)}
                  dragging={drag?.id === b.id}
                />
              ))}
              {drag ? <li className={s.dropHint} style={{ order: drag.over }} aria-hidden="true" /> : null}
            </ol>
          )}
          {d.pending.length > 0 ? (
            <ul className={s.pending}>
              {d.pending.map((p) => (
                <li key={p.key}>
                  <Icon name="wrench" size={16} />
                  <span>
                    <b>{p.title}</b> · Finish setup, not visible on your page
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className={s.archiveLink}>
            <Button
              variant="ghost"
              size="sm"
              icon="archive"
              onClick={() => setShowArchive((v) => !v)}
              aria-expanded={showArchive}
            >
              {showArchive ? "Hide archive" : `View archive${archived.length ? ` (${archived.length})` : ""}`}
            </Button>
          </div>
          {showArchive ? (
            archived.length === 0 ? (
              <p className={s.help}>Nothing archived. Archived blocks keep their insights and can come back anytime.</p>
            ) : (
              <ul className={s.archive}>
                {archived.map((b) => (
                  <li key={b.id}>
                    <span>{b.title}</span>
                    <Button
                      size="sm"
                      variant="line"
                      icon="undo"
                      onClick={() =>
                        o.edit((x) =>
                          mapBlocks(x, (bs) => [
                            ...bs.filter((y) => y.id !== b.id),
                            { ...b, archived: false, on: false },
                          ]),
                        )
                      }
                    >
                      Restore
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => o.edit((x) => mapBlocks(x, (bs) => bs.filter((y) => y.id !== b.id)))}
                    >
                      Delete forever
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </Panel>
      </div>

      <aside className={s.preview} aria-label="Live preview">
        <p className={s.previewLabel}>
          <Icon name="eye" size={14} />
          <span>Live preview · {pageUrl(d.manifest.name).replace(/^https?:\/\//, "")}</span>
        </p>
        <PhoneFrame width={320}>
          <PageView manifest={d.manifest} compact pending={d.pending.map((p) => ({ key: p.key, title: p.title }))} />
        </PhoneFrame>
        <span className={s.previewMm}>
          <Musubi face={mm.face} hopKey={mm.hopKey} size={104} bob />
        </span>
      </aside>

      <button type="button" className={s.previewFab} onClick={() => setPreview(true)}>
        <Icon name="phone" />
        Preview
      </button>
      <Sheet open={preview} onClose={() => setPreview(false)} title="Preview">
        <PageView manifest={d.manifest} compact pending={d.pending.map((p) => ({ key: p.key, title: p.title }))} />
      </Sheet>
      <AddSheet
        open={adding}
        onClose={() => setAdding(false)}
        firstName={firstName}
        onAdd={(b: Block) => {
          o.edit((x) =>
            markChecklist(
              mapBlocks(x, (bs) => [b, ...bs]),
              "block",
              "done",
            ),
          );
          setOpenId(b.on ? null : b.id);
          mm.react("happy", 1200);
          toast.show(`${b.title} added`, { action: { label: "Share", onClick: () => void share() } });
        }}
      />
    </div>
  );
}

function ChecklistAction({ id, onAddBlock, onShare }: { id: string; onAddBlock: () => void; onShare: () => void }) {
  const o = useOwner();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  switch (id) {
    case "profile":
      return (
        <ButtonLink size="sm" variant="line" href="/app/design#profile">
          Add
        </ButtonLink>
      );
    case "spareKey":
      return (
        <Button
          size="sm"
          variant="line"
          busy={busy}
          onClick={() => {
            const d = o.draft;
            if (!d) return;
            setBusy(true);
            buildSpareKeySheet({
              name: d.manifest.name,
              pageUrl: pageUrl(d.manifest.name),
              address: o.account.owner.address,
              evm: o.account.owner.evm,
              phrase: o.account.keys.phrase,
              createdAt: new Date(),
            })
              .then((bytes) => {
                downloadBytes(bytes, `mizuhiki-spare-key-${d.manifest.name}.pdf`);
                o.edit((x) => markChecklist(x, "spareKey", "done"));
                toast.show("Spare-key sheet saved. Keep it offline.");
                // The Spare key page shows the same fact. A failed note there does not undo the download, but it is said.
                void o
                  .token()
                  .then((token) => markSheet({ ...o.account, token }, "sheet"))
                  .catch(() =>
                    toast.show(
                      "The sheet is saved, but the Spare key page could not record it. Download it there once more to record it.",
                      {
                        tone: "error",
                      },
                    ),
                  );
              })
              .catch(() => toast.show("Could not build the sheet.", { tone: "error" }))
              .finally(() => setBusy(false));
          }}
        >
          Save sheet
        </Button>
      );
    case "block":
      return (
        <Button size="sm" variant="line" onClick={onAddBlock}>
          Add
        </Button>
      );
    case "design":
      return (
        <ButtonLink size="sm" variant="line" href="/app/design">
          Open
        </ButtonLink>
      );
    case "share":
      return (
        <Button size="sm" variant="line" onClick={onShare}>
          Share
        </Button>
      );
    default:
      return (
        <Button size="sm" variant="line" onClick={onShare}>
          Share
        </Button>
      );
  }
}

/** Paid to you: test dollars first (plain money words), then any other token in its own unit. */
export function PaidTile({
  paid,
  label = "Paid to you",
}: {
  paid: { denom: string; total: string; count: number }[];
  label?: string;
}) {
  const count = paid.reduce((n, p) => n + p.count, 0);
  const lead = paid.find((p) => p.denom === DENOMS.fUSD.denom) ?? paid[0];
  const leadDenom = lead ? denomByBase(lead.denom) : DENOMS.fUSD;
  const value = lead ? Number(fromBaseUnits(lead.total, leadDenom?.decimals ?? 6)) : 0;
  const isUsd = !lead || lead.denom === DENOMS.fUSD.denom;
  const symbol = leadDenom?.symbol ?? "";
  const rest = paid
    .filter((p) => p !== lead)
    .map(
      (p) =>
        fromBaseUnits(p.total, denomByBase(p.denom)?.decimals ?? 6) + " " + (denomByBase(p.denom)?.symbol ?? p.denom),
    );
  const money = (n: number) =>
    isUsd
      ? "$" + n.toLocaleString("en-US", { maximumFractionDigits: 2 })
      : n.toLocaleString("en-US", { maximumFractionDigits: 6 }) + " " + symbol;
  return (
    <StatTile
      label={label}
      value={value}
      format={money}
      detail={
        String(count) + (count === 1 ? " payment" : " payments") + (rest.length ? " · plus " + rest.join(", ") : "")
      }
      tone="matcha"
    />
  );
}
