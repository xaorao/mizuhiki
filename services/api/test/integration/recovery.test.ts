/**
 * Spare key and recovery on real testnet keys and a real Postgres (spec 5.13,
 * ARCHITECTURE 8d): signed invites and acceptances checked against the chain,
 * pieces sealed per contact, a new device's request answered by contacts,
 * held for the wait, cancellable by the owner, released only with the
 * request's secret; the phrase rebuilt from the released pieces; a test run;
 * the offline reader's challenge.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signSiwq } from "@qorechain/qoresign";
import { generateSealKeys, recipientOf, sealKeysFromSeed } from "@qorechain/qoreseal";
import {
  Purpose,
  combinePhrase,
  fromBase64Url,
  fromUtf8,
  openItem,
  randomBytes,
  sealItem,
  sha256Hex,
  signRecord,
  splitPhrase,
  toBase64Url,
  toHex,
  utf8,
  solvePow,
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
let contacts: ReadyPersona[];
let stranger: ReadyPersona;
const tokens = new Map<string, string>();
type P = ReadyPersona & { phrase: string; seal: ReturnType<typeof generateSealKeys> };
const p = (x: ReadyPersona) => x as unknown as P;

async function auth(x: ReadyPersona) {
  let t = tokens.get(x.address);
  if (!t) {
    const c = (await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: x.address } })).json<{
      message: string;
      nonce: string;
    }>();
    t = (
      await app.inject({
        method: "POST",
        url: "/auth/verify",
        payload: {
          nonce: c.nonce,
          signature: signSiwq({ message: c.message, classicalKey: x.classical, pqKey: x.pq }),
        },
      })
    ).json<{ token: string }>().token;
    tokens.set(x.address, t);
  }
  return { authorization: `Bearer ${t}` };
}
const put = async (bytes: Uint8Array) =>
  (
    await app.inject({
      method: "PUT",
      url: "/blobs",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes),
    })
  ).json<{ hash: string }>().hash;
const blob = async (h: string) => new Uint8Array((await app.inject({ url: `/blobs/${h}` })).rawPayload);
const sign = (x: ReadyPersona, body: unknown) =>
  signRecord({ kind: "recovery", body, signer: x.address, classical: x.classical, pq: x.pq });
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;

beforeAll(async () => {
  await runMigrations(DB);
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`truncate recovery_settings, recovery_contacts, recovery_requests, recovery_answers, recovery_challenges, recovery_offline_items, sessions, auth_nonces, cards, blobs`;
  await sql.end();
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-rec-")),
    RECOVERY_DELAY_SECONDS: "2",
  });
  ({ app, close } = await buildServer(cfg));
  owner = await ensurePersona("rec-api-owner");
  contacts = [await ensurePersona("rec-api-c1"), await ensurePersona("rec-api-c2"), await ensurePersona("rec-api-c3")];
  stranger = await ensurePersona("rec-api-stranger");
  for (const x of [owner, ...contacts, stranger])
    await app.inject({ method: "PUT", url: "/cards", headers: await auth(x), payload: { card: x.card } });
}, 900_000);

afterAll(async () => close());

/** One new device's view of a request: a one-time key and its secret. */
function newDevice() {
  const keys = generateSealKeys();
  const secret = toBase64Url(randomBytes(32));
  return {
    keys,
    secret,
    recipient: { mlkem: toHex(keys.mlkemPublicKey), x25519: toHex(keys.x25519PublicKey) },
    secretHash: sha256Hex(utf8(secret)),
  };
}

/** The body a new device posts: who, its one-time key, its secret's hash, and the anti-spam stamp. */
async function requestBody(who: string, d: ReturnType<typeof newDevice>) {
  const bits = (await app.inject({ url: "/drop/config" })).json<{ powBits: number }>().powBits;
  const name = who.trim().replace(/^@/, "").toLowerCase();
  return {
    who,
    recipient: d.recipient,
    secretHash: d.secretHash,
    pow: solvePow(`recovery:${name}`, d.secretHash, bits),
  };
}

/** A contact's device answering: open their piece, re-seal it to the one-time key. */
async function answer(c: ReadyPersona, requestId: string, recipient: { mlkem: string; x25519: string }) {
  const help = (await app.inject({ url: "/recovery/helping", headers: await auth(c) })).json<{
    owners: { owner: string; piece: string; pieceVersion: number }[];
  }>();
  const mine = help.owners.find((o) => o.owner === owner.address);
  if (!mine) throw new Error("no piece");
  const piece = openItem({
    purpose: Purpose.recoveryShare(String(mine.pieceVersion)),
    envelope: await blob(mine.piece),
    keys: p(c).seal,
    context: c.address,
  });
  const s = sealItem({
    purpose: Purpose.recoveryAnswer(requestId),
    readers: [
      { mlkemPublicKey: Buffer.from(recipient.mlkem, "hex"), x25519PublicKey: Buffer.from(recipient.x25519, "hex") },
    ],
    plaintext: piece,
    anonymous: true,
  });
  return app.inject({
    method: "POST",
    url: `/recovery/requests/${requestId}/answer`,
    headers: await auth(c),
    payload: { envelope: await put(s.envelope) },
  });
}

describe("recovery", () => {
  it("contacts: signed invite, acceptance only by the contact, confirm after acceptance", async () => {
    const at = new Date().toISOString();
    const self = sign(owner, {
      v: 1,
      type: "contact-invite",
      owner: owner.address,
      contact: owner.address,
      note: "",
      at,
    });
    expect(
      code(
        await app.inject({
          method: "POST",
          url: "/owner/recovery/contacts",
          headers: await auth(owner),
          payload: { invite: self },
        }),
      ),
    ).toBe("SELF");
    const forged = {
      ...sign(stranger, {
        v: 1,
        type: "contact-invite",
        owner: owner.address,
        contact: contacts[0]?.address,
        note: "",
        at,
      }),
      signer: owner.address,
    };
    expect(
      code(
        await app.inject({
          method: "POST",
          url: "/owner/recovery/contacts",
          headers: await auth(owner),
          payload: { invite: forged },
        }),
      ),
    ).toBe("BAD_SIGNATURE");
    for (const c of contacts) {
      const inv = sign(owner, {
        v: 1,
        type: "contact-invite",
        owner: owner.address,
        contact: c.address,
        note: "You know me best.",
        at,
      });
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/owner/recovery/contacts",
            headers: await auth(owner),
            payload: { invite: inv },
          })
        ).statusCode,
      ).toBe(201);
    }
    const c0 = contacts[0] as ReadyPersona;
    expect(
      code(
        await app.inject({
          method: "POST",
          url: `/owner/recovery/contacts/${c0.address}/confirm`,
          headers: await auth(owner),
        }),
      ),
    ).toBe("NOT_ACCEPTED");
    const wrong = {
      ...sign(stranger, { v: 1, type: "contact-accept", owner: owner.address, contact: c0.address, at }),
      signer: c0.address,
    };
    expect(
      code(
        await app.inject({
          method: "POST",
          url: `/recovery/helping/${owner.address}/accept`,
          headers: await auth(c0),
          payload: { accept: wrong },
        }),
      ),
    ).toBe("BAD_SIGNATURE");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/recovery/helping/${owner.address}/accept`,
          headers: await auth(stranger),
          payload: { accept: wrong },
        })
      ).statusCode,
    ).toBe(404);
    for (const c of contacts) {
      const acc = sign(c, { v: 1, type: "contact-accept", owner: owner.address, contact: c.address, at });
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/recovery/helping/${owner.address}/accept`,
            headers: await auth(c),
            payload: { accept: acc },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "POST",
            url: `/owner/recovery/contacts/${c.address}/confirm`,
            headers: await auth(owner),
          })
        ).statusCode,
      ).toBe(200);
    }
  });

  it("pieces: one per confirmed contact, sealed to each; refused if stale or incomplete", async () => {
    const set = await splitPhrase(p(owner).phrase, 3, 2);
    const pieces = [];
    for (const [i, c] of contacts.entries()) {
      const s = sealItem({
        purpose: Purpose.recoveryShare("1"),
        readers: [recipientOf(p(c).seal)],
        plaintext: set.shares[i] as Uint8Array,
        context: c.address,
        anonymous: true,
      });
      pieces.push({ contact: c.address, envelope: await put(s.envelope) });
    }
    expect(
      code(
        await app.inject({
          method: "PUT",
          url: "/owner/recovery/pieces",
          headers: await auth(owner),
          payload: { version: 2, threshold: 2, pieces },
        }),
      ),
    ).toBe("STALE");
    expect(
      code(
        await app.inject({
          method: "PUT",
          url: "/owner/recovery/pieces",
          headers: await auth(owner),
          payload: { version: 1, threshold: 2, pieces: pieces.slice(0, 2) },
        }),
      ),
    ).toBe("CONTACTS_CHANGED");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/owner/recovery/pieces",
          headers: await auth(owner),
          payload: { version: 1, threshold: 2, pieces },
        })
      ).statusCode,
    ).toBe(200);
    const mine = (await app.inject({ url: "/owner/recovery", headers: await auth(owner) })).json<{
      settings: { version: number; threshold: number };
    }>();
    expect(mine.settings).toMatchObject({ version: 1, threshold: 2 });
    // A contact's piece opens only with that contact's key, and alone it is not the phrase.
    const c0 = contacts[0] as ReadyPersona;
    const env = await blob(pieces[0]?.envelope ?? "");
    expect(() =>
      openItem({
        purpose: Purpose.recoveryShare("1"),
        envelope: env,
        keys: p(contacts[1] as ReadyPersona).seal,
        context: c0.address,
      }),
    ).toThrow();
    await expect(
      combinePhrase(
        [openItem({ purpose: Purpose.recoveryShare("1"), envelope: env, keys: p(c0).seal, context: c0.address })],
        2,
      ),
    ).rejects.toThrow();
  });

  let cancelled = "";
  it("a stranger's recovery request can be cancelled by the owner; cancelled requests take no answers", async () => {
    const d = newDevice();
    expect(
      code(
        await app.inject({
          method: "POST",
          url: "/recovery/requests",
          payload: await requestBody(stranger.address, d),
        }),
      ),
    ).toBe("NO_RECOVERY");
    const r = (
      await app.inject({
        method: "POST",
        url: "/recovery/requests",
        payload: await requestBody(owner.address, d),
      })
    ).json<{ id: string }>();
    cancelled = r.id;
    const seen = (await app.inject({ url: "/owner/recovery", headers: await auth(owner) })).json<{
      requests: { id: string; status: string }[];
    }>();
    expect(seen.requests.find((x) => x.id === r.id)?.status).toBe("open");
    expect((await answer(contacts[0] as ReadyPersona, r.id, d.recipient)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/owner/recovery/requests/${r.id}/cancel`,
          headers: await auth(stranger),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ method: "POST", url: `/owner/recovery/requests/${r.id}/cancel`, headers: await auth(owner) }))
        .statusCode,
    ).toBe(200);
    expect(code(await answer(contacts[1] as ReadyPersona, r.id, d.recipient))).toBe("CLOSED");
    const view = (
      await app.inject({ url: `/recovery/requests/${r.id}`, headers: { "x-recovery-secret": d.secret } })
    ).json<{ status: string; pieces: string[] }>();
    expect(view).toMatchObject({ status: "cancelled", pieces: [] });
  });

  it("strangers' requests never block the owner's, need a stamp, and contacts can turn them down (review H2)", async () => {
    // No stamp: refused.
    const d0 = newDevice();
    const bare = await app.inject({
      method: "POST",
      url: "/recovery/requests",
      payload: { who: owner.address, recipient: d0.recipient, secretHash: d0.secretHash },
    });
    expect(bare.statusCode).toBe(400);
    // A stranger fills every open slot for the owner…
    const theirs: string[] = [];
    for (let i = 0; i < 3; i++) {
      const d = newDevice();
      const r = await app.inject({
        method: "POST",
        url: "/recovery/requests",
        payload: await requestBody(owner.address, d),
      });
      expect(r.statusCode).toBe(201);
      theirs.push(r.json<{ id: string }>().id);
    }
    // …and the owner's own request still gets in: the oldest unanswered one makes room.
    const mine = newDevice();
    const real = await app.inject({
      method: "POST",
      url: "/recovery/requests",
      payload: await requestBody(owner.address, mine),
    });
    expect(real.statusCode).toBe(201);
    const state = async (id: string, d?: ReturnType<typeof newDevice>) =>
      d
        ? (await app.inject({ url: `/recovery/requests/${id}`, headers: { "x-recovery-secret": d.secret } })).json<{
            status: string;
          }>().status
        : (await app.inject({ url: "/owner/recovery", headers: await auth(owner) }))
            .json<{ requests: { id: string; status: string }[] }>()
            .requests.find((x) => x.id === id)?.status;
    expect(await state(theirs[0] ?? "")).toBe("cancelled");
    expect(await state(real.json<{ id: string }>().id, mine)).toBe("open");
    // Contacts turn a stranger's request down; once too few are left for the threshold it is cancelled.
    const target = theirs[1] ?? "";
    const dismiss = async (c: ReadyPersona) =>
      app.inject({ method: "POST", url: `/recovery/requests/${target}/dismiss`, headers: await auth(c) });
    expect(
      (await app.inject({ method: "POST", url: `/recovery/requests/${target}/dismiss`, headers: await auth(stranger) }))
        .statusCode,
    ).toBe(403);
    const first = (await dismiss(contacts[0] as ReadyPersona)).json<{ status: string }>();
    expect(first.status).not.toBe("cancelled");
    // The contact who turned it down cannot then answer it.
    expect(code(await answer(contacts[0] as ReadyPersona, target, newDevice().recipient))).toBe("DISMISSED");
    const second = (await dismiss(contacts[1] as ReadyPersona)).json<{ status: string }>();
    expect(second.status).toBe("cancelled");
    // Clean up: the owner cancels what is left, so later tests start clear.
    for (const id of [theirs[2] ?? "", real.json<{ id: string }>().id])
      await app.inject({ method: "POST", url: `/owner/recovery/requests/${id}/cancel`, headers: await auth(owner) });
  });

  it("a real recovery: two contacts answer, pieces held for the wait, then released only with the secret; the phrase is rebuilt", async () => {
    const d = newDevice();
    const r = (
      await app.inject({
        method: "POST",
        url: "/recovery/requests",
        payload: await requestBody(owner.address, d),
      })
    ).json<{ id: string; threshold: number }>();
    expect(r.threshold).toBe(2);
    const junk = sealItem({
      purpose: Purpose.recoveryAnswer(r.id),
      readers: [recipientOf(d.keys)],
      plaintext: randomBytes(33),
      anonymous: true,
    });
    expect(
      code(
        await app.inject({
          method: "POST",
          url: `/recovery/requests/${r.id}/answer`,
          headers: await auth(stranger),
          payload: { envelope: await put(junk.envelope) },
        }),
      ),
    ).toBe("NOT_A_CONTACT");
    expect((await answer(contacts[1] as ReadyPersona, r.id, d.recipient)).statusCode).toBe(200);
    expect((await answer(contacts[2] as ReadyPersona, r.id, d.recipient)).json<{ answered: number }>().answered).toBe(
      2,
    );
    const waiting = (
      await app.inject({ url: `/recovery/requests/${r.id}`, headers: { "x-recovery-secret": d.secret } })
    ).json<{ status: string; pieces: string[]; releaseAt: string }>();
    expect(waiting.status).toBe("waiting");
    expect(waiting.pieces).toHaveLength(0);
    expect(
      (await app.inject({ url: `/recovery/requests/${r.id}`, headers: { "x-recovery-secret": "wrong" } })).statusCode,
    ).toBe(404);
    await new Promise((res) => setTimeout(res, 2500));
    const ready = (
      await app.inject({ url: `/recovery/requests/${r.id}`, headers: { "x-recovery-secret": d.secret } })
    ).json<{ status: string; pieces: string[] }>();
    expect(ready.status).toBe("ready");
    const parts = await Promise.all(
      ready.pieces.map(async (h) =>
        openItem({ purpose: Purpose.recoveryAnswer(r.id), envelope: await blob(h), keys: d.keys }),
      ),
    );
    expect(await combinePhrase(parts, 2)).toBe(p(owner).phrase);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/recovery/requests/${r.id}/done`,
          headers: { "x-recovery-secret": d.secret },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      code(
        await app.inject({
          method: "POST",
          url: `/owner/recovery/requests/${r.id}/cancel`,
          headers: await auth(owner),
        }),
      ),
    ).toBe("DONE");
    cancelled;
  });

  it("a test run has no wait and records 'tested' only with enough answers", async () => {
    const d = newDevice();
    const t = (
      await app.inject({
        method: "POST",
        url: "/owner/recovery/test",
        headers: await auth(owner),
        payload: { recipient: d.recipient, secretHash: d.secretHash },
      })
    ).json<{ id: string }>();
    expect(
      code(
        await app.inject({
          method: "POST",
          url: "/owner/recovery/marks",
          headers: await auth(owner),
          payload: { tested: t.id },
        }),
      ),
    ).toBe("NOT_ENOUGH");
    await answer(contacts[0] as ReadyPersona, t.id, d.recipient);
    await answer(contacts[2] as ReadyPersona, t.id, d.recipient);
    const ready = (
      await app.inject({ url: `/recovery/requests/${t.id}`, headers: { "x-recovery-secret": d.secret } })
    ).json<{ status: string; pieces: string[] }>();
    expect(ready.status).toBe("ready");
    const parts = await Promise.all(
      ready.pieces.map(async (h) =>
        openItem({ purpose: Purpose.recoveryAnswer(t.id), envelope: await blob(h), keys: d.keys }),
      ),
    );
    expect(await combinePhrase(parts, 2)).toBe(p(owner).phrase);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/owner/recovery/marks",
          headers: await auth(owner),
          payload: { tested: t.id },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/owner/recovery", headers: await auth(owner) })).json<{
        settings: { testedAt: string | null };
      }>().settings.testedAt,
    ).not.toBeNull();
  });

  it("removing a contact clears their piece; re-splitting cancels open requests", async () => {
    const c2 = contacts[2] as ReadyPersona;
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/owner/recovery/contacts/${c2.address}`,
          headers: await auth(owner),
        })
      ).statusCode,
    ).toBe(200);
    const help = (await app.inject({ url: "/recovery/helping", headers: await auth(c2) })).json<{
      owners: unknown[];
    }>();
    expect(help.owners).toHaveLength(0);
    const d = newDevice();
    const r = (
      await app.inject({
        method: "POST",
        url: "/recovery/requests",
        payload: await requestBody(owner.address, d),
      })
    ).json<{ id: string }>();
    const set = await splitPhrase(p(owner).phrase, 2, 2);
    const pieces = [];
    for (const [i, c] of contacts.slice(0, 2).entries()) {
      const s = sealItem({
        purpose: Purpose.recoveryShare("2"),
        readers: [recipientOf(p(c).seal)],
        plaintext: set.shares[i] as Uint8Array,
        context: c.address,
        anonymous: true,
      });
      pieces.push({ contact: c.address, envelope: await put(s.envelope) });
    }
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/owner/recovery/pieces",
          headers: await auth(owner),
          payload: { version: 2, threshold: 2, pieces },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: `/recovery/requests/${r.id}`, headers: { "x-recovery-secret": d.secret } })).json<{
        status: string;
      }>().status,
    ).toBe("cancelled");
  });

  it("offline reader: only the holder of the offline key gets the item list", async () => {
    const seed = randomBytes(32);
    const k = sealKeysFromSeed(seed);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/owner/recovery/offline",
          headers: await auth(owner),
          payload: {
            key: { mlkem: toHex(k.mlkemPublicKey), x25519: toHex(k.x25519PublicKey), since: new Date().toISOString() },
          },
        })
      ).statusCode,
    ).toBe(200);
    const ch = (
      await app.inject({ method: "POST", url: "/recovery/offline/challenge", payload: { who: owner.address } })
    ).json<{ id: string; challenge: string }>();
    expect(
      code(
        await app.inject({
          method: "POST",
          url: "/recovery/offline/items",
          payload: { id: ch.id, nonce: "x".repeat(43) },
        }),
      ),
    ).toBe("WRONG_KEY");
    // a wrong key cannot open the challenge
    expect(() =>
      openItem({
        purpose: Purpose.offlineChallenge,
        envelope: fromBase64Url(ch.challenge),
        keys: generateSealKeys(),
        context: ch.id,
      }),
    ).toThrow();
    const ch2 = (
      await app.inject({ method: "POST", url: "/recovery/offline/challenge", payload: { who: owner.address } })
    ).json<{ id: string; challenge: string }>();
    const nonce = fromUtf8(
      openItem({ purpose: Purpose.offlineChallenge, envelope: fromBase64Url(ch2.challenge), keys: k, context: ch2.id }),
    );
    const items = await app.inject({ method: "POST", url: "/recovery/offline/items", payload: { id: ch2.id, nonce } });
    expect(items.statusCode).toBe(200);
    expect(items.json<{ owner: string }>().owner).toBe(owner.address);
    // a challenge works once
    expect(
      (await app.inject({ method: "POST", url: "/recovery/offline/items", payload: { id: ch2.id, nonce } })).statusCode,
    ).toBe(403);
  });
});
