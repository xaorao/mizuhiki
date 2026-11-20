/**
 * Capsules on QoreChain testnet and a real Postgres (spec 5.14, ARCHITECTURE
 * 8e). Capsule A: armed after a wait, a guardian requests on chain, the owner
 * rejects, the guardian requests again, the owner cancels. Capsule B: opens at
 * a set time; nothing is accepted before the chain says Released; after
 * `finalize` the guardian re-seals pieces and the recipient opens only their
 * own content. The API refuses plans that do not match the chain.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signSiwq } from "@qorechain/qoresign";
import { recipientOf, sealKeysFromSeed } from "@qorechain/qoreseal";
import {
  MODE_INDEX,
  Purpose,
  combineShares,
  fromUtf8,
  openItem,
  planHash,
  randomBytes,
  sealItem,
  signRecord,
  splitSecret,
  toHex,
  utf8,
  type CapsulePlan,
} from "@mizuhiki/core";
import {
  cancelCapsuleOnChain,
  chainNow,
  createCapsuleOnChain,
  finalizeCapsule,
  readCapsule,
  rejectCapsuleRequest,
  requestCapsuleRelease,
} from "@mizuhiki/chain";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import type { FastifyInstance } from "fastify";
import type { Address } from "viem";
import { runMigrations } from "@mizuhiki/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
let app: FastifyInstance;
let close: () => Promise<void>;
let owner: P;
let guardian: P;
let recipient: P;
let other: P;
type P = ReadyPersona & { seal: ReturnType<typeof sealKeysFromSeed>; evm: Address };
const tokens = new Map<string, string>();

async function auth(x: P) {
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
const put = async (b: Uint8Array) =>
  (
    await app.inject({
      method: "PUT",
      url: "/blobs",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(b),
    })
  ).json<{ hash: string }>().hash;
const blob = async (h: string) => new Uint8Array((await app.inject({ url: `/blobs/${h}` })).rawPayload);
const sign = (x: P, body: unknown) =>
  signRecord({ kind: "capsule", body, signer: x.address, classical: x.classical, pq: x.pq });
const code = (r: { json: () => unknown }) => (r.json() as { error: { code: string } }).error.code;
const newId = () => toHex(randomBytes(32));

beforeAll(async () => {
  await runMigrations(DB);
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`truncate capsules, capsule_guardians, capsule_releases, sessions, auth_nonces, cards, blobs`;
  await sql.end();
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-cap-")),
  });
  ({ app, close } = await buildServer(cfg));
  owner = await ensurePersona("cap-api-owner", { minQor: 3n });
  guardian = await ensurePersona("cap-api-guardian", { minQor: 3n });
  recipient = await ensurePersona("cap-api-recipient");
  other = await ensurePersona("cap-api-other");
  for (const x of [owner, guardian, recipient, other])
    await app.inject({ method: "PUT", url: "/cards", headers: await auth(x), payload: { card: x.card } });
}, 900_000);

afterAll(async () => close());

/** Save, invite, accept, confirm one guardian for capsule `id`. */
async function guarded(id: string) {
  const draft = sealItem({
    purpose: Purpose.capsule(id),
    readers: [recipientOf(owner.seal)],
    plaintext: utf8("{}"),
    context: "draft",
    anonymous: true,
  });
  expect(
    (
      await app.inject({
        method: "PUT",
        url: "/owner/capsules",
        headers: await auth(owner),
        payload: { id, label: "For my family", draftEnvelope: await put(draft.envelope) },
      })
    ).statusCode,
  ).toBe(200);
  const at = new Date().toISOString();
  const inv = sign(owner, {
    v: 1,
    type: "guardian-invite",
    capsule: id,
    owner: owner.address,
    guardian: guardian.address,
    label: "For my family",
    at,
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/owner/capsules/${id}/guardians`,
        headers: await auth(owner),
        payload: { invite: inv },
      })
    ).statusCode,
  ).toBe(201);
  const acc = sign(guardian, {
    v: 1,
    type: "guardian-accept",
    capsule: id,
    owner: owner.address,
    guardian: guardian.address,
    at,
  });
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/capsules/${id}/accept`,
        headers: await auth(guardian),
        payload: { accept: acc },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "POST",
        url: `/owner/capsules/${id}/guardians/${guardian.address}/confirm`,
        headers: await auth(owner),
      })
    ).statusCode,
  ).toBe(200);
}

/** Content for one recipient under seed S, S split for the guardian (threshold 1 of 1). */
async function makePlan(id: string, mode: CapsulePlan["mode"], times: Partial<CapsulePlan>) {
  const seed = randomBytes(32);
  const content = sealItem({
    purpose: Purpose.capsule(id),
    readers: [recipientOf(sealKeysFromSeed(seed))],
    plaintext: utf8(JSON.stringify({ v: 1, message: "The deeds are in the blue folder.", files: [] })),
    anonymous: true,
  });
  const { shares } = await splitSecret(seed, 2, 2);
  // Two shares, both held by the one guardian (threshold 1 of 1 guardian still splits the seed so no share alone is the seed).
  const piece = sealItem({
    purpose: Purpose.capsuleShare(id),
    readers: [recipientOf(guardian.seal)],
    plaintext: utf8(JSON.stringify({ recipient: recipient.address, shares: shares.map((s) => toHex(s)) })),
    context: recipient.address,
    anonymous: true,
  });
  const plan: CapsulePlan = {
    v: 1,
    id,
    owner: owner.address,
    label: "For my family",
    mode,
    releaseAt: 0,
    waitSeconds: 0,
    quietSeconds: 0,
    accessSeconds: 30 * 86400,
    guardians: [guardian.address],
    threshold: 1,
    recipients: [{ address: recipient.address, content: await put(content.envelope), files: 0 }],
    pieces: [{ guardian: guardian.address, recipient: recipient.address, envelope: await put(piece.envelope) }],
    deleteAfter: false,
    version: 1,
    at: new Date().toISOString(),
    ...times,
  };
  return { plan, seed };
}

const chainPlan = (p: CapsulePlan) => ({
  id: `0x${p.id}` as const,
  mode: MODE_INDEX[p.mode],
  guardians: [guardian.evm],
  threshold: p.threshold,
  releaseAt: BigInt(p.releaseAt),
  waitSeconds: BigInt(p.waitSeconds),
  quietSeconds: BigInt(p.quietSeconds),
  accessSeconds: BigInt(p.accessSeconds),
  planHash: planHash(p),
});

describe("capsules", () => {
  it("capsule A: request, reject, request, cancel; the API keeps only plans that match the chain", async () => {
    const id = newId();
    await guarded(id);
    const { plan } = await makePlan(id, "after-wait", { waitSeconds: 7 * 86400 });
    // Before anything is on chain, the plan is refused.
    expect(
      code(
        await app.inject({
          method: "PUT",
          url: `/owner/capsules/${id}/plan`,
          headers: await auth(owner),
          payload: { plan: sign(owner, plan), txHash: `0x${"0".repeat(64)}` },
        }),
      ),
    ).toBe("NOT_ON_CHAIN");
    const tx = await createCapsuleOnChain(owner, chainPlan(plan));
    // A plan that differs from the chain's hash is refused.
    const changed = { ...plan, label: "Something else" };
    expect(
      code(
        await app.inject({
          method: "PUT",
          url: `/owner/capsules/${id}/plan`,
          headers: await auth(owner),
          payload: { plan: sign(owner, changed), txHash: tx },
        }),
      ),
    ).toBe("PLAN_MISMATCH");
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/owner/capsules/${id}/plan`,
          headers: await auth(owner),
          payload: { plan: sign(owner, plan), txHash: tx },
        })
      ).statusCode,
    ).toBe(200);

    await requestCapsuleRelease(guardian, `0x${id}`);
    expect((await readCapsule(`0x${id}`)).status).toBe("requested");
    await rejectCapsuleRequest(owner, `0x${id}`);
    const afterReject = await readCapsule(`0x${id}`);
    expect(afterReject.status).toBe("armed");
    expect(afterReject.guardians.map((g) => g.toLowerCase())).toContain(guardian.evm.toLowerCase());
    await requestCapsuleRelease(guardian, `0x${id}`);
    const pending = await readCapsule(`0x${id}`);
    expect(pending.status).toBe("requested");
    expect(pending.opensAt).toBe(pending.requestedAt + 7n * 86400n);
    // Not released: the guardian's pieces are refused.
    const early = sealItem({
      purpose: Purpose.capsuleShare(id),
      readers: [recipientOf(recipient.seal)],
      plaintext: utf8("x"),
      anonymous: true,
    });
    expect(
      code(
        await app.inject({
          method: "POST",
          url: `/capsules/${id}/release`,
          headers: await auth(guardian),
          payload: { version: 1, items: [{ recipient: recipient.address, envelope: await put(early.envelope) }] },
        }),
      ),
    ).toBe("NOT_RELEASED");
    await cancelCapsuleOnChain(owner, `0x${id}`);
    expect((await readCapsule(`0x${id}`)).status).toBe("cancelled");
    expect(
      (await app.inject({ method: "POST", url: `/owner/capsules/${id}/cancelled`, headers: await auth(owner) }))
        .statusCode,
    ).toBe(200);
    const forMe = (await app.inject({ url: "/capsules/for-me", headers: await auth(recipient) })).json<{
      capsules: { id: string; state: string }[];
    }>();
    expect(forMe.capsules.find((c) => c.id === id)?.state).toBe("cancelled");
  });

  it("capsule B: opens at a set time; after finalize the guardian re-seals and the recipient opens only their content", async () => {
    const id = newId();
    await guarded(id);
    const opens = Number(await chainNow()) + 40;
    const { plan, seed } = await makePlan(id, "at-time", { releaseAt: opens });
    const tx = await createCapsuleOnChain(owner, chainPlan(plan));
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/owner/capsules/${id}/plan`,
          headers: await auth(owner),
          payload: { plan: sign(owner, plan), txHash: tx },
        })
      ).statusCode,
    ).toBe(200);
    expect((await readCapsule(`0x${id}`)).status).toBe("armed");
    // Wait for the chain's clock, then record the release.
    while (Number(await chainNow()) < opens) await new Promise((r) => setTimeout(r, 4000));
    await finalizeCapsule(guardian, `0x${id}`);
    const released = await readCapsule(`0x${id}`);
    expect(released.status).toBe("released");

    // The guardian's device: the plan it holds matches the chain; open the piece, re-seal it to the recipient.
    const g = (await app.inject({ url: "/capsules/guarding", headers: await auth(guardian) })).json<{
      capsules: { id: string; plan: { body: CapsulePlan } | null }[];
    }>();
    const held = g.capsules.find((c) => c.id === id)?.plan?.body;
    expect(held && planHash(held)).toBe(released.planHash);
    const env = await blob(held?.pieces[0]?.envelope ?? "");
    const piece = openItem({
      purpose: Purpose.capsuleShare(id),
      envelope: env,
      keys: guardian.seal,
      context: recipient.address,
    });
    const again = sealItem({
      purpose: Purpose.capsuleShare(id),
      readers: [recipientOf(recipient.seal)],
      plaintext: piece,
      context: "release",
      anonymous: true,
    });
    // Pieces go only to recipients in the plan, and only from its guardians.
    expect(
      code(
        await app.inject({
          method: "POST",
          url: `/capsules/${id}/release`,
          headers: await auth(guardian),
          payload: { version: 1, items: [{ recipient: other.address, envelope: await put(again.envelope) }] },
        }),
      ),
    ).toBe("NOT_A_RECIPIENT");
    expect(
      code(
        await app.inject({
          method: "POST",
          url: `/capsules/${id}/release`,
          headers: await auth(other),
          payload: { version: 1, items: [{ recipient: recipient.address, envelope: await put(again.envelope) }] },
        }),
      ),
    ).toBe("NOT_A_GUARDIAN");
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/capsules/${id}/release`,
          headers: await auth(guardian),
          payload: { version: 1, items: [{ recipient: recipient.address, envelope: await put(again.envelope) }] },
        })
      ).statusCode,
    ).toBe(200);

    // The recipient's device: open the piece, rebuild the seed, open the content.
    const mine = (await app.inject({ url: "/capsules/for-me", headers: await auth(recipient) })).json<{
      capsules: { id: string; pieces: { envelope: string }[]; plan: { body: CapsulePlan } }[];
    }>();
    const cap = mine.capsules.find((c) => c.id === id);
    expect(cap?.pieces).toHaveLength(1);
    const body = JSON.parse(
      fromUtf8(
        openItem({
          purpose: Purpose.capsuleShare(id),
          envelope: await blob(cap?.pieces[0]?.envelope ?? ""),
          keys: recipient.seal,
          context: "release",
        }),
      ),
    ) as { shares: string[] };
    const rebuilt = await combineShares(
      body.shares.map((h) => Uint8Array.from(Buffer.from(h, "hex"))),
      2,
    );
    expect(toHex(rebuilt)).toBe(toHex(seed));
    const content = JSON.parse(
      fromUtf8(
        openItem({
          purpose: Purpose.capsule(id),
          envelope: await blob(cap?.plan.body.recipients[0]?.content ?? ""),
          keys: sealKeysFromSeed(rebuilt),
        }),
      ),
    ) as { message: string };
    expect(content.message).toBe("The deeds are in the blue folder.");
    // Someone not named sees nothing.
    expect(
      (await app.inject({ url: "/capsules/for-me", headers: await auth(other) })).json<{ capsules: unknown[] }>()
        .capsules,
    ).toHaveLength(0);
  });
});
