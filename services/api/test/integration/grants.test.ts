/**
 * Starter grants (ARCHITECTURE 8h) against the real testnet: a fresh account proves control with its classical key
 * and a proof of work and gets the grant once; everything else is refused with nothing sent and nothing recorded.
 * Uses the provisioned testnet sponsor (services/api/.env.local) with a tiny amount per grant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signSiwq } from "@qorechain/qoresign";
import type { FastifyInstance } from "fastify";
import { DENOMS, balanceOf, waitForTx } from "@mizuhiki/chain";
import { deriveAccount, newPhrase, sha256Hex, solvePow, utf8 } from "@mizuhiki/core";
import { runMigrations } from "@mizuhiki/db";
import { ensurePersona } from "@mizuhiki/testnet";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
const AMOUNT = 1000; // uqor per grant in this test: enough to prove the transfer, cheap to repeat
const envFile = new URL("../../.env.local", import.meta.url);
const sponsorPhrase = existsSync(envFile)
  ? /^SPONSOR_PHRASE="?([^"\n]+)"?/m.exec(readFileSync(envFile, "utf8"))?.[1]
  : undefined;

const servers: { close: () => Promise<void> }[] = [];
async function server(env: Record<string, string>): Promise<FastifyInstance> {
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-grant-")),
    STARTER_GRANT_UQOR: String(AMOUNT),
    STARTER_POW_BITS: "8",
    STARTER_REQUESTS_PER_10MIN: "100",
    SPONSOR_PHRASE: "",
    ...env,
  });
  const s = await buildServer(cfg);
  servers.push(s);
  return s.app;
}

/** What the sign-up screen does: a challenge, a classical-only signature, a proof of work bound to both. */
async function ask(app: FastifyInstance, phrase: string, o: { signWith?: string; badPow?: boolean } = {}) {
  const me = deriveAccount(phrase);
  const signer = deriveAccount(o.signWith ?? phrase);
  const ch = (
    await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: me.address.bech32 } })
  ).json<{ message: string; nonce: string }>();
  let signature;
  try {
    signature = signSiwq({ message: ch.message, classicalKey: signer.classical });
  } catch {
    // signSiwq refuses a key that does not control the address; forge the shape with the other key's signature
    const other = deriveAccount(o.signWith ?? phrase);
    const msg = ch.message.replace(me.address.bech32, other.address.bech32);
    signature = signSiwq({ message: msg, classicalKey: other.classical });
  }
  const pow = solvePow(me.address.bech32, sha256Hex(utf8(ch.nonce)), 8);
  if (o.badPow) pow.nonce += 1;
  const res = await app.inject({
    method: "POST",
    url: "/grants/starter",
    payload: { nonce: ch.nonce, signature, pow },
  });
  return { res, address: me.address.bech32, nonce: ch.nonce, signature, pow };
}

let app: FastifyInstance;
beforeAll(async () => {
  if (!sponsorPhrase) throw new Error("Provision the sponsor first: pnpm --filter @mizuhiki/api sponsor:provision");
  await runMigrations(DB);
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`truncate starter_grants, auth_nonces`;
  await sql.end();
  app = await server({ SPONSOR_PHRASE: sponsorPhrase, STARTER_PER_IP_DAY: "2" });
}, 120_000);

afterAll(async () => {
  for (const s of servers) await s.close();
});

describe("starter grants", () => {
  it("says it is on, how much, and how hard the anti-spam check is", async () => {
    const r = (await app.inject({ url: "/grants/starter" })).json<{
      enabled: boolean;
      amount: string;
      powBits: number;
    }>();
    expect(r).toMatchObject({ enabled: true, amount: String(AMOUNT), powBits: 8 });
  });

  it("a fresh account gets its grant once, read back from QoreChain; a second ask is refused", async () => {
    const phrase = newPhrase(24);
    const first = await ask(app, phrase);
    expect(first.res.statusCode).toBe(200);
    const body = first.res.json<{ txHash: string; amount: string }>();
    expect(body.txHash).toMatch(/^[0-9A-F]{64}$/);
    const tx = await waitForTx(body.txHash);
    expect(tx.code).toBe(0);
    expect(await balanceOf(first.address, DENOMS.QOR.denom)).toBe(BigInt(AMOUNT));
    const again = await ask(app, phrase);
    expect(again.res.statusCode).toBe(409);
    expect(again.res.json<{ error: { code: string } }>().error.code).toBe("ALREADY_ON_CHAIN");
  }, 180_000);

  it("refuses an account that is already on chain", async () => {
    const existing = await ensurePersona("grants-existing");
    const r = await ask(app, existing.phrase);
    expect(r.res.statusCode).toBe(409);
    expect(r.res.json<{ error: { code: string } }>().error.code).toBe("ALREADY_ON_CHAIN");
  }, 180_000);

  it("refuses a signature from a key that does not control the address, a bad proof of work and a reused challenge", async () => {
    const wrong = await ask(app, newPhrase(24), { signWith: newPhrase(24) });
    expect(wrong.res.statusCode).toBe(401);
    expect(wrong.res.json<{ error: { code: string } }>().error.code).toBe("NOT_YOURS");
    const pow = await ask(app, newPhrase(24), { badPow: true });
    expect(pow.res.statusCode).toBe(429);
    expect(pow.res.json<{ error: { code: string } }>().error.code).toBe("POW");
    // The challenge of that refused ask was used up: sending it again is refused as expired.
    const replay = await app.inject({
      method: "POST",
      url: "/grants/starter",
      payload: { nonce: pow.nonce, signature: pow.signature, pow: { ...pow.pow, nonce: pow.pow.nonce - 1 } },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json<{ error: { code: string } }>().error.code).toBe("EXPIRED");
  }, 120_000);

  it("holds the per-network daily limit: the second grant from this network passes, the third is refused", async () => {
    const second = await ask(app, newPhrase(24));
    expect(second.res.statusCode).toBe(200);
    await waitForTx(second.res.json<{ txHash: string }>().txHash);
    const third = await ask(app, newPhrase(24));
    expect(third.res.statusCode).toBe(429);
    expect(third.res.json<{ error: { code: string } }>().error.code).toBe("IP_CAP");
  }, 180_000);

  it("an empty sponsor refuses honestly and records nothing; with no sponsor the feature is off", async () => {
    const empty = await server({ SPONSOR_PHRASE: newPhrase(24) });
    const r = await ask(empty, newPhrase(24));
    expect(r.res.statusCode).toBe(503);
    expect(r.res.json<{ error: { code: string } }>().error.code).toBe("SPONSOR_LOW");
    const postgres = (await import("postgres")).default;
    const sql = postgres(DB);
    const rows = await sql`select 1 from starter_grants where address = ${r.address}`;
    await sql.end();
    expect(rows.length).toBe(0);
    const off = await server({});
    expect((await off.inject({ url: "/grants/starter" })).json()).toEqual({ enabled: false, reason: "off" });
    const post = await ask(off, newPhrase(24));
    expect(post.res.statusCode).toBe(404);
  }, 120_000);

  it("limits grant requests per network address before any other check", async () => {
    const tight = await server({ SPONSOR_PHRASE: sponsorPhrase ?? "", STARTER_REQUESTS_PER_10MIN: "2" });
    const codes: number[] = [];
    for (let i = 0; i < 3; i++)
      codes.push((await tight.inject({ method: "POST", url: "/grants/starter", payload: {} })).statusCode);
    expect(codes).toEqual([400, 400, 429]);
  });
});
