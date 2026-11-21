import { defineConfig } from "@playwright/test";

/** Makes the @aria demo content through the real app (tools/demo-content.spec.ts). Not part of the test suites. */
export default defineConfig({
  testDir: ".",
  testMatch: /demo-content\.spec\.ts/,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: { baseURL: process.env.WEB_URL ?? "http://localhost:3000", trace: "retain-on-failure" },
});
