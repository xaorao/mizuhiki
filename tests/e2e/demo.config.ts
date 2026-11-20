import { defineConfig, devices } from "@playwright/test";

/** Demo content and landing screenshots (spec 5.1). Run on purpose, never in the regular suite. */
export default defineConfig({
  testDir: "demo",
  timeout: 1_800_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.WEB_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "demo", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
