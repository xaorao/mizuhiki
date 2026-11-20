/**
 * Blob holds (THREAT_MODEL A2, security review H1): knowing a hash must never
 * let anyone delete another account's stored copy. The attack from the review
 * is replayed (hold a victim's blob as one's own draft, then discard it; drop
 * it to oneself as a file piece, then delete one's page) and the victim's copy
 * must survive the sweep. Also checks the sweep's own rules on a real Postgres.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { signSiwq } from "@qorechain/qoresign";
import { Purpose, publicRecipient, sealItem, solvePow, toBase64Url, utf8 } from "@mizuhiki/core";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "@mizuhiki/db";
import { loadConfig } from "../../src/config";
import { buildServer, type Ctx } from "../../src/server";
import { sweepBlobs } from "../../src/routes/blobs";
import { hold } from "../../src/lib/holds";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
let app: FastifyInstance;
let ctx: Ctx;
let close: () => Promise<void>;
let victim: ReadyPersona;
let attacker: ReadyPersona;
let vt = "";
let at = "";

async function signIn(p: ReadyPersona): Promise<string> {
  const c = (await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: p.address } })).json<{
    message: string;
    nonce: string;
  }>();
  return (
    await app.inject({
      method: "POST",
      url: "/auth/verify",
      payload: { nonce: c.nonce, signature: signSiwq({ message: c.message, classicalKey: p.classical, pqKey: p.pq }) },
    })
  ).json<{ token: string }>().token;
}
const auth = (t: string) => ({ authorization: `Bearer ${t}` });
const sql = async () => (await import("postgres")).default(DB);
/** Make a blob look older than the unclaimed grace, so only holds keep it. */
async function age(hash: string) {
  const s = await sql();
  await s`update blobs set created_at = now() - interval '2 days' where hash = ${hash}`;
  await s.end();
}
async function upload(bytes: Uint8Array): Promise<string> {
  const r = await app.inject({
    method: "PUT",
    url: "/blobs",
    payload: Buffer.from(bytes),
    headers: { "content-type": "application/octet-stream" },
  });
  return r.json<{ hash: string }>().hash;
}
const stored = async (hash: string) => (await app.inject({ url: `/blobs/${hash}` })).statusCode === 200;

beforeAll(async () => {
  await runMigrations(DB);
  victim = await ensurePersona("holds-victim");
  attacker = await ensurePersona("holds-attacker");
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-holds-")),
  });
  const built = await buildServer(cfg);
  ({ app, close } = built);
  ctx = built.ctx;
  vt = await signIn(victim);
  at = await signIn(attacker);
  for (const [p, t] of [
    [victim, vt],
    [attacker, at],
  ] as const)
    await app.inject({ method: "PUT", url: "/cards", headers: auth(t), payload: { card: p.card } });
}, 600_000);
afterAll(async () => close());

describe("blob holds", () => {
  it("a victim's draft survives the attacker holding and discarding it as their own draft", async () => {
    const hash = await upload(randomBytes(2048));
    expect(
      (await app.inject({ method: "PUT", url: "/drafts", headers: auth(vt), payload: { blobHash: hash } })).statusCode,
    ).toBe(200);
    // The attack from the review: hold it as one's own draft, then discard it.
    expect(
      (await app.inject({ method: "PUT", url: "/drafts", headers: auth(at), payload: { blobHash: hash } })).statusCode,
    ).toBe(200);
    expect((await app.inject({ method: "DELETE", url: "/drafts", headers: auth(at) })).statusCode).toBe(200);
    await age(hash);
    await sweepBlobs(ctx);
    expect(await stored(hash)).toBe(true);
    // When the victim discards it themselves, it goes.
    expect((await app.inject({ method: "DELETE", url: "/drafts", headers: auth(vt) })).statusCode).toBe(200);
    await sweepBlobs(ctx);
    expect(await stored(hash)).toBe(false);
  });

  it("dropping a victim's blob to oneself as a file piece, then deleting one's page, leaves it alone", async () => {
    const victimBlob = await upload(randomBytes(4096));
    await hold(ctx.db, [victimBlob], victim.address, "product:victim-item");
    const bits = (await app.inject({ url: "/drop/config" })).json<{ powBits: number }>().powBits;
    const sealed = sealItem({
      purpose: Purpose.message,
      readers: [publicRecipient(attacker.seal)],
      plaintext: utf8("{}"),
      anonymous: true,
    });
    const drop = await app.inject({
      method: "POST",
      url: `/drop/${attacker.address}`,
      payload: {
        envelope: toBase64Url(sealed.envelope),
        kind: "message",
        chunks: [victimBlob],
        pow: solvePow(attacker.address, sealed.hash, bits),
      },
    });
    expect(drop.statusCode).toBe(200);
    const s = await sql();
    await s`insert into pages (address, name, record, version) values (${attacker.address}, ${"zz-holds-attacker"}, ${s.json({})}, 1) on conflict (address) do update set unpublished = false`;
    await s.end();
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/owner/page",
          headers: auth(at),
          payload: { confirm: "delete my page" },
        })
      ).statusCode,
    ).toBe(200);
    await age(victimBlob);
    await sweepBlobs(ctx);
    expect(await stored(victimBlob)).toBe(true);
  });

  it("the sweep: unheld old uploads go, new uploads wait a day, live holds keep, expired holds do not", async () => {
    const fresh = await upload(randomBytes(64));
    const orphan = await upload(randomBytes(64));
    const kept = await upload(randomBytes(64));
    const lapsed = await upload(randomBytes(64));
    await hold(ctx.db, [kept], victim.address, "media");
    await hold(ctx.db, [lapsed], victim.address, `drop:${lapsed}`, new Date(Date.now() - 1000));
    for (const h of [orphan, kept, lapsed]) await age(h);
    await sweepBlobs(ctx);
    expect(await stored(fresh)).toBe(true);
    expect(await stored(orphan)).toBe(false);
    expect(await stored(kept)).toBe(true);
    expect(await stored(lapsed)).toBe(false);
  });
});
