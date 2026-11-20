/**
 * Dependencies failing one at a time, as a visitor meets them (QA guide 5.23): QoreChain unreachable while a page
 * is checked, our API refusing a send, the device going offline mid-send. Each must blame the right party, keep
 * what the person typed, never claim success, and recover with Try again once the dependency is back. The failure
 * is made at the network edge of the visitor's browser (requests to that host refused), which is exactly what the
 * browser sees when the service is down.
 */
import { test, expect } from "./fixtures";
import { ensureOwner, restoreInBrowser } from "./owner";

const NAME = "mzk-e2e-editor";
const CHAIN = /qore\.host/;
const API_WRITE = /127\.0\.0\.1:4000\/(drop|blobs)/;
const API_ALL = /127\.0\.0\.1:4000/;
test.use({ allowFailedUrls: new RegExp(`${CHAIN.source}|${API_ALL.source}`) });

test("QoreChain unreachable: the page says so and offers a retry, never a mismatch", async ({ page }, info) => {
  await page.route(CHAIN, (r) => r.abort("connectionrefused"));
  await page.goto(`/@${NAME}`);
  await expect(page.getByRole("heading", { name: "QoreChain could not be reached" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/does not match/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Send me something private/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("chain-down.png"), fullPage: true });
  // QoreChain answers again: Try again checks and shows the verified page.
  await page.unroute(CHAIN);
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/checked on QoreChain just now/)).toBeVisible({ timeout: 60_000 });
});

test("our API refuses a send: honest message, text kept, Try again delivers", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(240_000);
  const text = `API failure check ${Date.now()}`;
  await page.goto(`/@${NAME}/message`);
  const sheet = page.getByRole("dialog", { name: /something private/ });
  await sheet.getByLabel("Message").fill(text);
  await sheet.getByRole("button", { name: "Next" }).click();
  await page.route(API_WRITE, (r) => r.abort("connectionrefused"));
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  await expect(sheet.getByText("Mizuhiki could not be reached. Check your connection.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(sheet.getByText(/sealed\./)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("api-down.png") });
  await page.unroute(API_WRITE);
  await sheet.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/Stored for .+, sealed\./)).toBeVisible({ timeout: 120_000 });
});

test("offline mid-send: says offline, keeps the text, delivers once back online", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(240_000);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const text = `Offline check ${Date.now()}`;
  await page.goto(`/@${NAME}/message`);
  const sheet = page.getByRole("dialog", { name: /something private/ });
  await sheet.getByLabel("Message").fill(text);
  await sheet.getByRole("button", { name: "Next" }).click();
  await ctx.setOffline(true);
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  await expect(sheet.getByText(/offline, or (Mizuhiki and )?QoreChain could not be reached/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(sheet.getByText(/while sealing/)).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("offline.png") });
  await ctx.setOffline(false);
  await sheet.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText(/Stored for .+, sealed\./)).toBeVisible({ timeout: 120_000 });
  await ctx.close();
});

test("our API down while the owner is in the app: every screen says so, offers Try again, and recovers", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(300_000);
  // Reduced motion: the error cards animate in, and the clicks below need still targets.
  await page.emulateMedia({ reducedMotion: "reduce" });
  const owner = await ensureOwner("e2e-editor", NAME);
  await restoreInBrowser(page, owner.phrase);
  await page.route(API_ALL, (r) => r.abort("connectionrefused"));
  const nav = page.getByRole("navigation", { name: "Owner sections" });
  for (const label of [
    "Inbox",
    "Invoices",
    "Forms",
    "File requests",
    "Shop",
    "Rooms",
    "Proofs",
    "Passes",
    "Capsules",
    "Spare key",
    "Insights",
    "Settings",
  ]) {
    await nav
      .getByRole("link", { name: new RegExp(`^${label}( \\d+)?$`) })
      .first()
      .click();
    // An honest message with a way forward, never a skeleton that never ends.
    await expect(page.getByText(/could not be reached/).first(), label).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Try again" }).first(), label).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("owner-api-down-settings.png"), fullPage: true });
  // Back up: Try again on Settings loads the profile and the names.
  await page.unroute(API_ALL);
  // Each retry re-renders the screen, so press the first visible one left until none are.
  const retry = page.getByRole("button", { name: "Try again" }).filter({ visible: true });
  // A screen can recover on its own between the count and the click, so a vanished button is not a failure.
  for (let i = 0; i < 6 && (await retry.count()) > 0; i++) {
    await retry
      .first()
      .click({ timeout: 5_000 })
      .catch(() => undefined);
    await page.waitForLoadState("networkidle");
  }
  await expect(page.getByText(`@${NAME}`).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/could not be reached/).filter({ visible: true })).toHaveCount(0, { timeout: 60_000 });
});
