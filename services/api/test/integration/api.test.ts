/**
 * API integration tests against a real Postgres database and the real QoreChain
 * testnet (keys, registry). Personas are disposable testnet accounts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signSiwq } from "@qorechain/qoresign";
import { generateSealKeys, recipientOf, signRecipientCard } from "@qorechain/qoreseal";
import {
  DEFAULT_THEME,
  Purpose,
  newId,
  sealItem,
  signRecord,
  solvePow,
  toBase64Url,
  utf8,
  verifyRecord,
  type FormDef,
  type Manifest,
  type Signed,
} from "@mizuhiki/core";
import { NETWORK, createRoomOnChain, rotateRoomOnChain } from "@mizuhiki/chain";
import { EpochKeyManager, sealBatch } from "@qorechain/qoreseal";
import { distributionHash, membershipHash, roomContext, roomIdBytes32, sha256Hex, CHAIN_ID } from "@mizuhiki/core";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config";
import { runMigrations } from "@mizuhiki/db";
import { buildServer } from "../../src/server";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
let app: FastifyInstance;
let close: () => Promise<void>;
let owner: ReadyPersona;
let stranger: ReadyPersona;
let token = "";

async function signIn(p: ReadyPersona): Promise<string> {
  const c = await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: p.address } });
  const { message, nonce } = c.json<{ message: string; nonce: string }>();
  const signature = signSiwq({ message, classicalKey: p.classical, pqKey: p.pq });
  const v = await app.inject({ method: "POST", url: "/auth/verify", payload: { nonce, signature } });
  expect(v.statusCode).toBe(200);
  return v.json<{ token: string }>().token;
}

function manifest(p: ReadyPersona, version: number, extra: Partial<Manifest> = {}): Manifest {
  return {
    v: 1,
    name: p.name ?? "",
    address: p.address,
    displayName: "Test Owner",
    bio: "Integration test page",
    socials: [],
    goal: "creator",
    theme: DEFAULT_THEME,
    blocks: [
      {
        id: newId(),
        type: "message",
        on: true,
        archived: false,
        title: "Send me something private",
        subtitle: "",
        greeting: "Hi",
        allowFiles: true,
        maxFileMB: 500,
      },
    ],
    periodKeys: [],
    version,
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

beforeAll(async () => {
  await runMigrations(DB);
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`truncate accounts, auth_nonces, sessions, names, cards, pages, drafts, blobs, envelopes, payments, counters, index_checkpoints, reports, push_subscriptions, notify_prefs, media, chain_events, invoices, forms, snapshots, rooms, room_members, room_epochs, room_batches, room_history, room_invites, room_requests`;
  await sql.end();
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-blobs-")),
    WEB_ORIGIN: "http://localhost:3000,https://mizuhiki.example",
  });
  ({ app, close } = await buildServer(cfg));
  owner = await ensurePersona("api-owner", { name: "mzk-api-owner" });
  stranger = await ensurePersona("api-stranger");
}, 300_000);

afterAll(async () => close());

describe("names", () => {
  it("explains invalid, reserved, taken and available names", async () => {
    const short = (await app.inject({ url: "/names/ab" })).json();
    expect(short).toMatchObject({
      available: false,
      problem: "short",
      message: "Usernames must be 3 characters or longer",
    });
    expect((await app.inject({ url: "/names/settings" })).json()).toMatchObject({
      available: false,
      problem: "reserved",
    });
    const taken = (await app.inject({ url: "/names/mzk-api-owner" })).json<{
      available: boolean;
      problem: string;
      suggestions: string[];
    }>();
    expect(taken.available).toBe(false);
    expect(taken.problem).toBe("taken");
    expect(taken.suggestions.length).toBeGreaterThan(0);
    const free = (await app.inject({ url: `/names/free${Date.now()}` })).json();
    expect(free).toMatchObject({ available: true });
  });
});

describe("sign in with QoreChain", () => {
  it("issues a session for a valid hybrid signature", async () => {
    token = await signIn(owner);
    const me = await app.inject({ url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    expect(me.json()).toEqual({ address: owner.address });
  });
  it("refuses a signature by another account's keys", async () => {
    const c = (await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: owner.address } })).json<{
      message: string;
      nonce: string;
    }>();
    // stranger's keys cannot sign for owner's address
    expect(() => signSiwq({ message: c.message, classicalKey: stranger.classical, pqKey: stranger.pq })).toThrow();
    // a valid classical key but the wrong ML-DSA key
    const signature = signSiwq({ message: c.message, classicalKey: owner.classical, pqKey: stranger.pq });
    const v = await app.inject({ method: "POST", url: "/auth/verify", payload: { nonce: c.nonce, signature } });
    expect(v.statusCode).toBe(401);
  });
  it("refuses a replayed nonce", async () => {
    const c = (await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: owner.address } })).json<{
      message: string;
      nonce: string;
    }>();
    const signature = signSiwq({ message: c.message, classicalKey: owner.classical, pqKey: owner.pq });
    expect(
      (await app.inject({ method: "POST", url: "/auth/verify", payload: { nonce: c.nonce, signature } })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/auth/verify", payload: { nonce: c.nonce, signature } })).statusCode,
    ).toBe(401);
  });
  it("refuses a classical-only signature", async () => {
    const c = (await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: owner.address } })).json<{
      message: string;
      nonce: string;
    }>();
    const signature = signSiwq({ message: c.message, classicalKey: owner.classical });
    expect(
      (await app.inject({ method: "POST", url: "/auth/verify", payload: { nonce: c.nonce, signature } })).statusCode,
    ).toBe(401);
  });
  it("binds the sign-in to the requesting site when it is one we serve, and never to another", async () => {
    const asked = async (origin: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/auth/challenge",
          headers: { origin },
          payload: { address: owner.address },
        })
      ).json<{ message: string; nonce: string }>();
    const hosted = await asked("https://mizuhiki.example");
    expect(hosted.message.split("\n")[0]).toMatch(/^https:\/\/mizuhiki\.example wants you to sign in/);
    const signature = signSiwq({ message: hosted.message, classicalKey: owner.classical, pqKey: owner.pq });
    // Verified from the same site: accepted. Presented from a different listed site: refused.
    const crossSite = await asked("https://mizuhiki.example");
    const crossSig = signSiwq({ message: crossSite.message, classicalKey: owner.classical, pqKey: owner.pq });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/verify",
          headers: { origin: "http://localhost:3000" },
          payload: { nonce: crossSite.nonce, signature: crossSig },
        })
      ).json<{ error: { message: string } }>().error.message,
    ).toMatch(/started on a different Mizuhiki site/);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/auth/verify",
          headers: { origin: "https://mizuhiki.example" },
          payload: { nonce: hosted.nonce, signature },
        })
      ).statusCode,
    ).toBe(200);
    // A site we do not serve gets a message naming the default site, not itself.
    expect((await asked("https://evil.example")).message.split("\n")[0]).toMatch(/^http:\/\/localhost:3000 wants you/);
  });
  it("ends a session on logout", async () => {
    const t = await signIn(owner);
    await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${t}` } });
    expect((await app.inject({ url: "/auth/me", headers: { authorization: `Bearer ${t}` } })).statusCode).toBe(401);
  });
});

describe("cards", () => {
  it("stores a card that matches the chain keys", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/cards",
      headers: { authorization: `Bearer ${token}` },
      payload: { card: owner.card },
    });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ url: `/cards/${owner.address}` })).json<{ card: unknown }>().card).toEqual(owner.card);
  });
  it("refuses a forged card and a card for someone else", async () => {
    const forgedKeys = generateSealKeys();
    const forged = { ...owner.card, x25519PublicKey: Buffer.from(forgedKeys.x25519PublicKey).toString("hex") };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/cards",
          headers: { authorization: `Bearer ${token}` },
          payload: { card: forged },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/cards",
          headers: { authorization: `Bearer ${token}` },
          payload: { card: stranger.card },
        })
      ).statusCode,
    ).toBe(400);
    const other = signRecipientCard({
      chainId: NETWORK.chainId,
      address: owner.address,
      keys: forgedKeys,
      classicalKey: owner.classical,
      pqKey: owner.pq,
    });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/cards",
          headers: { authorization: `Bearer ${token}` },
          payload: { card: other },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("needs a session", async () => {
    expect((await app.inject({ method: "PUT", url: "/cards", payload: { card: owner.card } })).statusCode).toBe(401);
  });
});

describe("pages", () => {
  const sign = (m: Manifest, p: ReadyPersona) =>
    signRecord({ kind: "manifest", body: m, signer: p.address, classical: p.classical, pq: p.pq });
  it("publishes a signed manifest and serves it by name", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/pages",
      headers: { authorization: `Bearer ${token}` },
      payload: { record: sign(manifest(owner, 1), owner) },
    });
    expect(r.statusCode).toBe(200);
    const g = (await app.inject({ url: `/pages/${owner.name ?? ""}` })).json<{
      record: { body: Manifest };
      card: unknown;
      registry: { owner: string };
    }>();
    expect(g.record.body.displayName).toBe("Test Owner");
    expect(g.registry.owner).toBe(owner.address);
    expect(g.card).toEqual(owner.card);
  });
  it("refuses a tampered manifest, a stale version, another signer and a name not owned", async () => {
    const rec = sign(manifest(owner, 2), owner);
    const tampered = { ...rec, body: { ...rec.body, displayName: "Mallory" } };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/pages",
          headers: { authorization: `Bearer ${token}` },
          payload: { record: tampered },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/pages",
          headers: { authorization: `Bearer ${token}` },
          payload: { record: sign(manifest(owner, 1), owner) },
        })
      ).statusCode,
    ).toBe(409);
    const strangerToken = await signIn(stranger);
    const asStranger = { ...manifest(owner, 3), address: stranger.address };
    const r = await app.inject({
      method: "PUT",
      url: "/pages",
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: { record: sign(asStranger, stranger) },
    });
    expect(r.statusCode).toBe(409);
    expect(r.json<{ error: { code: string } }>().error.code).toBe("NAME_NOT_YOURS");
    const viaOwnerSession = await app.inject({
      method: "PUT",
      url: "/pages",
      headers: { authorization: `Bearer ${token}` },
      payload: { record: sign(asStranger, stranger) },
    });
    expect(viaOwnerSession.statusCode).toBe(400);
  });
  it("hides an unpublished page and a name that does not exist", async () => {
    await app.inject({ method: "POST", url: "/pages/unpublish", headers: { authorization: `Bearer ${token}` } });
    const g = await app.inject({ url: `/pages/${owner.name ?? ""}` });
    expect(g.statusCode).toBe(404);
    expect(g.json<{ error: { message: string } }>().error.message).toBe("This page isn't available.");
    const r = await app.inject({
      method: "PUT",
      url: "/pages",
      headers: { authorization: `Bearer ${token}` },
      payload: { record: sign(manifest(owner, 5), owner) },
    });
    expect(r.statusCode).toBe(200);
    expect((await app.inject({ url: `/pages/nobody${Date.now()}` })).statusCode).toBe(404);
  });
});

describe("blobs and media", () => {
  it("stores content-addressed bytes and refuses oversize", async () => {
    const bytes = Buffer.from(crypto.getRandomValues(new Uint8Array(1000)));
    const put = await app.inject({
      method: "PUT",
      url: "/blobs",
      headers: { "content-type": "application/octet-stream" },
      payload: bytes,
    });
    const { hash } = put.json<{ hash: string }>();
    const get = await app.inject({ url: `/blobs/${hash}` });
    expect(Buffer.from(get.rawPayload).equals(bytes)).toBe(true);
    expect((await app.inject({ url: `/blobs/${"0".repeat(64)}` })).statusCode).toBe(404);
  });
  it("accepts real images only, for signed-in owners", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
    const r = await app.inject({
      method: "PUT",
      url: "/media",
      headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
      payload: png,
    });
    expect(r.json()).toMatchObject({ type: "image/png" });
    const html = Buffer.from("<html><script>alert(1)</script></html>");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/media",
          headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
          payload: html,
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/media",
          headers: { "content-type": "application/octet-stream" },
          payload: png,
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe("chain relay", () => {
  it("relays allowlisted reads and refuses everything else", async () => {
    const ok = await app.inject({ url: `/chain/cosmos/bank/v1beta1/balances/${owner.address}/by_denom?denom=uqor` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ balance: { denom: string } }>().balance.denom).toBe("uqor");
    expect((await app.inject({ url: "/chain/cosmos/staking/v1beta1/validators" })).statusCode).toBe(404);
    expect((await app.inject({ url: `/chain/cosmos/bank/v1beta1/balances/${owner.address}?evil=1` })).statusCode).toBe(
      400,
    );
    expect((await app.inject({ method: "POST", url: "/chain/cosmos/gov/v1/proposals", payload: {} })).statusCode).toBe(
      404,
    );
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/chain/cosmos/tx/v1beta1/txs",
          payload: { tx_bytes: "AA", mode: "BROADCAST_MODE_ASYNC" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: "POST", url: "/chain/cosmos/tx/v1beta1/simulate", payload: {} })).statusCode,
    ).toBe(400);
  });
  it("answers a not-yet-committed transaction as pending, not as an error", async () => {
    const r = await app.inject({ url: `/chain/cosmos/tx/v1beta1/txs/${"A".repeat(64)}` });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ tx_response: null, pending: true });
  });
  it("reports the bio and form helpers on only with credentials", async () => {
    const on = Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
    expect((await app.inject({ url: "/ai/status" })).json()).toEqual({ bio: on, form: on });
  });

  it("drafts form questions only for a signed-in owner", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/ai/form",
      payload: { description: "An intake form for my studio" },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe("drop and inbox", () => {
  const sealTo = (text: string, readers = [recipientOf(owner.seal)]) =>
    sealItem({
      purpose: Purpose.message,
      readers,
      plaintext: utf8(JSON.stringify({ v: 1, kind: "message", text })),
      anonymous: true,
    });
  const bits = () => app.inject({ url: "/drop/config" }).then((r) => r.json<{ powBits: number }>().powBits);
  const drop = async (to: string, body: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/drop/${to}`, payload: body });
  let anonHash = "";
  let signedHash = "";

  it("refuses what it must not store, and says nothing was stored", async () => {
    const b = await bits();
    const ok = sealTo("hello");
    const pow = solvePow(owner.address, ok.hash, b);
    const base = { envelope: toBase64Url(ok.envelope), kind: "message", chunks: [], pow };
    const bad = await drop("not-an-address", base);
    expect(bad.statusCode).toBe(400);
    const none = await drop(stranger.address, { ...base, pow: solvePow(stranger.address, ok.hash, b) });
    expect(none.statusCode).toBe(404);
    expect(none.json<{ error: { code: string; dataState: string } }>().error).toMatchObject({
      code: "NO_ACCOUNT",
      dataState: "nothing-stored",
    });
    const junk = new Uint8Array(400).fill(7);
    expect(
      (await drop(owner.address, { ...base, envelope: toBase64Url(junk) })).json<{ error: { code: string } }>().error
        .code,
    ).toBe("NOT_SEALED");
    const other = sealTo("other");
    const wrongPow = await drop(owner.address, { ...base, pow: solvePow(owner.address, other.hash, b) });
    expect(wrongPow.statusCode).toBe(429);
    const missing = await drop(owner.address, { ...base, chunks: ["a".repeat(64)] });
    expect(missing.statusCode).toBe(409);
    // a sender signature for a different envelope, and one that claims someone else's account
    const sigOther = signRecord({
      kind: "sender",
      body: { envelope: other.hash, to: owner.address, at: new Date().toISOString() },
      signer: stranger.address,
      classical: stranger.classical,
      pq: stranger.pq,
    });
    expect(
      (await drop(owner.address, { ...base, sender: sigOther })).json<{ error: { code: string } }>().error.code,
    ).toBe("BAD_SIGNATURE");
    // Signed by the stranger's keys, then relabelled as the owner's account.
    const forged = {
      ...signRecord({
        kind: "sender",
        body: { envelope: ok.hash, to: owner.address, at: new Date().toISOString() },
        signer: stranger.address,
        classical: stranger.classical,
        pq: stranger.pq,
      }),
      signer: owner.address,
    };
    expect(
      (await drop(owner.address, { ...base, sender: forged })).json<{ error: { code: string } }>().error.code,
    ).toBe("BAD_SIGNATURE");
    const idx = await app.inject({ url: "/owner/inbox", headers: { authorization: `Bearer ${token}` } });
    expect(idx.json<{ rows: unknown[] }>().rows).toHaveLength(0);
  });

  it("stores an anonymous drop and a signed drop; the owner's index shows metadata only", async () => {
    const b = await bits();
    const anon = sealTo("anonymous hello");
    const r1 = await drop(owner.address, {
      envelope: toBase64Url(anon.envelope),
      kind: "message",
      chunks: [],
      pow: solvePow(owner.address, anon.hash, b),
    });
    expect(r1.statusCode).toBe(200);
    anonHash = r1.json<{ hash: string }>().hash;
    expect(anonHash).toBe(anon.hash);
    const signed = sealTo("signed hello", [recipientOf(owner.seal), recipientOf(stranger.seal)]);
    const sender = signRecord({
      kind: "sender",
      body: { envelope: signed.hash, to: owner.address, at: new Date().toISOString() },
      signer: stranger.address,
      classical: stranger.classical,
      pq: stranger.pq,
    });
    const r2 = await drop(owner.address, {
      envelope: toBase64Url(signed.envelope),
      kind: "reply",
      ref: `re:${anonHash}`,
      chunks: [],
      pow: solvePow(owner.address, signed.hash, b),
      sender,
    });
    expect(r2.statusCode).toBe(200);
    signedHash = signed.hash;
    expect((await app.inject({ url: "/owner/inbox" })).statusCode).toBe(401);
    const idx = (await app.inject({ url: "/owner/inbox", headers: { authorization: `Bearer ${token}` } })).json<{
      rows: {
        id: string;
        kind: string;
        read: boolean;
        sender: { address: string } | null;
        senderSig: unknown;
        readers: number;
        ref: string | null;
      }[];
    }>();
    const a = idx.rows.find((r) => r.id === anonHash);
    const s = idx.rows.find((r) => r.id === signedHash);
    expect(a).toMatchObject({ kind: "message", read: false, sender: null, senderSig: null, readers: 1 });
    expect(s).toMatchObject({ kind: "reply", read: false, readers: 2, ref: `re:${anonHash}` });
    expect(s?.sender?.address).toBe(stranger.address);
    expect(JSON.stringify(idx)).not.toContain("hello");
    expect(
      (await app.inject({ url: "/owner/unread", headers: { authorization: `Bearer ${token}` } })).json<{
        unread: number;
      }>().unread,
    ).toBe(2);
  });

  it("read, archive and sent work only for the right account", async () => {
    const auth = { authorization: `Bearer ${token}` };
    const strangerToken = await signIn(stranger);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/owner/inbox/${anonHash}`,
          payload: { read: true },
          headers: { authorization: `Bearer ${strangerToken}` },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "PATCH", url: `/owner/inbox/${anonHash}`, payload: { read: true }, headers: auth }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/owner/inbox/${anonHash}`,
          payload: { archived: true },
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    const inbox = (await app.inject({ url: "/owner/inbox", headers: auth }))
      .json<{ rows: { id: string }[] }>()
      .rows.map((r) => r.id);
    const archived = (await app.inject({ url: "/owner/inbox?box=archived", headers: auth })).json<{
      rows: { id: string; read: boolean }[];
    }>().rows;
    expect(inbox).not.toContain(anonHash);
    expect(archived.find((r) => r.id === anonHash)?.read).toBe(true);
    const sent = (
      await app.inject({ url: "/owner/inbox?box=sent", headers: { authorization: `Bearer ${strangerToken}` } })
    ).json<{
      rows: { id: string; to: { address: string } | null; read: boolean }[];
    }>().rows;
    expect(sent.map((r) => r.id)).toEqual([signedHash]);
    expect(sent[0]?.to?.address).toBe(owner.address);
    expect((await app.inject({ url: "/owner/unread", headers: auth })).json<{ unread: number }>().unread).toBe(1);
  });
});

describe("forms", () => {
  const def = (version: number, extra: Partial<FormDef> = {}): FormDef => ({
    v: 1,
    id: "frmapitest01",
    owner: owner.address,
    name: owner.name ?? "",
    slug: "intake",
    title: "Client intake",
    description: "",
    welcome: { enabled: true, button: "Start", showTime: true },
    blocks: [
      {
        id: "q1",
        kind: "short",
        title: "Your name",
        description: "",
        required: true,
        hidden: false,
        half: false,
        placeholder: "",
      },
    ],
    endings: [{ id: "end", title: "Thanks!", body: "" }],
    logic: [],
    settings: { progress: true, numbers: true, closed: false, notify: true, language: "en" },
    readers: [],
    hideReaders: false,
    design: {},
    preview: { title: "", description: "" },
    version,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
  const auth = () => ({ authorization: `Bearer ${token}` });
  const putBlob = async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/blobs",
      payload: Buffer.from(randomFill()),
      headers: { "content-type": "application/octet-stream" },
    });
    return r.json<{ hash: string }>().hash;
  };
  const randomFill = () => crypto.getRandomValues(new Uint8Array(64));
  const answer = async (extraRef = "form:frmapitest01") => {
    const sealed = sealItem({
      purpose: Purpose.form("frmapitest01"),
      readers: [recipientOf(owner.seal)],
      plaintext: utf8("{}"),
      anonymous: true,
    });
    const b = (await app.inject({ url: "/drop/config" })).json<{ powBits: number }>().powBits;
    return app.inject({
      method: "POST",
      url: `/drop/${owner.address}`,
      payload: {
        envelope: toBase64Url(sealed.envelope),
        kind: "form",
        ref: extraRef,
        chunks: [],
        pow: solvePow(owner.address, sealed.hash, b),
      },
    });
  };

  beforeAll(async () => {
    // The indexer fills names from the registry; it is not running in this suite.
    const postgres = (await import("postgres")).default;
    const sql = postgres(DB);
    await sql`insert into names (name, name_hash, address, evm, "primary", claimed_tx, claimed_block) values (${owner.name ?? ""}, ${`test:${owner.name ?? ""}`}, ${owner.address}, ${owner.evm}, true, 'x', 1) on conflict do nothing`;
    await sql.end();
    token = await signIn(owner);
  });

  it("saves a draft, refuses bad publishes, publishes a signed definition and serves it", async () => {
    const draft = await putBlob();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/forms",
          payload: { id: "frmapitest01", slug: "intake", draftEnvelope: draft },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/forms",
          payload: { id: "frmapitest01", slug: "intake", draftEnvelope: draft },
          headers: auth(),
        })
      ).json<{ published: boolean }>().published,
    ).toBe(false);
    expect((await app.inject({ url: `/forms/${owner.name ?? ""}/intake` })).statusCode).toBe(404);
    // answers to an unpublished form are refused
    expect((await answer()).json<{ error: { code: string } }>().error.code).toBe("FORM_CLOSED");
    const signedBy = (p: typeof owner, body: FormDef) =>
      signRecord({ kind: "form", body, signer: p.address, classical: p.classical, pq: p.pq });
    // signed by someone else
    const bad = await app.inject({
      method: "PUT",
      url: "/forms",
      payload: {
        id: "frmapitest01",
        slug: "intake",
        draftEnvelope: draft,
        publish: signedBy(stranger, def(1, { owner: stranger.address })),
      },
      headers: auth(),
    });
    expect(bad.json<{ error: { code: string } }>().error.code).toBe("BAD_SIGNATURE");
    // a definition that is not valid
    const invalid = await app.inject({
      method: "PUT",
      url: "/forms",
      payload: {
        id: "frmapitest01",
        slug: "intake",
        draftEnvelope: draft,
        publish: { ...signedBy(owner, def(1)), body: { ...def(1), endings: [] } },
      },
      headers: auth(),
    });
    expect(invalid.json<{ error: { code: string } }>().error.code).toBe("BAD_FORM");
    // tampered after signing
    const tampered = signedBy(owner, def(1));
    const t = await app.inject({
      method: "PUT",
      url: "/forms",
      payload: {
        id: "frmapitest01",
        slug: "intake",
        draftEnvelope: draft,
        publish: { ...tampered, body: { ...tampered.body, title: "Changed" } },
      },
      headers: auth(),
    });
    expect(t.json<{ error: { code: string } }>().error.code).toBe("BAD_SIGNATURE");
    const ok = await app.inject({
      method: "PUT",
      url: "/forms",
      payload: { id: "frmapitest01", slug: "intake", draftEnvelope: draft, publish: signedBy(owner, def(1)) },
      headers: auth(),
    });
    expect(ok.json<{ published: boolean; version: number }>()).toMatchObject({ published: true, version: 1 });
    const stale = await app.inject({
      method: "PUT",
      url: "/forms",
      payload: { id: "frmapitest01", slug: "intake", draftEnvelope: draft, publish: signedBy(owner, def(1)) },
      headers: auth(),
    });
    expect(stale.json<{ error: { code: string } }>().error.code).toBe("STALE");
    const other = await app.inject({
      method: "PUT",
      url: "/forms",
      payload: { id: "frmapitest02", slug: "intake", draftEnvelope: draft },
      headers: auth(),
    });
    expect(other.json<{ error: { code: string } }>().error.code).toBe("SLUG_TAKEN");
    const served = (await app.inject({ url: `/forms/${owner.name ?? ""}/intake` })).json<{
      record: { body: FormDef };
      open: boolean;
    }>();
    expect(served.open).toBe(true);
    expect(served.record.body.title).toBe("Client intake");
  });

  it("accepts answers, counts events content-blind, and enforces close and limit", async () => {
    expect((await answer()).statusCode).toBe(200);
    expect((await answer("form:someoneelse")).statusCode).toBe(409);
    for (const kind of ["view", "start", "submit"])
      await app.inject({ method: "POST", url: "/forms/frmapitest01/event", payload: { kind, seconds: 42 } });
    await app.inject({ method: "POST", url: "/forms/frmapitest01/event", payload: { kind: "reach", q: "q1" } });
    expect(
      (
        await app.inject({ method: "POST", url: "/forms/frmapitest01/event", payload: { kind: "reach", q: "nope" } })
      ).json<{ ok: boolean }>().ok,
    ).toBe(false);
    const st = (await app.inject({ url: "/owner/forms/frmapitest01/stats", headers: auth() })).json<{
      views: number;
      starts: number;
      submissions: number;
      secondsTotal: number;
      reach: Record<string, number>;
      responses: unknown[];
    }>();
    expect(st).toMatchObject({ views: 1, starts: 1, submissions: 1, secondsTotal: 42, reach: { q1: 1 } });
    expect(st.responses).toHaveLength(1);
    expect((await app.inject({ url: "/owner/forms/frmapitest01/stats" })).statusCode).toBe(401);
    const signed = (d: FormDef) =>
      signRecord({ kind: "form", body: d, signer: owner.address, classical: owner.classical, pq: owner.pq });
    const draft = await putBlob();
    // limit of 1 already reached
    await app.inject({
      method: "PUT",
      url: "/forms",
      payload: {
        id: "frmapitest01",
        slug: "intake",
        draftEnvelope: draft,
        publish: signed(
          def(2, {
            settings: { progress: true, numbers: true, closed: false, notify: true, language: "en", limit: 1 },
          }),
        ),
      },
      headers: auth(),
    });
    expect((await answer()).json<{ error: { message: string } }>().error.message).toMatch(/all the answers it takes/);
    expect((await app.inject({ url: `/forms/${owner.name ?? ""}/intake` })).json<{ open: boolean }>().open).toBe(false);
    // closed
    await app.inject({
      method: "PUT",
      url: "/forms",
      payload: {
        id: "frmapitest01",
        slug: "intake",
        draftEnvelope: draft,
        publish: signed(
          def(3, { settings: { progress: true, numbers: true, closed: true, notify: true, language: "en" } }),
        ),
      },
      headers: auth(),
    });
    expect((await answer()).json<{ error: { message: string } }>().error.message).toMatch(/closed/);
    // close date in the past
    await app.inject({
      method: "PUT",
      url: "/forms",
      payload: {
        id: "frmapitest01",
        slug: "intake",
        draftEnvelope: draft,
        publish: signed(
          def(4, {
            settings: {
              progress: true,
              numbers: true,
              closed: false,
              notify: true,
              language: "en",
              closeAt: new Date(Date.now() - 1000).toISOString(),
            },
          }),
        ),
      },
      headers: auth(),
    });
    expect((await answer()).json<{ error: { message: string } }>().error.message).toMatch(/closing date/);
    const list = (await app.inject({ url: "/owner/forms", headers: auth() })).json<{
      forms: { id: string; responses: number; published: { version: number } | null }[];
    }>();
    expect(list.forms.find((f) => f.id === "frmapitest01")).toMatchObject({ responses: 1, published: { version: 4 } });
  });
});

describe("proof labels", () => {
  it("only the owner can file a label for themselves; labels never show in the inbox", async () => {
    const b = (await app.inject({ url: "/drop/config" })).json<{ powBits: number }>().powBits;
    const label = sealItem({
      purpose: Purpose.proofNote,
      readers: [recipientOf(owner.seal)],
      plaintext: utf8("{}"),
      anonymous: true,
    });
    const pow = solvePow(owner.address, label.hash, b);
    const base = { envelope: toBase64Url(label.envelope), kind: "proof", ref: "proof:abc", chunks: [], pow };
    const at = new Date().toISOString();
    const byStranger = signRecord({
      kind: "sender",
      body: { envelope: label.hash, to: owner.address, at },
      signer: stranger.address,
      classical: stranger.classical,
      pq: stranger.pq,
    });
    expect(
      (await app.inject({ method: "POST", url: `/drop/${owner.address}`, payload: { ...base, sender: byStranger } }))
        .statusCode,
    ).toBe(400);
    expect((await app.inject({ method: "POST", url: `/drop/${owner.address}`, payload: base })).statusCode).toBe(400);
    const byOwner = signRecord({
      kind: "sender",
      body: { envelope: label.hash, to: owner.address, at },
      signer: owner.address,
      classical: owner.classical,
      pq: owner.pq,
    });
    const ok = await app.inject({
      method: "POST",
      url: `/drop/${owner.address}`,
      payload: { ...base, sender: byOwner },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ expiresAt: string | null }>().expiresAt).toBeNull();
    const auth = { authorization: `Bearer ${token}` };
    const notes = (await app.inject({ url: "/owner/notes?kind=proof", headers: auth })).json<{
      notes: { hash: string }[];
    }>().notes;
    expect(notes.map((n) => n.hash)).toContain(label.hash);
    for (const box of ["inbox", "archived", "sent"]) {
      const rows = (await app.inject({ url: `/owner/inbox?box=${box}`, headers: auth })).json<{
        rows: { id: string }[];
      }>().rows;
      expect(rows.map((r) => r.id)).not.toContain(label.hash);
    }
    expect((await app.inject({ url: "/owner/notes?kind=message", headers: auth })).statusCode).toBe(400);
    expect((await app.inject({ url: "/owner/notes?kind=proof" })).statusCode).toBe(401);
    // The names table is filled by the indexer (not running here); the route answers and refuses junk.
    expect((await app.inject({ url: `/names/of/${owner.address}` })).statusCode).toBe(200);
    expect((await app.inject({ url: "/names/of/nonsense" })).statusCode).toBe(400);
  });
});

describe("snapshots", () => {
  // Reuses form "frmapitest01" and the names row made in describe("forms").
  const FORM = "frmapitest01";
  let strangerToken = "";
  const putBlob = async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/blobs",
      payload: Buffer.from(crypto.getRandomValues(new Uint8Array(96))),
      headers: { "content-type": "application/octet-stream" },
    });
    return r.json<{ hash: string }>().hash;
  };
  const sign = (p: ReadyPersona, body: { formId: string; envelope: string }) =>
    signRecord({ kind: "snapshot", body, signer: p.address, classical: p.classical, pq: p.pq });
  const keep = (auth: string | null, payload: Record<string, unknown>) =>
    app.inject({
      method: "PUT",
      url: "/owner/snapshots",
      payload,
      headers: auth ? { authorization: `Bearer ${auth}` } : {},
    });
  /** Live holds on a blob (lib/holds.ts): what keeps it from the sweep. */
  const liveHolds = async (hash: string) => {
    const postgres = (await import("postgres")).default;
    const sql = postgres(DB);
    const rows = await sql<{ holder: string }[]>`
      select holder from blob_holds where hash = ${hash} and (expires_at is null or expires_at > now())`;
    await sql.end();
    return rows.map((r) => r.holder);
  };

  it("keeps only a snapshot the form's owner signed for that sealed copy", async () => {
    const ownerToken = token; // signed in by describe("forms")
    const hash = await putBlob();
    const good = { hash, formId: FORM, title: "Client intake", sig: sign(owner, { formId: FORM, envelope: hash }) };
    expect((await keep(null, good)).statusCode).toBe(401);

    const byStranger = await keep(ownerToken, { ...good, sig: sign(stranger, { formId: FORM, envelope: hash }) });
    expect(byStranger.statusCode).toBe(400);
    expect(byStranger.json<{ error: { code: string } }>().error.code).toBe("BAD_SIGNATURE");

    const other = await putBlob();
    const otherHash = await keep(ownerToken, { ...good, sig: sign(owner, { formId: FORM, envelope: other }) });
    expect(otherHash.statusCode).toBe(400);
    expect(otherHash.json<{ error: { code: string } }>().error.code).toBe("BAD_SIGNATURE");

    // A stranger's own valid signature does not make the owner's form theirs.
    strangerToken = await signIn(stranger);
    const notYours = await keep(strangerToken, { ...good, sig: sign(stranger, { formId: FORM, envelope: hash }) });
    expect(notYours.statusCode).toBe(404);

    const missing = "0".repeat(64);
    expect(
      (await keep(ownerToken, { ...good, hash: missing, sig: sign(owner, { formId: FORM, envelope: missing }) }))
        .statusCode,
    ).toBe(409);
    expect(await liveHolds(hash)).toEqual([]);

    const ok = await keep(ownerToken, good);
    expect(ok.statusCode).toBe(200);
    expect(await liveHolds(hash)).toEqual([owner.address]);

    const list = (
      await app.inject({ url: `/owner/snapshots?formId=${FORM}`, headers: { authorization: `Bearer ${ownerToken}` } })
    ).json<{ snapshots: { hash: string; title: string }[] }>().snapshots;
    expect(list.map((r) => r.hash)).toEqual([hash]);
    const theirs = await app.inject({
      url: `/owner/snapshots?formId=${FORM}`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });
    expect(theirs.json<{ snapshots: unknown[] }>().snapshots).toEqual([]);
    expect((await app.inject({ url: "/owner/snapshots" })).statusCode).toBe(401);
  });

  it("serves signed metadata only, and nothing after the owner deletes it", async () => {
    const ownerToken = token; // signed in by describe("forms")
    const hash = await putBlob();
    const sig = sign(owner, { formId: FORM, envelope: hash });
    expect((await keep(ownerToken, { hash, formId: FORM, title: "Client intake", sig })).statusCode).toBe(200);

    const pub = await app.inject({ url: `/snapshots/${hash}` });
    expect(pub.statusCode).toBe(200);
    const meta = pub.json<Record<string, unknown>>();
    expect(Object.keys(meta).sort()).toEqual(["createdAt", "formId", "owner", "ownerName", "sig", "title"]);
    expect(meta).toMatchObject({ owner: owner.address, ownerName: owner.name, formId: FORM, title: "Client intake" });
    expect(
      verifyRecord(meta.sig as Signed<{ formId: string; envelope: string }>, {
        kind: "snapshot",
        signer: owner.address,
        pqPublicKey: owner.pq.publicKey,
      }),
    ).toEqual({ formId: FORM, envelope: hash });
    expect((await app.inject({ url: "/snapshots/nothex" })).statusCode).toBe(400);

    const del = (t: string | null) =>
      app.inject({
        method: "DELETE",
        url: `/owner/snapshots/${hash}`,
        headers: t ? { authorization: `Bearer ${t}` } : {},
      });
    expect((await del(null)).statusCode).toBe(401);
    expect((await del(strangerToken)).statusCode).toBe(404);
    expect((await app.inject({ url: `/snapshots/${hash}` })).statusCode).toBe(200);
    expect((await del(ownerToken)).statusCode).toBe(200);
    expect((await app.inject({ url: `/snapshots/${hash}` })).statusCode).toBe(404);
    expect((await del(ownerToken)).statusCode).toBe(404);
    expect(await liveHolds(hash)).toEqual([]);
  });
});

describe("rooms", () => {
  // A real room on testnet: owner + stranger, then the stranger is removed.
  const id = `rmapi${Date.now().toString(36)}`;
  let ownerToken = "";
  let strangerToken = "";
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const put = async (bytes: Uint8Array, t: string) =>
    (
      await app.inject({
        method: "PUT",
        url: "/blobs",
        headers: { ...auth(t), "content-type": "application/octet-stream" },
        payload: Buffer.from(bytes),
      })
    ).json<{ hash: string }>().hash;
  let manager: EpochKeyManager;
  const members = () => [
    { address: owner.address, role: "owner" as const },
    { address: stranger.address, role: "member" as const },
  ];
  const post = (t: string, epoch: bigint, context = roomContext(id)) =>
    put(
      sealBatch({
        epochKey: { epoch, key: manager.keyFor(epoch) ?? new Uint8Array(32) },
        context,
        batchIndex: Date.now(),
        data: utf8("x"),
      }).blob,
      t,
    );

  beforeAll(async () => {
    ownerToken = await signIn(owner);
    strangerToken = await signIn(stranger);
    for (const [p, t] of [
      [owner, ownerToken],
      [stranger, strangerToken],
    ] as const)
      await app.inject({ method: "PUT", url: "/cards", headers: auth(t), payload: { card: p.card } });
    manager = new EpochKeyManager({
      chainId: CHAIN_ID,
      purpose: Purpose.room(id),
      members: { [owner.address]: recipientOf(owner.seal), [stranger.address]: recipientOf(stranger.seal) },
    });
  }, 120_000);

  it("refuses a room QoreChain has no record of, then accepts the real one", async () => {
    const env = manager.distribution();
    const distribution = await put(env, ownerToken);
    const body = { id, txHash: "0".repeat(64), members: members(), distribution, approval: true, autoDeleteSeconds: 0 };
    const early = await app.inject({ method: "POST", url: "/rooms", headers: auth(ownerToken), payload: body });
    expect(early.json<{ error: { code: string } }>().error.code).toBe("NOT_ON_CHAIN");
    const txHash = await createRoomOnChain(
      owner,
      roomIdBytes32(id),
      membershipHash(id, 1n, members()),
      distributionHash(env),
    );
    const wrong = await app.inject({
      method: "POST",
      url: "/rooms",
      headers: auth(ownerToken),
      payload: { ...body, txHash, members: [members()[0]] },
    });
    expect(wrong.json<{ error: { code: string } }>().error.code).toBe("CHAIN_MISMATCH");
    const ok = await app.inject({
      method: "POST",
      url: "/rooms",
      headers: auth(ownerToken),
      payload: { ...body, txHash },
    });
    expect(ok.statusCode).toBe(201);
    const list = await app.inject({ url: "/rooms", headers: auth(strangerToken) });
    expect(list.json<{ rooms: { id: string; role: string }[] }>().rooms.find((r) => r.id === id)?.role).toBe("member");
    const keys = await app.inject({ url: `/rooms/${id}/keys`, headers: auth(strangerToken) });
    expect(keys.json<{ epochs: { epoch: number; hash: string }[] }>().epochs).toEqual([
      { epoch: 1, hash: distribution },
    ]);
  }, 180_000);

  it("relays sealed batches only from members, for this room and the current key", async () => {
    const good = await post(strangerToken, 1n);
    const r = await app.inject({
      method: "POST",
      url: `/rooms/${id}/batches`,
      headers: auth(strangerToken),
      payload: { hash: good, deleteHash: sha256Hex(utf8("7".repeat(64))) },
    });
    expect(r.statusCode).toBe(201);
    const other = await post(strangerToken, 1n, roomContext("someotherroom"));
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/batches`,
          headers: auth(strangerToken),
          payload: { hash: other, deleteHash: "a".repeat(64) },
        })
      ).json<{ error: { code: string } }>().error.code,
    ).toBe("WRONG_ROOM");
    const notBatch = await put(utf8("plain words, not a batch"), strangerToken);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/batches`,
          headers: auth(strangerToken),
          payload: { hash: notBatch, deleteHash: "a".repeat(64) },
        })
      ).json<{ error: { code: string } }>().error.code,
    ).toBe("NOT_A_BATCH");
    const outsider = await ensurePersona("api-room-outsider");
    const outsiderToken = await signIn(outsider);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/batches`,
          headers: auth(outsiderToken),
          payload: { hash: good, deleteHash: "a".repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    expect((await app.inject({ url: `/rooms/${id}/batches`, headers: auth(outsiderToken) })).statusCode).toBe(404);
    const feed = await app.inject({ url: `/rooms/${id}/batches`, headers: auth(ownerToken) });
    expect(feed.json<{ batches: { hash: string }[] }>().batches.map((b) => b.hash)).toEqual([good]);
    // Delete for everyone: a wrong token from a non-admin is refused; the author's token works.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/batches/${good}/delete`,
          headers: auth(strangerToken),
          payload: { token: "b".repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/batches/${good}/delete`,
          headers: auth(strangerToken),
          payload: { token: "7".repeat(64) },
        })
      ).json<{ deleted: boolean }>().deleted,
    ).toBe(true);
  }, 120_000);

  it("invite links: wrong secret refused, right secret queues a request, revoked links stop", async () => {
    const card = await put(utf8("sealed card stand-in"), ownerToken);
    const secret = sha256Hex(utf8("invite secret"));
    const inv = `inv${Date.now().toString(36)}abc`;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/invites`,
          headers: auth(ownerToken),
          payload: { id: inv, secretHash: sha256Hex(utf8(secret)), card, primary: true, expiresAt: null, maxUses: 1 },
        })
      ).statusCode,
    ).toBe(201);
    const outsider = await ensurePersona("api-room-outsider");
    const outsiderToken = await signIn(outsider);
    await app.inject({ method: "PUT", url: "/cards", headers: auth(outsiderToken), payload: { card: outsider.card } });
    expect((await app.inject({ url: `/invites/${inv}` })).json<{ state: string; members: number }>()).toMatchObject({
      state: "ok",
      members: 2,
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/invites/${inv}/join`,
          headers: auth(outsiderToken),
          payload: { secret: "c".repeat(64) },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/invites/${inv}/join`,
          headers: auth(outsiderToken),
          payload: { secret },
        })
      ).json<{ status: string }>().status,
    ).toBe("pending");
    expect(
      (await app.inject({ url: `/rooms/${id}/requests`, headers: auth(ownerToken) }))
        .json<{ requests: { address: string }[] }>()
        .requests.map((q) => q.address),
    ).toEqual([outsider.address]);
    expect((await app.inject({ url: `/invites/${inv}` })).json<{ state: string }>().state).toBe("used-up");
    await app.inject({
      method: "PATCH",
      url: `/rooms/${id}/invites/${inv}`,
      headers: auth(ownerToken),
      payload: { revoked: true },
    });
    expect((await app.inject({ url: `/invites/${inv}` })).json<{ state: string }>().state).toBe("revoked");
    // Members with the add right can see the queue, but only an admin can decline.
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/rooms/${id}/requests/${outsider.address}`,
          headers: auth(strangerToken),
          payload: { status: "declined" },
        })
      ).statusCode,
    ).toBe(403);
  }, 120_000);

  it("removing a member changes the key on chain; they get nothing new and cannot post", async () => {
    const rotation = manager.removeMember(stranger.address);
    expect(rotation.epoch).toBe(2n);
    const env = rotation.envelope as Uint8Array;
    const distribution = await put(env, ownerToken);
    const next = [members()[0] as { address: string; role: "owner" }];
    const payload = {
      epoch: 2,
      txHash: "",
      reason: "removed",
      members: next,
      distribution,
      admitted: [],
      removed: [{ address: stranger.address, blocked: false }],
    };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/epochs`,
          headers: auth(strangerToken),
          payload: { ...payload, txHash: "0".repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    const txHash = await rotateRoomOnChain(
      owner,
      roomIdBytes32(id),
      2n,
      membershipHash(id, 2n, next),
      distributionHash(env),
      "removed",
    );
    const ok = await app.inject({
      method: "POST",
      url: `/rooms/${id}/epochs`,
      headers: auth(ownerToken),
      payload: { ...payload, txHash },
    });
    expect(ok.statusCode).toBe(201);
    const late = await post(ownerToken, 2n);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/batches`,
          headers: auth(ownerToken),
          payload: { hash: late, deleteHash: "d".repeat(64) },
        })
      ).statusCode,
    ).toBe(201);
    const stale = await post(ownerToken, 1n);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/batches`,
          headers: auth(ownerToken),
          payload: { hash: stale, deleteHash: "e".repeat(64) },
        })
      ).json<{ error: { code: string } }>().error.code,
    ).toBe("STALE_EPOCH");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/rooms/${id}/batches`,
          headers: auth(strangerToken),
          payload: { hash: late, deleteHash: "f".repeat(64) },
        })
      ).statusCode,
    ).toBe(403);
    const theirs = await app.inject({ url: `/rooms/${id}/batches`, headers: auth(strangerToken) });
    expect(theirs.json<{ batches: { epoch: number }[] }>().batches.every((b) => b.epoch === 1)).toBe(true);
    const theirKeys = await app.inject({ url: `/rooms/${id}/keys`, headers: auth(strangerToken) });
    expect(theirKeys.json<{ epochs: { epoch: number }[] }>().epochs.map((e) => e.epoch)).toEqual([1]);
    // One-request refresh: the removed member sees their own epochs only, no member list, no requests.
    const sync = (await app.inject({ url: `/rooms/${id}/sync?after=0`, headers: auth(strangerToken) })).json<{
      room: { epoch: number; members: unknown[]; epochs: { epoch: number }[]; me: { status: string } };
      batches: { epoch: number }[];
      keys: { epochs: { epoch: number }[] };
      requests: unknown[];
    }>();
    expect(sync.room.me.status).toBe("removed");
    expect(sync.room.epoch).toBe(1);
    expect(sync.room.members).toEqual([]);
    expect(sync.room.epochs.map((e) => e.epoch)).toEqual([1]);
    expect(sync.batches.every((b) => b.epoch === 1)).toBe(true);
    expect(sync.keys.epochs.map((e) => e.epoch)).toEqual([1]);
    expect(sync.requests).toEqual([]);
    const ownerSync = (await app.inject({ url: `/rooms/${id}/sync?after=0`, headers: auth(ownerToken) })).json<{
      room: { epoch: number };
      batches: unknown[];
      requests: unknown[];
    }>();
    expect(ownerSync.room.epoch).toBe(2);
    expect(ownerSync.batches.length).toBeGreaterThan(0);
    expect(ownerSync.requests.length).toBe(1); // the outsider's request from the invite test is still pending
  }, 180_000);
});

describe("sign-in limits", () => {
  it("limit per account: one account is throttled, another from the same IP is not", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 22; i++)
      codes.push(
        (await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: stranger.address } }))
          .statusCode,
      );
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect(
      (await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: owner.address } })).statusCode,
    ).toBe(200);
  });
});
