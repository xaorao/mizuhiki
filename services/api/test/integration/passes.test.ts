/**
 * Passes on the real QoreChain testnet keys and a real Postgres (spec 5.12,
 * ARCHITECTURE 8c): the invite and acceptance are checked against each
 * person's key on chain, only the named holder can accept, keys and copies are
 * sealed envelopes, a revoked pass stops covering new items, and a sender who
 * seals to the period key gives the holder that item without any copy.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signSiwq } from "@qorechain/qoresign";
import { deriveSealKeys, recipientOf, sealKeysFromSeed } from "@qorechain/qoreseal";
import {
  PassInviteSchema,
  Purpose,
  boundaryText,
  fromBase64Url,
  fromUtf8,
  openItem,
  passKeyIndex,
  quarterPeriod,
  sealItem,
  signRecord,
  solvePow,
  toBase64Url,
  utf8,
  type PassScope,
} from "@mizuhiki/core";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "@mizuhiki/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
let app: FastifyInstance;
let close: () => Promise<void>;
let owner: ReadyPersona;
let holder: ReadyPersona;
let stranger: ReadyPersona;
const tokens = new Map<string, string>();

async function signIn(p: ReadyPersona): Promise<string> {
  const have = tokens.get(p.address);
  if (have) return have;
  const c = await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: p.address } });
  const { message, nonce } = c.json<{ message: string; nonce: string }>();
  const signature = signSiwq({ message, classicalKey: p.classical, pqKey: p.pq });
  const t = (await app.inject({ method: "POST", url: "/auth/verify", payload: { nonce, signature } })).json<{ token: string }>().token;
  tokens.set(p.address, t);
  return t;
}
const auth = async (p: ReadyPersona) => ({ authorization: `Bearer ${await signIn(p)}` });
const put = async (bytes: Uint8Array) =>
  (await app.inject({ method: "PUT", url: "/blobs", headers: { "content-type": "application/octet-stream" }, payload: Buffer.from(bytes) })).json<{ hash: string }>().hash;
const phraseOf = (p: ReadyPersona) => (p as unknown as { phrase: string }).phrase;
const sealOf = (p: ReadyPersona) => (p as unknown as { seal: ReturnType<typeof deriveSealKeys> }).seal;

let n = 0;
function invite(by: ReadyPersona, to: string, scope: PassScope, expiresAt: string | null = null) {
  const body = PassInviteSchema.parse({
    v: 1,
    type: "invite",
    id: `pass_test${String(++n).padStart(4, "0")}${Date.now().toString(36)}`,
    owner: by.address,
    holder: to,
    scope,
    expiresAt,
    boundary: boundaryText(scope, expiresAt),
    note: "",
    createdAt: new Date().toISOString(),
  });
  return { body, record: signRecord({ kind: "pass", body, signer: by.address, classical: by.classical, pq: by.pq }) };
}
const accept = (p: ReadyPersona, id: string) =>
  signRecord({ kind: "pass", body: { v: 1 as const, type: "accept" as const, id, holder: p.address, at: new Date().toISOString() }, signer: p.address, classical: p.classical, pq: p.pq });

beforeAll(async () => {
  await runMigrations(DB);
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`truncate passes, pass_items, envelopes, sessions, auth_nonces, cards, blobs`;
  await sql.end();
  const cfg = loadConfig({ ...process.env, NODE_ENV: "test", DATABASE_URL: DB, BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-pass-")) });
  ({ app, close } = await buildServer(cfg));
  owner = await ensurePersona("pass-api-owner");
  holder = await ensurePersona("pass-api-holder");
  stranger = await ensurePersona("pass-api-stranger");
  for (const p of [owner, holder, stranger]) await app.inject({ method: "PUT", url: "/cards", headers: await auth(p), payload: { card: p.card } });
}, 600_000);

afterAll(async () => close());

describe("passes", () => {
  const q = quarterPeriod(new Date().getUTCFullYear(), (Math.floor(new Date().getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4);
  const period = (i: number): PassScope => ({ kind: "period", ...q, kinds: ["messages", "invoices"], keyIndex: passKeyIndex(i) });

  it("refuses an invite that is not signed by the caller, or names nobody with a key", async () => {
    const forged = invite(stranger, holder.address, period(0));
    const r1 = await app.inject({ method: "POST", url: "/passes", headers: await auth(owner), payload: { invite: { ...forged.record, signer: owner.address } } });
    expect(r1.statusCode).toBe(400);
    const relabelled = { ...forged.record, signer: owner.address, body: { ...forged.body, owner: owner.address } };
    expect((await app.inject({ method: "POST", url: "/passes", headers: await auth(owner), payload: { invite: relabelled } })).json<{ error: { code: string } }>().error.code).toBe("BAD_SIGNATURE");
    const self = invite(owner, owner.address, period(0));
    expect((await app.inject({ method: "POST", url: "/passes", headers: await auth(owner), payload: { invite: self.record } })).json<{ error: { code: string } }>().error.code).toBe("SELF");
    const nobody = invite(owner, "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq", period(0));
    expect((await app.inject({ method: "POST", url: "/passes", headers: await auth(owner), payload: { invite: nobody.record } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: "/passes", payload: { invite: self.record } })).statusCode).toBe(401);
  });

  let periodId = "";
  it("invite, accept by the named holder only, confirm with the sealed key; a sender's item opens with the pass key", async () => {
    const inv = invite(owner, holder.address, period(0));
    periodId = inv.body.id;
    expect((await app.inject({ method: "POST", url: "/passes", headers: await auth(owner), payload: { invite: inv.record } })).statusCode).toBe(201);
    // the same key index cannot be reused by the owner
    const again = invite(owner, stranger.address, period(0));
    expect((await app.inject({ method: "POST", url: "/passes", headers: await auth(owner), payload: { invite: again.record } })).json<{ error: { code: string } }>().error.code).toBe("KEY_TAKEN");

    const mine = (await app.inject({ url: "/passes/mine", headers: await auth(holder) })).json<{ passes: { id: string; status: string }[] }>().passes;
    expect(mine.find((p) => p.id === periodId)?.status).toBe("invited");
    expect((await app.inject({ url: `/passes/${periodId}`, headers: await auth(stranger) })).statusCode).toBe(404);
    // confirm before acceptance is refused
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/confirm`, headers: await auth(owner), payload: { keyEnvelope: null } })).statusCode).toBe(409);
    // a stranger cannot accept, nor the holder with a stranger's signature
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/accept`, headers: await auth(stranger), payload: { accept: accept(stranger, periodId) } })).statusCode).toBe(404);
    const wrong = { ...accept(stranger, periodId), signer: holder.address, body: { ...accept(stranger, periodId).body, holder: holder.address } };
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/accept`, headers: await auth(holder), payload: { accept: wrong } })).json<{ error: { code: string } }>().error.code).toBe("BAD_SIGNATURE");
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/accept`, headers: await auth(holder), payload: { accept: accept(holder, periodId) } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/accept`, headers: await auth(holder), payload: { accept: accept(holder, periodId) } })).statusCode).toBe(409);

    // the holder sees nothing before the owner confirms
    const before = (await app.inject({ url: `/passes/${periodId}/items`, headers: await auth(holder) })).json<{ live: unknown[]; status: string }>();
    expect(before).toMatchObject({ live: [], status: "accepted" });

    const passKeys = deriveSealKeys({ mnemonic: phraseOf(owner), index: passKeyIndex(0) });
    // a period pass needs its key
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/confirm`, headers: await auth(owner), payload: { keyEnvelope: null } })).json<{ error: { code: string } }>().error.code).toBe("KEY");
    const keyEnv = sealItem({ purpose: Purpose.pass(periodId), readers: [recipientOf(sealOf(holder))], plaintext: utf8(JSON.stringify({ seed: toBase64Url(passKeys.seed) })), context: "key", anonymous: true });
    const keyHash = await put(keyEnv.envelope);
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/confirm`, headers: await auth(owner), payload: { keyEnvelope: keyHash } })).statusCode).toBe(200);

    // a visitor's message sealed to the owner and the pass key
    const msg = sealItem({ purpose: Purpose.message, readers: [recipientOf(sealOf(owner)), recipientOf(passKeys)], plaintext: utf8(JSON.stringify({ v: 1, kind: "message", text: "Q receipt" })), anonymous: true });
    const bits = (await app.inject({ url: "/drop/config" })).json<{ powBits: number }>().powBits;
    const d = await app.inject({ method: "POST", url: `/drop/${owner.address}`, payload: { envelope: toBase64Url(msg.envelope), kind: "message", chunks: [], pow: solvePow(owner.address, msg.hash, bits) } });
    expect(d.statusCode).toBe(200);

    // the holder opens the key, then the message, on their own device
    const view = (await app.inject({ url: `/passes/${periodId}`, headers: await auth(holder) })).json<{ keyEnvelope: string; status: string }>();
    expect(view.status).toBe("active");
    const keyBytes = new Uint8Array((await app.inject({ url: `/blobs/${view.keyEnvelope}` })).rawPayload);
    const seed = (JSON.parse(fromUtf8(openItem({ purpose: Purpose.pass(periodId), envelope: keyBytes, keys: sealOf(holder), context: "key" }))) as { seed: string }).seed;
    const got = sealKeysFromSeed(fromBase64Url(seed));
    const items = (await app.inject({ url: `/passes/${periodId}/items`, headers: await auth(holder) })).json<{ live: { envelope: string; kind: string }[] }>();
    expect(items.live).toHaveLength(1);
    const env = new Uint8Array((await app.inject({ url: `/blobs/${items.live[0]?.envelope ?? ""}` })).rawPayload);
    expect(JSON.parse(fromUtf8(openItem({ purpose: Purpose.message, envelope: env, keys: got }))).text).toBe("Q receipt");
    // the stranger cannot list it
    expect((await app.inject({ url: `/passes/${periodId}/items`, headers: await auth(stranger) })).statusCode).toBe(404);
  });

  it("the owner adds re-sealed copies; only the owner can, only while active, only with stored parts", async () => {
    const copy = sealItem({ purpose: Purpose.pass(periodId), readers: [recipientOf(sealOf(holder))], plaintext: utf8(JSON.stringify({ v: 1, kind: "invoice", ref: "inv:x", at: new Date().toISOString(), item: { number: "7" } })), context: "invoice:abc123", anonymous: true });
    const item = { source: "invoice:abc123", kind: "invoice", envelope: copy.hash, itemAt: new Date().toISOString() };
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/items`, headers: await auth(owner), payload: { items: [item] } })).json<{ error: { code: string } }>().error.code).toBe("MISSING_PARTS");
    await put(copy.envelope);
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/items`, headers: await auth(holder), payload: { items: [item] } })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/items`, headers: await auth(owner), payload: { items: [item] } })).json<{ added: number }>().added).toBe(1);
    const listed = (await app.inject({ url: "/owner/passes", headers: await auth(owner) })).json<{ passes: { id: string; resealed: number }[]; nextKeyIndex: number }>();
    expect(listed.passes.find((p) => p.id === periodId)?.resealed).toBe(1);
    expect(listed.nextKeyIndex).toBe(passKeyIndex(1));
  });

  it("revoking stops new items from being listed and refuses new copies", async () => {
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/revoke`, headers: await auth(holder), payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/revoke`, headers: await auth(owner), payload: {} })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const keys = deriveSealKeys({ mnemonic: phraseOf(owner), index: passKeyIndex(0) });
    const late = sealItem({ purpose: Purpose.message, readers: [recipientOf(sealOf(owner)), recipientOf(keys)], plaintext: utf8(JSON.stringify({ v: 1, kind: "message", text: "after revoke" })), anonymous: true });
    const bits = (await app.inject({ url: "/drop/config" })).json<{ powBits: number }>().powBits;
    await app.inject({ method: "POST", url: `/drop/${owner.address}`, payload: { envelope: toBase64Url(late.envelope), kind: "message", chunks: [], pow: solvePow(owner.address, late.hash, bits) } });
    const items = (await app.inject({ url: `/passes/${periodId}/items`, headers: await auth(holder) })).json<{ live: unknown[]; resealed: unknown[]; status: string }>();
    expect(items.status).toBe("revoked");
    expect(items.live).toHaveLength(1);
    expect(items.resealed).toHaveLength(1);
    const copy = sealItem({ purpose: Purpose.pass(periodId), readers: [recipientOf(sealOf(holder))], plaintext: utf8("{}"), anonymous: true });
    await put(copy.envelope);
    expect((await app.inject({ method: "POST", url: `/passes/${periodId}/items`, headers: await auth(owner), payload: { items: [{ source: "x".repeat(8), kind: "message", envelope: copy.hash, itemAt: new Date().toISOString() }] } })).json<{ error: { code: string } }>().error.code).toBe("NOT_ACTIVE");
  });

  it("a room pass shares no key, and the holder can decline an invite", async () => {
    const room = invite(owner, holder.address, { kind: "room", roomId: "roomabcdef12", label: "Payroll" });
    await app.inject({ method: "POST", url: "/passes", headers: await auth(owner), payload: { invite: room.record } });
    await app.inject({ method: "POST", url: `/passes/${room.body.id}/accept`, headers: await auth(holder), payload: { accept: accept(holder, room.body.id) } });
    const k = sealItem({ purpose: Purpose.pass(room.body.id), readers: [recipientOf(sealOf(holder))], plaintext: utf8("{}"), anonymous: true });
    expect((await app.inject({ method: "POST", url: `/passes/${room.body.id}/confirm`, headers: await auth(owner), payload: { keyEnvelope: await put(k.envelope) } })).json<{ error: { code: string } }>().error.code).toBe("KEY");
    expect((await app.inject({ method: "POST", url: `/passes/${room.body.id}/confirm`, headers: await auth(owner), payload: { keyEnvelope: null } })).statusCode).toBe(200);

    const form = invite(owner, holder.address, { kind: "form", formId: "formabcdef12", label: "Intake" });
    await app.inject({ method: "POST", url: "/passes", headers: await auth(owner), payload: { invite: form.record } });
    expect((await app.inject({ method: "POST", url: `/passes/${form.body.id}/decline`, headers: await auth(holder), payload: {} })).statusCode).toBe(200);
    const listed = (await app.inject({ url: "/owner/passes", headers: await auth(owner) })).json<{ passes: { id: string; status: string }[] }>();
    expect(listed.passes.find((p) => p.id === form.body.id)?.status).toBe("declined");
    expect(listed.passes.find((p) => p.id === room.body.id)?.status).toBe("active");
  });
});
