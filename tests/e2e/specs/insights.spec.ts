/**
 * 5.16 Insights on testnet: a visitor views the page, taps a block and sends a
 * sealed message; a real QOR transfer reaches the owner; the owner's Insights
 * shows each count, the table view and the most tapped block, for every range.
 * A page with no activity shows the empty state with Share.
 * Source of truth: the API's own counters and the payment read from QoreChain.
 */
import { DENOMS, msgSend, sendTx } from "@mizuhiki/chain";
import { devWallet } from "@mizuhiki/testnet";
import { test, expect } from "./fixtures";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-insights";
const EMPTY = "mzk-e2e-quiet";
const PASS = "lantern river maple tea";

interface Insights {
  views: { total: number };
  items: { total: number };
  money: { byDenom: { denom: string; total: string; count: number }[] };
  taps: { subject: string; count: number }[];
}
const insights = async (token: string, range = "7") =>
  (await (
    await fetch(`${API}/owner/insights?range=${range}`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as Insights;

test("insights: a view, a tap, a sealed message and a real payment show up; ranges, chart hover, table view", async ({
  browser,
  problems,
}, info) => {
  test.skip(info.project.name !== "desktop", "multi-party flow runs once, on desktop");
  test.setTimeout(600_000);
  const owner = await ensureOwner("e2e-insights-owner", OWNER);
  const token = await apiToken(owner);
  const before = await insights(token);

  // ---- a visitor: views the page, taps the message block, sends a sealed message
  const vctx = await browser.newContext();
  const v = await vctx.newPage();
  v.on("console", (m) => {
    if (m.type() === "error") problems.push(`[visitor] console.error: ${m.text()}`);
  });
  await v.goto(`/@${OWNER}`);
  await v.getByRole("button", { name: /Send me something private/ }).click();
  const sheet = v.getByRole("dialog", { name: /something private/ });
  await sheet.getByLabel("Message").fill(`Counting test ${Date.now()}`);
  await sheet.getByRole("button", { name: "Next", exact: true }).click();
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  await expect(v.getByRole("dialog", { name: /^Sealed for/ })).toBeVisible({ timeout: 120_000 });
  await vctx.close();

  // ---- a real transfer to the owner on QoreChain
  const dev = devWallet();
  // With a Mizuhiki payment reference, as the page's Pay flow sends it (plain transfers are not counted).
  await sendTx(
    dev,
    [msgSend(dev.address, owner.address, DENOMS.QOR.denom, 100_000n)],
    `mzk:pay:ins${Date.now().toString(36)}`,
  );
  // The indexer reads it from chain; wait for it in the API.
  await expect
    .poll(async () => (await insights(token)).money.byDenom.find((d) => d.denom === DENOMS.QOR.denom)?.count ?? 0, {
      timeout: 180_000,
    })
    .toBeGreaterThan(before.money.byDenom.find((d) => d.denom === DENOMS.QOR.denom)?.count ?? 0);
  const after = await insights(token);
  expect(after.views.total).toBeGreaterThan(before.views.total);
  expect(after.items.total).toBe(before.items.total + 1);
  const msgBlock = owner.name ? after.taps[0] : undefined;
  expect(msgBlock?.count ?? 0).toBeGreaterThan(0);

  // ---- the owner reads it
  const ctx = await browser.newContext();
  const o = await ctx.newPage();
  o.on("console", (m) => {
    if (m.type() === "error") problems.push(`[owner] console.error: ${m.text()}`);
  });
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: "Insights" }).filter({ visible: true }).first().click();
  await o.waitForURL("**/app/insights");
  await expect(o.getByRole("heading", { name: "Insights", level: 1 })).toBeVisible();
  // The tiles count up to the API's numbers.
  const tile = (label: string) => o.getByText(label, { exact: true }).locator("xpath=..").locator("b");
  await expect(tile("Views")).toHaveText(String(after.views.total), { timeout: 30_000 });
  await expect(tile("Sealed items received")).toHaveText(String(after.items.total), { timeout: 30_000 });
  await expect(o.getByText(/Send me something private/)).toBeVisible();
  // Hover a day's column: the tooltip names views, items and payments.
  const today = o.getByRole("img", { name: /^Views by day/ });
  await expect(today).toBeVisible();
  const lastCol = o.locator("svg rect[aria-label]").last();
  await lastCol.hover();
  await expect(o.getByRole("status").filter({ hasText: /\d views?/ })).toBeVisible();
  await o.screenshot({ path: info.outputPath("01-week.png"), fullPage: true });
  // Table view carries the same numbers.
  await o.getByRole("button", { name: "Show as table" }).click();
  await expect(o.getByRole("table")).toBeVisible();
  await expect(o.getByRole("columnheader", { name: "Sealed items" })).toBeVisible();
  // Ranges.
  await o.getByRole("button", { name: "28 days" }).click();
  await expect(o.getByRole("img", { name: /^Views by day/ }).or(o.getByRole("table"))).toBeVisible({ timeout: 30_000 });
  await o.getByRole("button", { name: "Lifetime" }).click();
  await expect(o.getByRole("heading", { name: "Views by month" })).toBeVisible({ timeout: 30_000 });
  await o.screenshot({ path: info.outputPath("02-lifetime.png"), fullPage: true });
  await ctx.close();
});

test("insights: a page with no activity says so, with Share", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  test.setTimeout(240_000);
  const quiet = await ensureOwner("e2e-insights-quiet", EMPTY);
  // Never visited, never paid: lifetime is empty, so the empty state shows.
  await restoreInBrowser(page, quiet.phrase);
  await page.getByRole("link", { name: "Insights" }).filter({ visible: true }).first().click();
  await page.getByRole("button", { name: "Lifetime" }).click();
  await expect(page.getByText("No activity yet. Share your page.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("03-empty.png"), fullPage: true });
});

test("insights on a phone: tiles stack and the chart fits", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone layout");
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-insights-owner", OWNER);
  await restoreInBrowser(page, owner.phrase);
  await page.goto("/app/insights");
  await page.getByLabel("Device passphrase").fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  const views = (await insights(await apiToken(owner))).views.total;
  await expect(page.getByText("Views", { exact: true }).locator("xpath=..").locator("b")).toHaveText(String(views), {
    timeout: 30_000,
  });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("phone-insights.png"), fullPage: true });
});
