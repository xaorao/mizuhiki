/**
 * Session and navigation continuity (QA guide 5.4, 5.19): a logged-out deep link returns to exactly that address
 * after restoring; a reload of any owner screen asks for the device passphrase and comes back to the same screen;
 * back and forward move between screens; two tabs never hold the key at once and taking over locks the other;
 * the whole restore and the owner navigation work from the keyboard alone.
 */
import { test, expect } from "./fixtures";
import { ensureOwner, restoreInBrowser } from "./owner";

// Its own account: a reload signs in again, and these runs must not spend another suite's sign-in budget.
const NAME = "mzk-e2e-nav";
// Set up once per run: every setup is a sign-in, and sign-ins are limited per account (20 a minute).
let ready: ReturnType<typeof ensureOwner> | undefined;
const account = () => (ready ??= ensureOwner("e2e-nav", NAME));
const PASS = "lantern river maple tea";
const ROUTES = [
  "/app",
  "/app/design",
  "/app/insights",
  "/app/inbox",
  "/app/forms",
  "/app/requests",
  "/app/shop",
  "/app/rooms",
  "/app/invoices",
  "/app/proof",
  "/app/passes",
  "/app/capsules",
  "/app/spare-key",
  "/app/settings",
];

test("a logged-out deep link comes back to the same address, query and hash included, after restoring", async ({
  page,
}) => {
  const owner = await account();
  await page.goto("/app/invoices?filter=paid#list");
  await page.waitForURL(/\/login\?next=/);
  expect(decodeURIComponent(new URL(page.url()).searchParams.get("next") ?? "")).toBe("/app/invoices?filter=paid#list");
  await page.getByLabel("Recovery phrase").fill(owner.phrase);
  await page.getByLabel("New passphrase for this device").fill(PASS);
  await page.getByRole("button", { name: "Restore on this device" }).click();
  await page.waitForURL("**/app/invoices?filter=paid#list");
  await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
});

test("back and forward move between owner screens without reloading", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop navigation");
  const owner = await account();
  await restoreInBrowser(page, owner.phrase);
  const nav = page.getByRole("navigation", { name: "Owner sections" });
  await nav.getByRole("link", { name: /^Inbox/ }).click();
  await page.waitForURL("**/app/inbox");
  await nav.getByRole("link", { name: "Invoices" }).click();
  await page.waitForURL("**/app/invoices");
  await nav.getByRole("link", { name: "Forms" }).click();
  await page.waitForURL("**/app/forms");
  await page.goBack();
  await page.waitForURL("**/app/invoices");
  await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
  await page.goBack();
  await page.waitForURL("**/app/inbox");
  await expect(page.getByRole("region", { name: "Inbox list" })).toBeVisible();
  await page.goForward();
  await page.waitForURL("**/app/invoices");
  // Client-side the whole way: the account never locked.
  await expect(page.getByRole("heading", { name: "Welcome back" })).toHaveCount(0);
});

test("two tabs: the second one says the key is open elsewhere; taking over locks the first", async ({
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const owner = await account();
  const one = await context.newPage();
  await restoreInBrowser(one, owner.phrase);
  const two = await context.newPage();
  await two.goto("/app/inbox");
  await expect(two.getByText("Mizuhiki is open in another tab of this browser.")).toBeVisible({ timeout: 30_000 });
  await two.getByRole("button", { name: "Use it here instead" }).click();
  await expect(two.getByRole("heading", { name: "Welcome back" })).toBeVisible({ timeout: 30_000 });
  await two.getByLabel("Device passphrase").fill(PASS);
  await two.getByRole("button", { name: "Unlock" }).click();
  await two.waitForURL("**/app/inbox");
  await expect(two.getByRole("region", { name: "Inbox list" })).toBeVisible();
  // The first tab gave up the key: it shows the same "open elsewhere" screen, not stale data it can still change.
  await expect(one.getByText("Mizuhiki is open in another tab of this browser.")).toBeVisible({ timeout: 30_000 });
  await expect(one.getByRole("navigation", { name: "Owner sections" })).toHaveCount(0);
});

test("keyboard only: restore the account and move between owner screens", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "keyboard");
  const owner = await account();
  await page.goto("/login");
  const phrase = page.getByLabel("Recovery phrase");
  // Reach the phrase field with Tab, from the top of the page.
  for (let i = 0; i < 12 && !(await phrase.evaluate((el) => el === document.activeElement)); i++)
    await page.keyboard.press("Tab");
  await expect(phrase).toBeFocused();
  await page.keyboard.type(owner.phrase);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const pass = page.getByLabel("New passphrase for this device");
  if (!(await pass.evaluate((el) => el === document.activeElement))) await pass.focus();
  await page.keyboard.type(PASS);
  await page.keyboard.press("Enter");
  await page.waitForURL("**/app");
  // The owner navigation by keyboard: focus a link, Enter opens it, focus stays visible.
  const inbox = page.getByRole("navigation", { name: "Owner sections" }).getByRole("link", { name: /^Inbox/ });
  await inbox.focus();
  const ring = await inbox.evaluate(
    (el) => getComputedStyle(el).outlineStyle !== "none" || getComputedStyle(el).boxShadow !== "none",
  );
  expect(ring).toBe(true);
  await page.keyboard.press("Enter");
  await page.waitForURL("**/app/inbox");
});

test("a reload on every owner screen asks for the passphrase and returns to that screen", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(400_000);
  // Start on a fresh sign-in window: the tests above signed in too, and fourteen reloads need fourteen more.
  await new Promise((r) => setTimeout(r, 61_000));
  const owner = await account();
  await restoreInBrowser(page, owner.phrase);
  for (const path of ROUTES) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Welcome back" }), path).toBeVisible({ timeout: 30_000 });
    // Keys live only in memory: a reload locks, and nothing of the account shows before unlocking.
    await expect(page.getByRole("navigation", { name: "Owner sections" })).toHaveCount(0);
    await page.getByLabel("Device passphrase").fill(PASS);
    await page.getByRole("button", { name: "Unlock" }).click();
    await page.waitForURL(`**${path}`);
    await expect(page.getByRole("navigation", { name: "Owner sections" }).first(), path).toBeVisible();
  }
  // Fourteen unlocks are fourteen sign-ins: let the per-account limit window pass before anything else signs in.
  await page.waitForTimeout(61_000);
});
