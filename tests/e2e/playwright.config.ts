import { defineConfig, devices } from "@playwright/test";

/** Runs against the local environment started by `pnpm dev` (web on :3000, API on :4000, QoreChain testnet). */
export default defineConfig({
  testDir: "specs",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL: process.env.WEB_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      testIgnore: /browsers\.spec/,
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "phone",
      testIgnore: /browsers\.spec/,
      use: { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } },
    },
    // The core journey, which runs post-quantum cryptography in the browser, in Firefox and Safari too.
    {
      name: "firefox",
      testMatch: /browsers\.spec/,
      use: { ...devices["Desktop Firefox"], viewport: { width: 1440, height: 900 } },
    },
    {
      name: "webkit",
      testMatch: /browsers\.spec/,
      use: { ...devices["Desktop Safari"], viewport: { width: 1440, height: 900 } },
    },
    { name: "iphone", testMatch: /browsers\.spec/, use: { ...devices["iPhone 14"] } },
  ],
});
