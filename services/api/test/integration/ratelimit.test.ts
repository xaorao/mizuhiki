/**
 * The hosted web app's server reads public pages for every visitor from one address. With the shared key those reads
 * get their own budget; without it, or with a wrong key, they count against that address like anyone else's.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { runMigrations } from "@mizuhiki/db";
import { loadConfig } from "../../src/config";
import { buildServer } from "../../src/server";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
const KEY = "k".repeat(16) + "internal-read-key-for-tests";
let app: FastifyInstance;
let close: () => Promise<void>;

beforeAll(async () => {
  await runMigrations(DB);
  ({ app, close } = await buildServer(
    loadConfig({
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: DB,
      BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-blobs-")),
      INTERNAL_READ_KEY: KEY,
    }),
  ));
}, 120_000);
afterAll(async () => close());

const hit = (headers: Record<string, string> = {}) => app.inject({ url: "/health", headers }).then((r) => r.statusCode);

describe("rate budget for the hosted web app's server", () => {
  it("keeps the web server's reads going after this address has used its own budget, and only with the right key", async () => {
    for (let i = 0; i < 300; i++) expect(await hit()).toBe(200);
    expect(await hit()).toBe(429);
    expect(await hit({ "x-mzk-internal": "not-the-key-but-long-enough-to-look-real" })).toBe(429);
    for (let i = 0; i < 50; i++) expect(await hit({ "x-mzk-internal": KEY })).toBe(200);
  });

  it("refuses a key shorter than 32 characters, and an empty origin list", () => {
    expect(() => loadConfig({ INTERNAL_READ_KEY: "short" })).toThrow();
    expect(() => loadConfig({ WEB_ORIGIN: " , " })).toThrow(/at least one origin/);
  });
});
