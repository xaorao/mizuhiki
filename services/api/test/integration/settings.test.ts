/**
 * Settings (spec 5.17) on a real Postgres: names, notification toggles and
 * subscriptions, a Web Push encrypted to a browser key (RFC 8291) and opened
 * here the way the browser would, with no content in it; a dead subscription
 * removed; delete my page hides the page and releases only this account's own holds.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import webpush from "web-push";
// http_ece ships with web-push (its encryption); used here only to open a push like a browser does.
import ece from "http_ece";
import { signSiwq } from "@qorechain/qoresign";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import type { FastifyInstance } from "fastify";
import { makeDb, runMigrations } from "@mizuhiki/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";
import { makePush } from "../../src/lib/push";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
let app: FastifyInstance;
let close: () => Promise<void>;
let owner: ReadyPersona;
let token = "";
const vapid = webpush.generateVAPIDKeys();
const cfgEnv = {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: "https://localhost",
};
const b64u = (b: Buffer) => b.toString("base64url");

beforeAll(async () => {
  await runMigrations(DB);
  owner = await ensurePersona("settings-api-owner");
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`truncate push_subscriptions, notify_prefs, sessions, auth_nonces`;
  await sql`delete from envelopes where owner = ${owner.address}`;
  await sql.end();
  const cfg = loadConfig({
    ...process.env,
    ...cfgEnv,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-set-")),
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
const auth = () => ({ authorization: `Bearer ${token}` });

describe("settings", () => {
  it("serves the push key and keeps toggles per account", async () => {
    expect((await app.inject({ url: "/push/key" })).json<{ publicKey: string }>().publicKey).toBe(vapid.publicKey);
    const first = (await app.inject({ url: "/owner/notifications", headers: auth() })).json<{
      enabled: boolean;
      prefs: Record<string, boolean>;
    }>();
    expect(first.enabled).toBe(true);
    expect(Object.values(first.prefs).every(Boolean)).toBe(true);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/owner/notifications",
          headers: auth(),
          payload: { prefs: { rooms: false, nonsense: true } },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/owner/notifications",
          headers: auth(),
          payload: { prefs: { rooms: false } },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/owner/notifications", headers: auth() })).json<{ prefs: Record<string, boolean> }>()
        .prefs.rooms,
    ).toBe(false);
    // Only the browsers' own push services are stored (review L1): not plain http, not any other host.
    for (const bad of ["https://127.0.0.1/x", "https://evil.example/fcm", "https://fcm.googleapis.com:8443/x"])
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/owner/push",
            headers: auth(),
            payload: { endpoint: bad, keys: { p256dh: "a", auth: "b" } },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/owner/push",
          headers: auth(),
          payload: { endpoint: "http://evil.example/x", keys: { p256dh: "a", auth: "b" } },
        })
      ).statusCode,
    ).toBe(400);
  });

  it("a push is encrypted to the browser, says only the kind, honours toggles and drops dead subscriptions", async () => {
    // A browser's subscription keys (P-256 and a 16-byte auth secret), as PushManager makes them.
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const authSecret = randomBytes(16);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString("hex")}`;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/owner/push",
          headers: auth(),
          payload: { endpoint, keys: { p256dh: b64u(browser.getPublicKey()), auth: b64u(authSecret) } },
        })
      ).statusCode,
    ).toBe(200);

    // The push service is captured: the real web-push encryption runs, the request is opened here.
    const sent: { endpoint: string; body: Buffer; headers: Record<string, string> }[] = [];
    const { db, sql } = makeDb(DB);
    const cfg = loadConfig({ ...process.env, ...cfgEnv, NODE_ENV: "test", DATABASE_URL: DB });
    const push = makePush(db, cfg, ((sub: webpush.PushSubscription, payload: string, opts?: webpush.RequestOptions) => {
      const r = webpush.generateRequestDetails(sub, payload, opts);
      sent.push({ endpoint: r.endpoint, body: Buffer.from(r.body), headers: r.headers });
      if (sub.endpoint.includes("gone")) return Promise.reject(Object.assign(new Error("gone"), { statusCode: 410 }));
      return Promise.resolve({ statusCode: 201, body: "", headers: {} });
    }) as typeof webpush.sendNotification);

    expect(await push.send(owner.address, "items")).toBe(1);
    expect(sent).toHaveLength(1);
    const req = sent[0];
    expect(req?.headers["Content-Encoding"]).toBe("aes128gcm");
    expect(req?.headers.Authorization).toMatch(/^vapid t=.+, k=/);
    const plain = ece.decrypt(req?.body ?? Buffer.alloc(0), {
      version: "aes128gcm",
      privateKey: browser,
      authSecret: b64u(authSecret),
    });
    const msg = JSON.parse(plain.toString("utf8")) as { type: string; title: string; body: string; url: string };
    expect(msg).toEqual({
      type: "items",
      title: "Something new arrived",
      body: "A sealed item is waiting in your inbox.",
      url: "/app/inbox",
    });
    // The same kind within a minute is not sent again; a kind turned off is never sent.
    expect(await push.send(owner.address, "items")).toBe(0);
    expect(await push.send(owner.address, "rooms")).toBe(0);
    // A subscription the push service no longer knows is removed.
    await sql`insert into push_subscriptions (endpoint, address, keys) values (${"https://fcm.googleapis.com/fcm/send/gone"}, ${owner.address}, ${JSON.stringify({ p256dh: b64u(browser.getPublicKey()), auth: b64u(authSecret) })}::jsonb)`;
    await push.send(owner.address, "payments");
    expect(
      (
        await sql`select count(*)::int as n from push_subscriptions where endpoint = ${"https://fcm.googleapis.com/fcm/send/gone"}`
      )[0]?.n,
    ).toBe(0);
    await sql.end();
  });

  it("lists the account's names", async () => {
    const r = (await app.inject({ url: "/owner/names", headers: auth() })).json<{
      names: unknown[];
      pageName: string | null;
    }>();
    expect(Array.isArray(r.names)).toBe(true);
    expect((await app.inject({ url: "/owner/names" })).statusCode).toBe(401);
  });

  it("delete my page needs the typed confirmation, then hides the page and sweeps stored items", async () => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(DB);
    const hash = randomBytes(32).toString("hex");
    await sql`insert into blobs (hash, size) values (${hash}, 10) on conflict do nothing`;
    await sql`insert into envelopes (hash, owner, kind, size, readers) values (${hash}, ${owner.address}, 'message', 10, 1)`;
    // The owner holds it for the drop; another account holds the same bytes for itself.
    await sql`insert into blob_holds (hash, holder, purpose) values (${hash}, ${owner.address}, ${`drop:${hash}`})`;
    await sql`insert into blob_holds (hash, holder, purpose) values (${hash}, ${"qor1someoneelse"}, ${"draft"})`;
    await sql`insert into pages (address, name, record, version) values (${owner.address}, ${"zz-del-test"}, ${sql.json({})}, 1) on conflict (address) do update set unpublished = false`;
    expect(
      (await app.inject({ method: "DELETE", url: "/owner/page", headers: auth(), payload: { confirm: "yes" } }))
        .statusCode,
    ).toBe(400);
    const r = await app.inject({
      method: "DELETE",
      url: "/owner/page",
      headers: auth(),
      payload: { confirm: "delete my page" },
    });
    expect(r.statusCode).toBe(200);
    expect((await sql`select count(*)::int as n from envelopes where owner = ${owner.address}`)[0]?.n).toBe(0);
    expect((await sql`select unpublished from pages where address = ${owner.address}`)[0]?.unpublished).toBe(true);
    // Only the owner's own hold went; the other account's copy is untouched.
    const holds = await sql<{ holder: string }[]>`select holder from blob_holds where hash = ${hash}`;
    expect(holds.map((h) => h.holder)).toEqual(["qor1someoneelse"]);
    await sql`delete from blob_holds where hash = ${hash}`;
    await sql.end();
  });
});
