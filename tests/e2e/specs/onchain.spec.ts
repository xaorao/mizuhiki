/**
 * Proof on QoreChain, as a visitor: every part is read from the test network in the browser. Contracts show
 * code and a confirming receipt, the demo account's keys are registered, a hybrid transaction's ML-DSA-87
 * signature verifies here, recent activity is listed; with QoreChain unreachable the page says so and recovers
 * with Try again, never inventing anything. Reached from the landing page.
 */
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

const CHAIN = /qore\.host|127\.0\.0\.1:4000\/chain/;
test.use({ allowFailedUrls: CHAIN });

test("proof page: contracts, keys, a signature verified here, and live activity", async ({ page }, info) => {
  test.setTimeout(240_000);
  await page.goto("/");
  await page.getByRole("link", { name: /See every contract, key and signature/ }).click();
  await page.waitForURL("**/onchain");
  await expect(page.getByRole("heading", { level: 1, name: "Proof on QoreChain" })).toBeVisible();

  const contracts = page.getByRole("region", { name: "Our contracts" });
  await expect(contracts.getByText("Deployed, receipt confirms")).toHaveCount(3, { timeout: 90_000 });
  for (const name of ["MizuhikiRegistry", "CapsuleVault", "AnchorBook"])
    await expect(contracts.getByText(name)).toBeVisible();

  const keys = page.getByRole("region", { name: "Post-quantum keys of @aria" });
  await expect(keys.getByText("Registered, possession proven")).toBeVisible({ timeout: 90_000 });
  await expect(keys.getByText("Published on QoreChain")).toBeVisible();
  await expect(keys.getByText("ML-KEM-1024")).toBeVisible();

  const sigs = page.getByRole("region", { name: "Signatures you can check yourself" });
  await expect(sigs.getByText("Verified in your browser")).toBeVisible({ timeout: 120_000 });
  await expect(sigs.getByText("Signature did not verify")).toHaveCount(0);

  const activity = page.getByRole("region", { name: "Latest activity on our contracts" });
  await expect(activity.getByText(/blocks ago/).first()).toBeVisible({ timeout: 180_000 });
  // Every row links to its transaction on the explorer.
  const links = activity.getByRole("link", { name: /^Transaction / });
  expect(await links.count()).toBeGreaterThan(0);
  expect(await links.first().getAttribute("href")).toMatch(/^https:\/\/explore\.qore\.network\/tx\//);

  const width = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(width[0]).toBeLessThanOrEqual(width[1]!);
  await page.screenshot({ path: info.outputPath("onchain.png"), fullPage: true });
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
});

test("proof page with QoreChain unreachable says so, shows nothing made up, and recovers", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(240_000);
  await page.route(CHAIN, (r) => r.abort("connectionrefused"));
  await page.goto("/onchain");
  await expect(page.getByText(/QoreChain could not be reached just now/).first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText("Deployed, receipt confirms")).toHaveCount(0);
  await expect(page.getByText("Verified in your browser")).toHaveCount(0);
  await page.unroute(CHAIN);
  await page.getByRole("button", { name: "Try again" }).first().click();
  await expect(page.getByText("Deployed, receipt confirms")).toHaveCount(3, { timeout: 90_000 });
  await expect(page.getByText("Verified in your browser")).toBeVisible({ timeout: 120_000 });
});
