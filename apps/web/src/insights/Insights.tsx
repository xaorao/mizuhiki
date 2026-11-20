"use client";
/**
 * Insights (spec 5.16, Linktree's tiles and "most clicked"): views, sealed
 * items received and money received over the last 7 days, 28 days or
 * lifetime; views by day; the most tapped blocks; form completion. Counted
 * without IPs or cookies; nothing here is content.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button, EmptyState, Kicker, LockLine, Oops, Segmented, Skeleton, StatTile, useToast } from "@mizuhiki/ui";
import { useOwner } from "@/owner/OwnerProvider";
import { api, ApiFailure } from "@/lib/api";
import { pageUrl } from "@/lib/site";
import { PaidTile } from "@/editor/MyPage";
import p from "@/passes/passes.module.css";
import s from "./insights.module.css";

type Range = "7" | "28" | "all";
interface Data {
  range: Range;
  from: string | null;
  views: { total: number; previous: number | null };
  items: { total: number; previous: number | null; byKind: Record<string, number> };
  money: {
    byDenom: { denom: string; total: string; count: number }[];
    previous: { denom: string; total: string; count: number }[] | null;
  };
  series: { at: string; views: number; items: number; payments: number }[];
  taps: { subject: string; count: number }[];
  forms: { id: string; title: string; views: number; starts: number; submits: number }[];
}

const KIND_WORDS: Record<string, string> = {
  message: "messages",
  reply: "replies",
  paynote: "payment notes",
  form: "form answers",
  order: "orders",
  request: "requests",
};

/** "+3 vs the previous 7 days" in words, never color alone. */
function change(now: number, before: number | null, range: Range): string | undefined {
  if (before === null) return undefined;
  const d = now - before;
  const span = range === "7" ? "7" : "28";
  if (d === 0) return `Same as the ${span} days before`;
  return `${d > 0 ? "+" : "−"}${Math.abs(d)} vs the ${span} days before`;
}

export function Insights() {
  const owner = useOwner();
  const toast = useToast();
  const [range, setRange] = useState<Range>("7");
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [table, setTable] = useState(false);

  const { token } = owner;
  const load = useCallback(async () => {
    try {
      setData(await api.get<Data>(`/owner/insights?range=${range}`, { token: await token() }));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Insights could not be loaded. Nothing changed.");
    }
  }, [token, range]);
  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  const blocks = useMemo(() => owner.published?.blocks ?? [], [owner.published]);
  const name = owner.published?.name ?? "";
  const share = async () => {
    const url = pageUrl(name);
    const nav = navigator as { share?: Navigator["share"] };
    try {
      if (nav.share) await nav.share.call(navigator, { title: `@${name} on Mizuhiki`, url });
      else {
        await navigator.clipboard.writeText(url);
        toast.show("Link copied");
      }
    } catch {
      // The share sheet was closed; nothing to do.
    }
  };

  // Taps by block; blocks no longer on the page are summed into one row.
  const taps = useMemo(() => {
    const live = new Map<string, { subject: string; title: string; count: number }>();
    let removed = 0;
    for (const t of data?.taps ?? []) {
      const b = blocks.find((x) => x.id === t.subject);
      if (b)
        live.set(t.subject, {
          subject: t.subject,
          title: "title" in b && typeof b.title === "string" && b.title ? b.title : "Untitled block",
          count: t.count,
        });
      else removed += t.count;
    }
    const list = [...live.values()];
    if (removed) list.push({ subject: "removed", title: "Blocks you removed", count: removed });
    return list.sort((a, b) => b.count - a.count);
  }, [data, blocks]);
  const empty =
    data &&
    data.range === "all" &&
    data.views.total === 0 &&
    data.items.total === 0 &&
    data.money.byDenom.length === 0 &&
    data.taps.length === 0;
  return (
    <div className={p.page}>
      <header className={p.top}>
        <div className={p.titleBlock}>
          <Kicker>みえるか</Kicker>
          <h1>Insights</h1>
          <p className={p.lede}>How your page is doing. We count, we never read.</p>
        </div>
        <span className={p.newBtn}>
          <Segmented
            label="Time range"
            value={range}
            onChange={setRange}
            options={[
              { value: "7", label: "Last 7 days" },
              { value: "28", label: "28 days" },
              { value: "all", label: "Lifetime" },
            ]}
          />
        </span>
      </header>
      <div className={p.body} key={range}>
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
        ) : !data ? (
          <div className={s.tiles}>
            <Skeleton lines={3} />
            <Skeleton lines={3} />
            <Skeleton lines={3} />
          </div>
        ) : empty ? (
          <div className={p.emptyWrap}>
            <EmptyState
              title="No activity yet. Share your page."
              face="normal"
              jp="はじめよう"
              action={
                <Button variant="cord" icon="share" onClick={() => void share()}>
                  Share
                </Button>
              }
            >
              Views, sealed items and payments show here as people find you.
            </EmptyState>
          </div>
        ) : (
          <>
            <div className={s.tiles}>
              <StatTile
                label="Views"
                value={data.views.total}
                detail={change(data.views.total, data.views.previous, data.range)}
                tone="sakura"
              />
              <StatTile
                label="Sealed items received"
                value={data.items.total}
                detail={
                  Object.entries(data.items.byKind)
                    .map(([k, n]) => `${n} ${KIND_WORDS[k] ?? k}`)
                    .join(", ") || change(data.items.total, data.items.previous, data.range)
                }
                tone="sora"
              />
              <PaidTile paid={data.money.byDenom} label="Money received" />
            </div>
            <ViewsChart data={data} table={table} onTable={setTable} />
            <div className={s.cols}>
              <section className={p.panel} aria-labelledby="taps-h">
                <h2 id="taps-h">Most tapped blocks</h2>
                {taps.length === 0 ? (
                  <p className={p.hint}>No taps in this time. Taps on your blocks are counted here.</p>
                ) : (
                  <ol className={s.ranks}>
                    {taps.slice(0, 8).map((t) => {
                      const max = taps[0]?.count ?? 1;
                      return (
                        <li key={t.subject}>
                          <span className={s.rankName}>{t.title}</span>
                          <span className={s.rankBar} aria-hidden="true">
                            <i style={{ width: `${Math.max(4, (t.count / max) * 100)}%` }} />
                          </span>
                          <b className={s.rankNum}>{t.count.toLocaleString("en-GB")}</b>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>
              <section className={p.panel} aria-labelledby="forms-h">
                <h2 id="forms-h">Form completion</h2>
                {data.forms.length === 0 ? (
                  <p className={p.hint}>
                    No published forms. <Link href="/app/forms">Make a form</Link> to see how many people finish it.
                  </p>
                ) : (
                  <ul className={s.forms}>
                    {data.forms.map((f) => {
                      const rate = f.views ? Math.round((f.submits / f.views) * 100) : 0;
                      return (
                        <li key={f.id}>
                          <div className={s.formHead}>
                            <Link href={`/app/forms/${f.id}?tab=results`}>{f.title}</Link>
                            <b>{f.views ? `${rate}% finish` : "No views yet"}</b>
                          </div>
                          <span className={s.rankBar} aria-hidden="true">
                            <i style={{ width: `${Math.max(f.views ? 2 : 0, rate)}%` }} />
                          </span>
                          <small>
                            {f.views} opened · {f.starts} started · {f.submits} sent
                          </small>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </div>
            <LockLine>
              Views and taps are counted per day without IPs or cookies. Items are counted from their sealed envelopes.
              Money is what reached you on QoreChain through your page (payments, invoices and orders); other transfers
              to your address are not counted.
            </LockLine>
          </>
        )}
      </div>
    </div>
  );
}

/** Views by day (or month for lifetime): one series, thin columns, a tooltip per column, and a table view. */
function ViewsChart({ data, table, onTable }: { data: Data; table: boolean; onTable: (v: boolean) => void }) {
  const [hover, setHover] = useState<number | null>(null);
  // Drawn at the box's real width, so text and columns never stretch on a narrow screen.
  const box = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e?.contentRect.width ?? 640))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);
  const series = data.series;
  const max = Math.max(1, ...series.map((d) => d.views));
  const top = useMemo(() => {
    // Clean ticks: 1, 2 or 5 times a power of ten.
    const raw = max / 3;
    const pow = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
    const step = [1, 2, 5, 10].map((m) => m * pow).find((x) => x >= raw) ?? pow * 10;
    return { step, top: Math.max(step, Math.ceil(max / step) * step) };
  }, [max]);
  const label = (at: string) =>
    at.length === 7
      ? new Date(`${at}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
      : new Date(`${at}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  const H = 220;
  const padL = 36;
  const padB = 26;
  const plotW = W - padL - 8;
  const plotH = H - padB - 10;
  const band = plotW / Math.max(1, series.length);
  const bar = Math.min(24, band - 2);
  const ticks = Array.from({ length: Math.round(top.top / top.step) + 1 }, (_, i) => i * top.step);
  // As many day labels as fit (about one per 64 px).
  const every = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor((W - padL) / 64))));
  const h = hover === null ? null : series[hover];
  return (
    <section className={p.panel} aria-labelledby="views-h">
      <div className={s.chartHead}>
        <h2 id="views-h">Views {data.range === "all" ? "by month" : "by day"}</h2>
        <button type="button" className={s.tableToggle} aria-pressed={table} onClick={() => onTable(!table)}>
          {table ? "Show chart" : "Show as table"}
        </button>
      </div>
      {table ? (
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th scope="col">{data.range === "all" ? "Month" : "Day"}</th>
                <th scope="col">Views</th>
                <th scope="col">Sealed items</th>
                <th scope="col">Payments</th>
              </tr>
            </thead>
            <tbody>
              {series.map((d) => (
                <tr key={d.at}>
                  <th scope="row">{label(d.at)}</th>
                  <td>{d.views}</td>
                  <td>{d.items}</td>
                  <td>{d.payments}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className={s.chart} ref={box} onPointerLeave={() => setHover(null)}>
          <svg
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Views ${data.range === "all" ? "by month" : "by day"}: ${data.views.total} in total`}
          >
            {ticks.map((t) => {
              const y = 10 + plotH - (t / top.top) * plotH;
              return (
                <g key={t}>
                  <line x1={padL} x2={W - 8} y1={y} y2={y} className={s.grid} />
                  <text x={padL - 6} y={y + 4} textAnchor="end" className={s.tick}>
                    {t.toLocaleString("en-GB")}
                  </text>
                </g>
              );
            })}
            {series.map((d, i) => {
              const x = padL + i * band + (band - bar) / 2;
              const bh = (d.views / top.top) * plotH;
              const y = 10 + plotH - bh;
              const r = Math.min(4, bh / 2, bar / 2);
              return (
                <g key={d.at}>
                  {bh > 0 ? (
                    <path
                      className={hover === i ? s.barOn : s.bar}
                      d={`M${x},${10 + plotH} V${y + r} Q${x},${y} ${x + r},${y} H${x + bar - r} Q${x + bar},${y} ${x + bar},${y + r} V${10 + plotH} Z`}
                    />
                  ) : null}
                  {i % every === 0 || i === series.length - 1 ? (
                    <text x={x + bar / 2} y={H - 8} textAnchor="middle" className={s.tick}>
                      {label(d.at)}
                    </text>
                  ) : null}
                  {/* A hit target as wide as the band, taller than the bar. */}
                  <rect
                    x={padL + i * band}
                    y={0}
                    width={band}
                    height={10 + plotH}
                    fill="transparent"
                    onPointerEnter={() => setHover(i)}
                    onFocus={() => setHover(i)}
                    tabIndex={0}
                    aria-label={`${label(d.at)}: ${d.views} views, ${d.items} sealed items, ${d.payments} payments`}
                  />
                </g>
              );
            })}
            <line x1={padL} x2={W - 8} y1={10 + plotH} y2={10 + plotH} className={s.axis} />
          </svg>
          {h && hover !== null ? (
            <div className={s.tip} style={{ left: `${((padL + hover * band + band / 2) / W) * 100}%` }} role="status">
              <b>{label(h.at)}</b>
              <span>
                {h.views.toLocaleString("en-GB")} {h.views === 1 ? "view" : "views"}
              </span>
              <span>
                {h.items} sealed {h.items === 1 ? "item" : "items"}
              </span>
              <span>
                {h.payments} {h.payments === 1 ? "payment" : "payments"}
              </span>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
