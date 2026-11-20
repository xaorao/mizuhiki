/**
 * Insights (spec 5.16): activity without content. Views and taps are
 * aggregate day counters (no IPs, no cookies); items received come from blob
 * metadata (kind and time only); money comes from payments the indexer read
 * from QoreChain; form completion from the forms' own counters.
 */
import type { FastifyPluginCallback } from "fastify";
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import { counters, envelopes, forms, payments } from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { fail } from "../lib/http";
import { DROP_KINDS, SELF_KINDS } from "./drop";

/** Item kinds a visitor or payer sends (not the owner's own notes, labels or proofs). */
/** Everything other people seal to this owner: every drop kind except the owner's own private labels. */
const RECEIVED: string[] = DROP_KINDS.filter((k) => !SELF_KINDS.includes(k));
const DAY = 86400_000;
const dayKey = (t: number) => new Date(t).toISOString().slice(0, 10);

export const insightRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    app.get("/owner/insights", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const q = z.object({ range: z.enum(["7", "28", "all"]).default("7") }).safeParse(req.query);
      if (!q.success) return fail(reply, 400, "BAD_REQUEST", "That range is not valid.");
      const range = q.data.range;
      const now = Date.now();
      // Days are UTC calendar days; "7" means today and the six days before it.
      const span = range === "all" ? null : Number(range);
      const start = span ? Date.parse(`${dayKey(now - (span - 1) * DAY)}T00:00:00Z`) : 0;
      const prevStart = span ? start - span * DAY : 0;

      // ---- views and taps (day counters)
      const viewRows = await db
        .select({ day: counters.day, n: sql<number>`sum(${counters.count})::int` })
        .from(counters)
        .where(and(eq(counters.owner, me), eq(counters.kind, "view")))
        .groupBy(counters.day);
      const inRange = (d: string) => (span ? d >= dayKey(start) : true);
      const inPrev = (d: string) => (span ? d >= dayKey(prevStart) && d < dayKey(start) : false);
      const views = {
        total: viewRows.filter((r) => inRange(r.day)).reduce((n, r) => n + r.n, 0),
        previous: span ? viewRows.filter((r) => inPrev(r.day)).reduce((n, r) => n + r.n, 0) : null,
      };
      const tapRows = await db
        .select({ subject: counters.subject, day: counters.day, n: sql<number>`sum(${counters.count})::int` })
        .from(counters)
        .where(and(eq(counters.owner, me), eq(counters.kind, "tap")))
        .groupBy(counters.subject, counters.day);
      const taps = new Map<string, number>();
      for (const r of tapRows) if (inRange(r.day)) taps.set(r.subject, (taps.get(r.subject) ?? 0) + r.n);

      // ---- items received (metadata only)
      const itemRows = await db
        .select({
          day: sql<string>`to_char(${envelopes.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`,
          kind: envelopes.kind,
          n: sql<number>`count(*)::int`,
        })
        .from(envelopes)
        .where(
          and(
            eq(envelopes.owner, me),
            inArray(envelopes.kind, RECEIVED),
            ...(span ? [gte(envelopes.createdAt, new Date(prevStart))] : []),
          ),
        )
        .groupBy(sql`1`, envelopes.kind);
      const items = {
        total: itemRows.filter((r) => inRange(r.day)).reduce((n, r) => n + r.n, 0),
        previous: span ? itemRows.filter((r) => inPrev(r.day)).reduce((n, r) => n + r.n, 0) : null,
        byKind: Object.fromEntries(
          RECEIVED.map((k): [string, number] => [
            k,
            itemRows.filter((r) => r.kind === k && inRange(r.day)).reduce((n, r) => n + r.n, 0),
          ]).filter(([, n]) => n > 0),
        ),
      };

      // ---- money received (from chain data the indexer stored)
      const payRows = await db
        .select({
          day: sql<string>`to_char(${payments.time} at time zone 'UTC', 'YYYY-MM-DD')`,
          denom: payments.denom,
          total: sql<string>`sum(${payments.amount}::numeric)::text`,
          n: sql<number>`count(*)::int`,
        })
        .from(payments)
        // Payments made through the page carry a Mizuhiki reference (pay, invoice, order); a plain transfer such as
        // a wallet top-up is not money the page received.
        .where(
          and(
            eq(payments.toAddr, me),
            isNotNull(payments.kind),
            ...(span ? [gte(payments.time, new Date(prevStart))] : []),
          ),
        )
        .groupBy(sql`1`, payments.denom);
      const sum = (rows: typeof payRows) => {
        const m = new Map<string, { total: bigint; count: number }>();
        for (const r of rows) {
          const cur = m.get(r.denom) ?? { total: 0n, count: 0 };
          m.set(r.denom, { total: cur.total + BigInt(r.total.split(".")[0] ?? "0"), count: cur.count + r.n });
        }
        return [...m].map(([denom, v]) => ({ denom, total: v.total.toString(), count: v.count }));
      };
      const money = {
        byDenom: sum(payRows.filter((r) => inRange(r.day))),
        previous: span ? sum(payRows.filter((r) => inPrev(r.day))) : null,
      };

      // ---- the activity chart: one bar per day (or per month for lifetime)
      const buckets: string[] = [];
      if (span) for (let i = 0; i < span; i++) buckets.push(dayKey(start + i * DAY));
      else {
        const first =
          [...viewRows.map((r) => r.day), ...itemRows.map((r) => r.day), ...payRows.map((r) => r.day)].sort()[0] ??
          dayKey(now);
        const d = new Date(`${first.slice(0, 7)}-01T00:00:00Z`);
        const end = dayKey(now).slice(0, 7);
        while (d.toISOString().slice(0, 7) <= end) {
          buckets.push(d.toISOString().slice(0, 7));
          d.setUTCMonth(d.getUTCMonth() + 1);
        }
      }
      const key = (day: string) => (span ? day : day.slice(0, 7));
      const series = buckets.map((b) => ({
        at: b,
        views: viewRows.filter((r) => key(r.day) === b).reduce((n, r) => n + r.n, 0),
        items: itemRows.filter((r) => key(r.day) === b).reduce((n, r) => n + r.n, 0),
        payments: payRows.filter((r) => key(r.day) === b).reduce((n, r) => n + r.n, 0),
      }));

      // ---- form completion (the forms' own counters, in range)
      const own = await db
        .select({ id: forms.id, slug: forms.slug, record: forms.record, archived: forms.archived })
        .from(forms)
        .where(eq(forms.owner, me));
      const formRows = own.length
        ? await db
            .select({
              kind: counters.kind,
              subject: counters.subject,
              day: counters.day,
              n: sql<number>`sum(${counters.count})::int`,
            })
            .from(counters)
            .where(
              and(
                eq(counters.owner, me),
                sql`${counters.kind} in ('fview','fstart','fsubmit')`,
                ...(span ? [gte(counters.day, dayKey(start))] : [lt(counters.day, "9999")]),
              ),
            )
            .groupBy(counters.kind, counters.subject, counters.day)
        : [];
      const formStats = own
        .filter((f) => f.record && !f.archived)
        .map((f) => {
          const get = (k: string) =>
            formRows.filter((r) => r.kind === k && r.subject === `f:${f.id}`).reduce((n, r) => n + r.n, 0);
          const title = (f.record as { body?: { title?: string } }).body?.title ?? f.slug;
          return { id: f.id, title, views: get("fview"), starts: get("fstart"), submits: get("fsubmit") };
        })
        .sort((a, b) => b.views - a.views);

      return {
        range,
        from: span ? new Date(start).toISOString() : null,
        views,
        items,
        money,
        series,
        taps: [...taps].map(([subject, count]) => ({ subject, count })).sort((a, b) => b.count - a.count),
        forms: formStats,
      };
    });

    done();
  };
