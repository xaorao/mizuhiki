/**
 * The proof page's chain reads against the real testnet: contract code and deploy receipts, a transaction's
 * ML-DSA-87 layer checked through our relay's RPC route over the exact committed bytes, a relay that answers
 * with a different transaction refused, and recent activity on our contracts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACTS, NETWORK, checkTx, contractFacts, nameKeys, recentActivity } from "@mizuhiki/chain";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
// @aria's sealing-key registration (hybrid, ML-DSA-87 layer) and a CapsuleVault check-in (EVM lane).
const HYBRID = "FB32F67622C7F7B37CDD58FB068341AAD092856387FCD02716A7063AA3BC95DE";
const EVM = "7A3EEC123F59CD3E89B0D8501216EDB7BD85E01A06E91172B07AE4FC92F205AF";

let base = "";
let close: () => Promise<void>;
let liar: Server;
let liarBase = "";

beforeAll(async () => {
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    API_PORT: "0",
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-blobs-")),
  });
  const built = await buildServer(cfg);
  close = built.close;
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(built.app.server.address() as AddressInfo).port}`;
  // A relay that answers every RPC read with the bytes of a different real transaction.
  liar = createServer((_req, res) => {
    void (async () => {
      const r = await fetch(`${NETWORK.rpc}/tx?hash=0x${EVM}`);
      res.setHeader("content-type", "application/json");
      res.end(await r.text());
    })();
  });
  await new Promise<void>((ok) => liar.listen(0, "127.0.0.1", ok));
  liarBase = `http://127.0.0.1:${(liar.address() as AddressInfo).port}`;
}, 120_000);
afterAll(async () => {
  liar.close();
  await close();
});

describe("proof page reads", () => {
  it("our three contracts have code, and their deploy receipts created them", async () => {
    const facts = await contractFacts();
    expect(facts.map((f) => f.key)).toEqual(["registry", "vault", "anchorBook"]);
    for (const f of facts) {
      expect(f.codeBytes).toBeGreaterThan(1_000);
      expect(f.deployOk).toBe(true);
      expect(f.deployBlock).toBeGreaterThanOrEqual(CONTRACTS.deployBlock);
    }
  });

  it("checks a hybrid transaction's ML-DSA-87 layer through our relay, over the committed bytes", async () => {
    const t = await checkTx(HYBRID, { rest: `${base}/chain`, rpcBase: `${base}/chain/rpc` });
    expect(t?.tier).toBe("pqc");
    expect(t?.messages).toEqual(["/qorechain.pqc.v1.MsgRegisterKEMKey"]);
    expect(t?.layer).toMatchObject({ present: true, verified: true });
    const evm = await checkTx(EVM, { rest: `${base}/chain`, rpcBase: `${base}/chain/rpc` });
    expect(evm?.tier).toBe("classical");
    expect(evm?.layer.present).toBe(false);
  }, 120_000);

  it("refuses a relay that answers with a different transaction", async () => {
    await expect(checkTx(HYBRID, { rest: `${base}/chain`, rpcBase: liarBase })).rejects.toThrow(
      /different transaction/,
    );
  }, 120_000);

  it("the relay forwards only a transaction read by hash", async () => {
    expect((await fetch(`${base}/chain/rpc/tx?hash=0x12`)).status).toBe(400);
    expect((await fetch(`${base}/chain/rpc/tx?hash=0x${HYBRID}&prove=true`)).status).toBe(400);
    expect((await fetch(`${base}/chain/rpc/status`)).status).toBe(404);
  });

  it("finds recent activity on our contracts, newest first, with public fields only", async () => {
    const { items, head, scannedFrom } = await recentActivity({ perKind: 2, maxChunks: 12 });
    expect(head).toBeGreaterThan(scannedFrom);
    expect(items.length).toBeGreaterThan(0);
    for (let i = 1; i < items.length; i++) expect(items[i - 1]!.block >= items[i]!.block).toBe(true);
    const name = items.find((a) => a.event === "NameClaimed");
    if (name) expect(name.name).toMatch(/^[a-z0-9._-]{3,30}$/);
  }, 240_000);
  it("reads a demo name's owner and both post-quantum keys from QoreChain", async () => {
    const k = await nameKeys("aria");
    expect(k.owner).toMatch(/^qor1/);
    expect(k.signing).toMatchObject({ registered: true, possessionProven: true, bytes: 2592 });
    expect(k.signing.fingerprint).toMatch(/^[0-9A-F]{16}$/);
    expect(k.sealing.registered).toBe(true);
    expect(k.sealing.bytes).toBeGreaterThan(1000);
    expect(await nameKeys("zz-nobody-holds-this-name")).toMatchObject({ owner: null });
  }, 120_000);
});
