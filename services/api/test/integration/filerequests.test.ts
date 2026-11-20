/**
 * File requests (spec 5.7, ARCHITECTURE 8g) on a real Postgres with testnet
 * keys: only records signed by the owner's key on chain are kept, versions
 * only move forward, uploads are taken while open, marked late after the
 * deadline when late uploads are allowed, refused when ended or closed, the
 * owner's list counts only what the server can see, delete needs a closed
 * request, and strangers learn nothing beyond the public record.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signSiwq } from "@qorechain/qoresign";
import {
  Purpose,
  fileRequestRef,
  publicRecipient,
  sealItem,
  signRecord,
  solvePow,
  toBase64Url,
  utf8,
  type FileRequest,
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
let other: ReadyPersona;
let token = "";
let otherToken = "";

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

beforeAll(async () => {
  await runMigrations(DB);
  owner = await ensurePersona("freq-api-owner");
  other = await ensurePersona("freq-api-other");
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`delete from file_requests where owner in (${owner.address}, ${other.address})`;
  await sql`delete from envelopes where owner = ${owner.address} and kind = 'filedrop'`;
  await sql.end();
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-freq-")),
  });
  ({ app, close } = await buildServer(cfg));
  token = await signIn(owner);
  otherToken = await signIn(other);
  for (const [p, t] of [
    [owner, token],
    [other, otherToken],
  ] as const)
    await app.inject({
      method: "PUT",
      url: "/cards",
      headers: { authorization: `Bearer ${t}` },
      payload: { card: p.card },
    });
}, 600_000);

afterAll(async () => close());

const id = `freq_${Date.now().toString(36)}`;
const req = (over: Partial<FileRequest> = {}): FileRequest => ({
  v: 1,
  id,
  owner: owner.address,
  title: "Documents for the Q4 return",
  description: "Your W-2 and any 1099s.",
  deadline: null,
  allowLate: false,
  naming: "uploader",
  timeZone: "Asia/Tokyo",
  status: "open",
  version: 1,
  updatedAt: new Date().toISOString(),
  ...over,
});
const put = (body: FileRequest, by: ReadyPersona = owner, t = token) =>
  app.inject({
    method: "PUT",
    url: "/owner/file-requests",
    headers: { authorization: `Bearer ${t}` },
    payload: {
      record: signRecord({ kind: "filerequest", body, signer: by.address, classical: by.classical, pq: by.pq }),
    },
  });
const upload = async (text: string) => {
  const bits = (await app.inject({ url: "/drop/config" })).json<{ powBits: number }>().powBits;
  const sealed = sealItem({
    purpose: Purpose.message,
    readers: [publicRecipient(owner.seal)],
    plaintext: utf8(JSON.stringify({ v: 1, kind: "message", text, files: [], request: { id } })),
    anonymous: true,
  });
  return app.inject({
    method: "POST",
    url: `/drop/${owner.address}`,
    payload: {
      envelope: toBase64Url(sealed.envelope),
      kind: "filedrop",
      ref: fileRequestRef(id),
      chunks: [],
      pow: solvePow(owner.address, sealed.hash, bits),
    },
  });
};
const auth = () => ({ authorization: `Bearer ${token}` });

describe("file requests", () => {
  it("keeps only records signed by the owner's key, moving forward", async () => {
    expect((await app.inject({ method: "PUT", url: "/owner/file-requests", payload: {} })).statusCode).toBe(401);
    // Signed by someone else, for this owner.
    expect((await put(req(), other, otherToken)).statusCode).toBe(400);
    // A relabelled body under a valid signature.
    const signed = signRecord({
      kind: "filerequest",
      body: req(),
      signer: owner.address,
      classical: owner.classical,
      pq: owner.pq,
    });
    const forged = await app.inject({
      method: "PUT",
      url: "/owner/file-requests",
      headers: auth(),
      payload: { record: { ...signed, body: { ...signed.body, title: "Something else" } } },
    });
    expect(forged.json<{ error: { code: string } }>().error.code).toBe("BAD_SIGNATURE");
    expect((await put(req())).statusCode).toBe(200);
    expect((await put(req())).json<{ error: { code: string } }>().error.code).toBe("STALE");
    // Another account cannot take this id.
    expect(
      (await put(req({ owner: other.address, version: 5 }), other, otherToken)).json<{ error: { code: string } }>()
        .error.code,
    ).toBe("TAKEN");
    const pub = (await app.inject({ url: `/file-requests/${id}` })).json<{
      record: { body: FileRequest; signer: string };
    }>();
    expect(pub.record.body.title).toBe("Documents for the Q4 return");
    expect(pub.record.signer).toBe(owner.address);
    expect((await app.inject({ url: "/file-requests/freq_nothere1" })).statusCode).toBe(404);
  });

  it("takes uploads while open, marks them late after the deadline, refuses when ended or closed", async () => {
    const first = await upload("on time");
    expect(first.statusCode).toBe(200);
    expect(first.json<{ late?: boolean }>().late).toBeUndefined();
    // Deadline in the past, late uploads allowed: stored and marked late.
    expect(
      (await put(req({ deadline: new Date(Date.now() - 60_000).toISOString(), allowLate: true, version: 2 })))
        .statusCode,
    ).toBe(200);
    const late = await upload("late one");
    expect(late.json<{ late?: boolean }>().late).toBe(true);
    // Without late uploads: refused, nothing stored.
    expect(
      (await put(req({ deadline: new Date(Date.now() - 60_000).toISOString(), allowLate: false, version: 3 })))
        .statusCode,
    ).toBe(200);
    const ended = await upload("too late");
    expect(ended.statusCode).toBe(409);
    expect(ended.json<{ error: { message: string; dataState: string } }>().error).toMatchObject({
      dataState: "nothing-stored",
    });
    // Closed.
    expect((await put(req({ status: "closed", version: 4 }))).statusCode).toBe(200);
    expect((await upload("closed")).json<{ error: { message: string } }>().error.message).toMatch(/closed/);
    // An upload naming no request is refused.
    const bits = (await app.inject({ url: "/drop/config" })).json<{ powBits: number }>().powBits;
    const s = sealItem({
      purpose: Purpose.message,
      readers: [publicRecipient(owner.seal)],
      plaintext: utf8("{}"),
      anonymous: true,
    });
    const noRef = await app.inject({
      method: "POST",
      url: `/drop/${owner.address}`,
      payload: {
        envelope: toBase64Url(s.envelope),
        kind: "filedrop",
        chunks: [],
        pow: solvePow(owner.address, s.hash, bits),
      },
    });
    expect(noRef.statusCode).toBe(409);
  });

  it("the owner's list counts what the server can see; the inbox carries the late mark", async () => {
    const list = (await app.inject({ url: "/owner/file-requests", headers: auth() })).json<{
      requests: { record: { body: FileRequest }; uploads: number; late: number; bytes: number; unread: number }[];
    }>().requests;
    const mine = list.find((r) => r.record.body.id === id);
    expect(mine).toMatchObject({ uploads: 2, late: 1, unread: 2 });
    expect(mine?.bytes).toBeGreaterThan(0);
    const one = (await app.inject({ url: `/owner/file-requests/${id}`, headers: auth() })).json<{
      uploads: { late: boolean }[];
    }>();
    expect(one.uploads.map((u) => u.late).sort()).toEqual([false, true]);
    const inbox = (await app.inject({ url: "/owner/inbox?box=inbox", headers: auth() })).json<{
      rows: { kind: string; ref: string | null; late?: boolean }[];
    }>().rows;
    const drops = inbox.filter((r) => r.kind === "filedrop" && r.ref === fileRequestRef(id));
    expect(drops).toHaveLength(2);
    expect(drops.filter((r) => r.late)).toHaveLength(1);
    // Strangers see no list or uploads.
    expect(
      (await app.inject({ url: `/owner/file-requests/${id}`, headers: { authorization: `Bearer ${otherToken}` } }))
        .statusCode,
    ).toBe(404);
    expect((await app.inject({ url: "/owner/file-requests" })).statusCode).toBe(401);
  });

  it("deletes only a closed request, and the uploads stay with the owner", async () => {
    expect((await put(req({ status: "open", version: 5 }))).statusCode).toBe(200);
    const open = await app.inject({ method: "DELETE", url: `/owner/file-requests/${id}`, headers: auth() });
    expect(open.json<{ error: { code: string } }>().error.code).toBe("OPEN");
    expect((await put(req({ status: "closed", version: 6 }))).statusCode).toBe(200);
    expect(
      (await app.inject({ method: "DELETE", url: `/owner/file-requests/${id}`, headers: auth() })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: `/file-requests/${id}` })).statusCode).toBe(404);
    const inbox = (await app.inject({ url: "/owner/inbox?box=inbox", headers: auth() })).json<{
      rows: { ref: string | null }[];
    }>().rows;
    expect(inbox.filter((r) => r.ref === fileRequestRef(id))).toHaveLength(2);
  });
});
