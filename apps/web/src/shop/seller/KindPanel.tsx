"use client";
/**
 * Settings for the kind of product: a call's length, time zone, weekly hours
 * and meeting place; a commission's deposit; a bundle's products; a tip jar's note.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, IconButton, Panel, Skeleton, TextField } from "@mizuhiki/ui";
import { formatAmount, type ProductDef } from "@mizuhiki/core";
import { listMyProducts, openDraft } from "../engine";
import { WEEKDAYS, fromTime, hoursProblems, sumByToken, toTime } from "./model";
import { CountField } from "./fields";
import { Thumb } from "./bits";
import type { EditorProps } from "./editorTypes";
import s from "./seller.module.css";
import { failureText } from "@/lib/failure";

export function KindPanel(props: EditorProps) {
  const k = props.draft.def.kind;
  if (k === "call") return <CallPanel {...props} />;
  if (k === "commission") return <CommissionPanel {...props} />;
  if (k === "bundle") return <BundlePanel {...props} />;
  if (k === "tip")
    return (
      <Panel title="Tip jar" kicker="ありがとう">
        <p className={s.help}>
          Supporters choose any amount from your smallest tip up. After paying they get the thank-you page you write in
          Content, sealed to them, so you can share something only supporters see.
        </p>
      </Panel>
    );
  return null;
}

const zones = (): string[] => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return [Intl.DateTimeFormat().resolvedOptions().timeZone];
  }
};

function CallPanel({ draft, patch }: EditorProps) {
  const b = draft.def.booking ?? {
    minutes: 30,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hours: [],
    place: "",
  };
  const set = (p: Partial<NonNullable<ProductDef["booking"]>>, key?: string) => patch({ booking: { ...b, ...p } }, key);
  const all = useMemo(zones, []);
  const problems = hoursProblems(b.hours, b.minutes);
  const setRange = (idx: number, p: Partial<{ from: number; to: number }>) =>
    set({ hours: b.hours.map((h, j) => (j === idx ? { ...h, ...p } : h)) }, `h-${idx}`);

  return (
    <Panel title="Booking" kicker="よやく">
      <div className={s.stack}>
        <div className={s.fieldRow}>
          <CountField
            label="Call length in minutes"
            value={b.minutes}
            min={10}
            max={480}
            onChange={(minutes) => minutes !== null && set({ minutes }, "minutes")}
          />
          <label className={s.selectField}>
            <span>Your time zone</span>
            <select value={b.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {(all.includes(b.timezone) ? all : [b.timezone, ...all]).map((z) => (
                <option key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={s.subHead}>
          <b>Weekly hours</b>
          <small>
            Buyers pick a free slot inside these hours, shown in their own time zone. A booked slot is held for an hour
            while they pay.
          </small>
        </div>
        <ul className={s.week}>
          {WEEKDAYS.map((day, d) => {
            const ranges = b.hours.map((h, i) => ({ h, i })).filter((x) => x.h.day === d);
            return (
              <li key={day} className={s.weekDay}>
                <b className={s.dayName}>{day.slice(0, 3)}</b>
                <div className={s.dayRanges}>
                  {ranges.length === 0 ? <small className={s.muted}>Not available</small> : null}
                  {ranges.map(({ h, i }) => (
                    <div key={i} className={s.range}>
                      <input
                        type="time"
                        aria-label={`${day} from`}
                        value={toTime(h.from)}
                        step={300}
                        onChange={(e) => {
                          const m = fromTime(e.target.value);
                          if (m !== null) setRange(i, { from: m });
                        }}
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        type="time"
                        aria-label={`${day} until`}
                        value={h.to >= 1440 ? "23:59" : toTime(h.to)}
                        step={300}
                        onChange={(e) => {
                          const m = fromTime(e.target.value);
                          if (m !== null) setRange(i, { to: m === 1439 ? 1440 : m });
                        }}
                      />
                      <IconButton
                        icon="x"
                        size="sm"
                        label={`Remove ${day} ${toTime(h.from)}`}
                        onClick={() => set({ hours: b.hours.filter((_, j) => j !== i) })}
                      />
                    </div>
                  ))}
                </div>
                <IconButton
                  icon="plus"
                  size="sm"
                  label={`Add hours on ${day}`}
                  disabled={b.hours.length >= 42}
                  onClick={() => {
                    const last = ranges.at(-1)?.h;
                    const from = last ? Math.min(last.to + 60, 1380) : 540;
                    set({ hours: [...b.hours, { day: d, from, to: Math.min(from + 240, 1440) }] });
                  }}
                />
              </li>
            );
          })}
        </ul>
        {problems.length ? (
          <ul className={s.problems}>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        <div className={s.rowActions}>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => set({ hours: [1, 2, 3, 4, 5].map((day) => ({ day, from: 540, to: 1020 })) })}
          >
            Weekdays 9:00–17:00
          </Button>
        </div>
        <TextField
          label="Where you meet"
          value={b.place}
          maxLength={200}
          placeholder="A video link, a phone number or an address"
          onChange={(e) => set({ place: e.target.value }, "place")}
          hint="Public on the product page. For a private link, put it in Content instead: only buyers can open that."
        />
      </div>
    </Panel>
  );
}

function CommissionPanel({ draft, patch }: EditorProps) {
  const c = draft.def.commission ?? { depositPercent: 50 };
  const p = draft.def.price;
  const now = (BigInt(p.amount) * BigInt(c.depositPercent)) / 100n;
  return (
    <Panel title="Commission" kicker="ちゅうもん">
      <div className={s.stack}>
        <label className={s.rangeField}>
          <span>
            Deposit up front: <b>{c.depositPercent}%</b>
          </span>
          <input
            type="range"
            min={10}
            max={90}
            step={5}
            value={c.depositPercent}
            onChange={(e) => patch({ commission: { depositPercent: Number(e.target.value) } }, "deposit")}
          />
        </label>
        <p className={s.help}>
          The buyer pays {formatAmount(now, p.token)} now and {formatAmount(BigInt(p.amount) - now, p.token)} when you
          ask for the rest from Sales. What they get in Content is sealed to them after the second payment.
        </p>
      </div>
    </Panel>
  );
}

function BundlePanel({ draft, patch, tokened }: EditorProps) {
  const [mine, setMine] = useState<ProductDef[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const picked = draft.def.bundle?.productIds ?? [];
  useEffect(() => {
    void (async () => {
      try {
        const a = await tokened();
        const rows = await listMyProducts(a);
        const pub = rows.filter(
          (r) => r.status === "published" && r.record && r.id !== draft.def.id && r.kind !== "bundle",
        );
        // Titles from the working copy when it opens here; else the public record.
        setMine(
          await Promise.all(
            pub.map(async (r) => (await openDraft(a, r).catch(() => null))?.def ?? (r.record?.body as ProductDef)),
          ),
        );
      } catch (e) {
        setErr(failureText(e, "Your products could not be loaded."));
      }
    })();
  }, [tokened, draft.def.id]);
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...picked, id] : picked.filter((x) => x !== id);
    patch({ bundle: next.length ? { productIds: next.slice(0, 20) } : null });
  };
  const chosen = (mine ?? []).filter((m) => picked.includes(m.id));
  return (
    <Panel title="In this bundle" kicker="セット">
      <div className={s.stack}>
        <p className={s.help}>
          Pick two or more of your published products. A buyer gets each one sealed to them, for the bundle&rsquo;s
          price. A welcome note in Content is optional; if you add one, it opens first.
        </p>
        {err ? <p className={s.fieldErr}>{err}</p> : null}
        {mine === null && !err ? <Skeleton lines={2} /> : null}
        {mine && mine.length === 0 ? (
          <p className={s.muted}>Publish two products first, then bundle them here.</p>
        ) : null}
        {mine && mine.length ? (
          <ul className={s.pickList}>
            {mine.map((m) => (
              <li key={m.id}>
                <label className={s.pick}>
                  <input
                    type="checkbox"
                    checked={picked.includes(m.id)}
                    onChange={(e) => toggle(m.id, e.target.checked)}
                  />
                  <Thumb def={m} size={36} />
                  <span>
                    <b>{m.title}</b>
                    <small>{formatAmount(m.price.amount, m.price.token)}</small>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        ) : null}
        {picked.some((id) => mine && !mine.some((m) => m.id === id)) ? (
          <p className={s.warn}>
            A product in this bundle is no longer published, so the bundle cannot be published until you untick it or
            publish it again.
          </p>
        ) : null}
        {chosen.length >= 2 ? (
          <p className={s.note}>
            Bought separately: {sumByToken(chosen.map((m) => ({ amount: m.price.amount, token: m.price.token })))}. The
            bundle: {formatAmount(draft.def.price.amount, draft.def.price.token)}.
          </p>
        ) : null}
        {picked.length && mine
          ? picked
              .filter((id) => !mine.some((m) => m.id === id))
              .map((id) => (
                <Button key={id} size="sm" variant="ghost" icon="x" onClick={() => toggle(id, false)}>
                  Remove the unpublished product
                </Button>
              ))
          : null}
      </div>
    </Panel>
  );
}
