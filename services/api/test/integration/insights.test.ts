/**
 * Insights (spec 5.16) on a real Postgres: views and taps from day counters,
 * items received from envelope metadata (the owner's own notes excluded),
 * money from stored chain payments, form completion from form counters, each
 * for the last 7 days, 28 days and lifetime, with the previous period to
 * compare. Nothing returned is content.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signSiwq } from "@qorechain/qoresign";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "@mizuhiki/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
let app: FastifyInstance;
let close: () => Promise<void>;
let owner: ReadyPersona;
let token = "";
const day = (ago: number) => new Date(Date.now() - ago * 86400_000).toISOString().slice(0, 10);
const at = (ago: number) => new Date(Date.now() - ago * 86400_000 - 60_000);

interface Insights {
  views: { total: number; previous: number | null };
  items: { total: number; previous: number | null; byKind: Record<string, number> };
  money: {
    byDenom: { denom: string; total: string; count: number }[];
    previous: { denom: string; total: string }[] | null;
  };
  series: { at: string; views: number; items: number; payments: number }[];
  taps: { subject: string; count: number }[];
  forms: { id: string; title: string; views: number; starts: number; submits: number }[];
}

beforeAll(async () => {
  await runMigrations(DB);
  owner = await ensurePersona("insights-api-owner");
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`truncate counters, envelopes, payments, forms, sessions, auth_nonces`;
  const o = owner.address;
  // views: 5 today, 3 ten days ago, 2 forty days ago
  for (const [ago, n] of [
    [0, 5],
    [10, 3],
    [40, 2],
  ] as const)
    await sql`insert into counters (owner, day, kind, subject, count) values (${o}, ${day(ago)}, 'view', '', ${n})`;
  await sql`insert into counters (owner, day, kind, subject, count) values (${o}, ${day(1)}, 'tap', 'blockPay', 4), (${o}, ${day(2)}, 'tap', 'blockMsg', 6), (${o}, ${day(20)}, 'tap', 'blockMsg', 9)`;
  // items: 2 messages, 1 pay note and 1 file-request upload this week, 1 form answer last week,
  // 1 proof (the owner's own; excluded)
  const env = async (hash: string, kind: string, ago: number, ref: string | null = null) =>
    sql`insert into envelopes (hash, owner, kind, ref, size, readers, created_at) values (${hash.padEnd(64, "0")}, ${o}, ${kind}, ${ref}, 100, 1, ${at(ago)})`;
  await env("a1", "message", 0);
  await env("a2", "message", 2);
  await env("a3", "paynote", 3);
  await env("a4", "form", 9, "form:frm1");
  await env("a5", "proof", 1);
  await env("a6", "filedrop", 1, "freq:req1");
  // the owner's own filed notes: form tags and shared-snapshot keys (excluded everywhere, as proofs are)
  await env("a7", "formtags", 1, "form:frm1");
  await env("a8", "formsnaps", 1, "form:frm1");
  // money: 2.5 fUSD this week, 1 QOR thirty days ago, through the page; a plain 5 QOR top-up does not count
  await sql`insert into payments (tx_hash, msg_index, from_addr, to_addr, denom, amount, memo, kind, ref, height, time) values
    ('t1', 0, 'qor1x', ${o}, 'ufusd', '2000000', 'mzk:pay:r1', 'pay', 'r1', 1, ${at(1)}),
    ('t2', 0, 'qor1x', ${o}, 'ufusd', '500000', 'mzk:inv:r2', 'inv', 'r2', 2, ${at(4)}),
    ('t3', 0, 'qor1x', ${o}, 'uqor', '1000000', 'mzk:ord:r3', 'ord', 'r3', 3, ${at(30)}),
    ('t4', 0, 'qor1x', ${o}, 'uqor', '5000000', '', null, null, 4, ${at(2)})`;
  // a published form with 10 views, 6 starts, 3 submits this week
  await sql`insert into forms (id, owner, slug, draft_envelope, record, version) values ('frm1', ${o}, 'intake', ${"d".repeat(64)}, ${sql.json({ body: { title: "Client intake" } })}, 1)`;
  await sql`insert into counters (owner, day, kind, subject, count) values (${o}, ${day(1)}, 'fview', 'f:frm1', 10), (${o}, ${day(1)}, 'fstart', 'f:frm1', 6), (${o}, ${day(1)}, 'fsubmit', 'f:frm1', 3)`;
  await sql.end();
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-ins-")),
  });
  ({ app, close } = await buildServer(cfg));
  const c = (await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: owner.address } })).json<{
    message: string;
    nonce: string;
  }>();
  token = (
    await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: {
        nonce: c.nonce,
        signature: signSiwq({ message: c.message, classicalKey: owner.classical, pqKey: owner.pq }),
      },
    })
  ).json<{ token: string }>().token;
}, 600_000);

afterAll(async () => close());

const get = async (range: string) =>
  (
    await app.inject({ url: `/owner/insights?range=${range}`, headers: { authorization: `Bearer ${token}` } })
  ).json<Insights>();

describe("insights", () => {
  it("needs a session and a known range", async () => {
    expect((await app.inject({ url: "/owner/insights" })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/owner/insights?range=9", headers: { authorization: `Bearer ${token}` } })).statusCode,
    ).toBe(400);
  });

  it("last 7 days: tiles, the previous week, daily bars, most clicked blocks, form completion", async () => {
    const r = await get("7");
    expect(r.views).toEqual({ total: 5, previous: 3 });
    expect(r.items.total).toBe(4);
    expect(r.items.previous).toBe(1);
    expect(r.items.byKind).toEqual({ message: 2, paynote: 1, filedrop: 1 });
    expect(r.money.byDenom).toEqual([{ denom: "ufusd", total: "2500000", count: 2 }]);
    expect(r.money.previous).toEqual([]);
    expect(r.series).toHaveLength(7);
    expect(r.series.reduce((n, s) => n + s.views, 0)).toBe(5);
    expect(r.series.at(-1)?.at).toBe(day(0));
    expect(r.taps).toEqual([
      { subject: "blockMsg", count: 6 },
      { subject: "blockPay", count: 4 },
    ]);
    expect(r.forms).toEqual([{ id: "frm1", title: "Client intake", views: 10, starts: 6, submits: 3 }]);
  });

  it("28 days and lifetime widen the window; lifetime has no previous period and monthly bars", async () => {
    const r28 = await get("28");
    expect(r28.views.total).toBe(8);
    expect(r28.items.total).toBe(5);
    expect(r28.taps.find((t) => t.subject === "blockMsg")?.count).toBe(15);
    expect(r28.series).toHaveLength(28);
    const all = await get("all");
    expect(all.views).toEqual({ total: 10, previous: null });
    expect(all.money.byDenom.sort((a, b) => a.denom.localeCompare(b.denom))).toEqual([
      { denom: "ufusd", total: "2500000", count: 2 },
      { denom: "uqor", total: "1000000", count: 1 },
    ]);
    expect(all.series.every((s) => /^\d{4}-\d{2}$/.test(s.at))).toBe(true);
    expect(all.series.reduce((n, s) => n + s.views, 0)).toBe(10);
  });

  it("My page's numbers count the same received items and page payments as Insights", async () => {
    const r = (await app.inject({ url: "/owner/stats", headers: { authorization: `Bearer ${token}` } })).json<{
      items: Record<string, { count: number; unread: number }>;
      paid: { denom: string; total: string; count: number }[];
    }>();
    expect(Object.fromEntries(Object.entries(r.items).map(([k, v]) => [k, v.count]))).toEqual({
      message: 2,
      paynote: 1,
      form: 1,
      filedrop: 1,
    });
    expect(r.paid.sort((a, b) => a.denom.localeCompare(b.denom))).toEqual([
      { denom: "ufusd", total: "2500000", count: 2 },
      { denom: "uqor", total: "1000000", count: 1 },
    ]);
  });
});
