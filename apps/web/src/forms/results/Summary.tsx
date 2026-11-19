"use client";
/**
 * The per-question summary (Typeform's "Response summary"): horizontal bars
 * with counts and percentages for choices and scales, lowest / average /
 * highest for numbers, the latest answers for text. Shared by the owner's
 * Results tab and the public snapshot page, so both read the same.
 */
import { useState } from "react";
import { Icon, StatTile } from "@mizuhiki/ui";
import { ago, answeredLine, averageSeconds, clock, completionRate, pct, type FunnelRow } from "./aggregate";
import type { Counters, QuestionSummary } from "./schema";
import s from "../results.module.css";

export function CounterTiles({ counters }: { counters: Counters }) {
  const rate = completionRate(counters);
  const avg = averageSeconds(counters);
  return (
    <div className={s.tiles}>
      <StatTile label="Views" value={counters.views} tone="sora" />
      <StatTile label="Starts" value={counters.starts} tone="kinari" />
      <StatTile label="Submissions" value={counters.submissions} tone="matcha" />
      <StatTile
        label="Completion rate"
        value={rate === null ? 0 : Math.round(rate * 1000) / 10}
        format={(n) => (rate === null ? "–" : `${Number.isInteger(n) ? n : n.toFixed(1)}%`)}
        detail={rate === null ? "No starts yet" : "Submissions ÷ starts"}
        tone="sakura"
      />
      <StatTile
        label="Time to complete"
        value={avg === null ? 0 : Math.round(avg)}
        format={(n) => (avg === null ? "–" : clock(n))}
        detail="Average, mm:ss"
        tone="fuji"
      />
    </div>
  );
}

const fmtNum = (n: number | null) =>
  n === null
    ? "–"
    : Number.isInteger(n)
      ? n.toLocaleString("en-US")
      : n.toLocaleString("en-US", { maximumFractionDigits: 2 });

function Bars({ q }: { q: Extract<QuestionSummary, { type: "bars" }> }) {
  const top = Math.max(0, ...q.bars.map((b) => b.count));
  return (
    <>
      <ul className={s.bars}>
        {q.bars.map((b, i) => (
          <li key={`${b.label}-${i}`} className={b.count === top && top > 0 ? s.barTop : undefined}>
            <span className={s.barLabel}>{b.label}</span>
            <span className={s.barTrack} aria-hidden="true">
              <span className={s.barFill} style={{ width: q.answered ? `${(b.count / q.answered) * 100}%` : "0%" }} />
            </span>
            <span className={s.barNum}>
              <b>{pct(b.count, q.answered)}</b> <small>{b.count}</small>
            </span>
          </li>
        ))}
      </ul>
      {q.average !== null ? (
        <p className={s.avgLine}>
          <Icon name="star" size={14} /> Average {q.average.toFixed(1)}
          {q.scaleMax !== null ? ` of ${q.scaleMax}` : ""}
        </p>
      ) : null}
      {q.multi ? (
        <p className={s.note}>People could pick more than one, so the shares add up to more than 100%.</p>
      ) : null}
      {q.others.length ? (
        <TextList title="What people wrote under Other" items={q.others.map((text) => ({ text }))} />
      ) : null}
    </>
  );
}

function TextList({ title, items }: { title?: string; items: { text: string; at?: string }[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  return (
    <div className={s.texts}>
      {title ? <p className={s.textsTitle}>{title}</p> : null}
      <ul>
        {shown.map((t, i) => (
          <li key={i}>
            <p>{t.text}</p>
            {t.at ? <time dateTime={t.at}>{ago(t.at)}</time> : null}
          </li>
        ))}
      </ul>
      {items.length > 5 ? (
        <button type="button" className={s.more} onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      ) : null}
    </div>
  );
}

export function QuestionCard({ q, index }: { q: QuestionSummary; index: number }) {
  return (
    <article className={s.qCard}>
      <header className={s.qHead}>
        <span className={s.qNum}>{index + 1}</span>
        <div>
          <h3>{q.title || "Untitled question"}</h3>
          <p className={s.note}>{answeredLine(q)}</p>
        </div>
      </header>
      {q.answered === 0 ? (
        <p className={s.quiet}>Nobody has answered this one yet.</p>
      ) : q.type === "bars" ? (
        <Bars q={q} />
      ) : q.type === "numbers" ? (
        <dl className={s.nums}>
          <div>
            <dt>Lowest</dt>
            <dd>{fmtNum(q.min)}</dd>
          </div>
          <div>
            <dt>Average</dt>
            <dd>{fmtNum(q.avg)}</dd>
          </div>
          <div>
            <dt>Highest</dt>
            <dd>{fmtNum(q.max)}</dd>
          </div>
        </dl>
      ) : q.type === "files" ? (
        <p className={s.quiet}>
          <Icon name="lock" size={14} /> {q.files} sealed file{q.files === 1 ? "" : "s"}. Files are never part of a
          summary.
        </p>
      ) : (
        <TextList title="Latest answers" items={q.latest} />
      )}
    </article>
  );
}

export function SummaryList({ summary }: { summary: QuestionSummary[] }) {
  return (
    <div className={s.summary}>
      {summary.map((q, i) => (
        <QuestionCard key={q.id} q={q} index={i} />
      ))}
    </div>
  );
}

export function Funnel({ rows, hasLogic }: { rows: FunnelRow[]; hasLogic: boolean }) {
  if (!rows.length) return null;
  const top = Math.max(1, ...rows.map((r) => r.reached));
  return (
    <div className={s.funnel}>
      <h3>Question by question</h3>
      <div className={s.tableWrap} tabIndex={0} role="region" aria-label="Question by question">
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Reached</th>
              <th scope="col">Drop-off</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id}>
                <td className={s.funnelQ}>
                  <span className={s.qNum}>{i + 1}</span>
                  <span>{r.title || "Untitled question"}</span>
                </td>
                <td>
                  <span className={s.reach}>
                    <span className={s.reachBar} aria-hidden="true">
                      <span style={{ width: `${(r.reached / top) * 100}%` }} />
                    </span>
                    {r.reached}
                  </span>
                </td>
                <td className={r.drop > 0 ? s.dropOn : s.dash}>
                  {r.drop > 0 ? `−${r.drop} (${pct(r.dropShare, 1)})` : "–"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className={s.note}>
        Drop-off compares each question with the one before it (the first with Starts).
        {hasLogic ? " Your form has logic jumps, so some of the drop is people skipping ahead, not leaving." : ""}
      </p>
    </div>
  );
}
