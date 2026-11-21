/**
 * Real product screens for the landing (spec 5.1, quality bar "real product
 * screens"): each demo page on a phone, and @aria's owner app (inbox, room,
 * capsule, pass, Add a block). Written to apps/web/src/landing/shots/.
 * Run: pnpm --filter @mizuhiki/e2e demo:shots (after demo:seed and demo:content).
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { personaPhrase } from "@mizuhiki/testnet";
import { test, expect } from "../specs/fixtures";
import { restoreInBrowser } from "../specs/owner";

const OUT = resolve(import.meta.dirname, "../../../apps/web/src/landing/shots");
const STATE = resolve(import.meta.dirname, "../../../var/demo-content.json");
mkdirSync(OUT, { recursive: true });

/** The development build's corner badge is not part of the product. */
const clean = (page: Page) => page.addStyleTag({ content: "nextjs-portal{display:none!important}" });

test.use({ actionTimeout: 60_000 });

test("demo pages on a phone", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  const page = await ctx.newPage();
  for (const name of ["aria", "rohan.law", "sunrise.clinic", "maya.studio", "kapoor.family"]) {
    await page.goto(`/@${name}`);
    await expect(page.getByText(/checked on QoreChain/)).toBeVisible({ timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    await clean(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/page-${name}.png`, animations: "disabled" });
  }
  await ctx.close();
});

test("@aria's owner app", async ({ browser }) => {
  test.setTimeout(600_000);
  if (!existsSync(STATE)) throw new Error("run demo:content first");
  const s = JSON.parse(readFileSync(STATE, "utf8")) as { room: string; pass: string; capsule: string };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await restoreInBrowser(page, personaPhrase("demo-aria"));
  const nav = (label: string) => page.getByRole("link", { name: label }).filter({ visible: true }).first().click();
  const shot = async (file: string) => {
    await page.evaluate(() => document.fonts.ready);
    await clean(page);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${OUT}/${file}.png`, animations: "disabled" });
  };

  // Inbox with the newest item opened on this device.
  await nav("Inbox");
  await page.waitForURL("**/app/inbox**");
  const list = page.getByRole("region", { name: "Inbox list" });
  await expect(list.getByRole("button").first()).toBeVisible({ timeout: 60_000 });
  // The oldest of the three: a visitor with no account, with a contract attached.
  await list
    .getByRole("button", { name: /Sealed · tap to open/ })
    .nth(2)
    .click();
  await expect(page.getByRole("region", { name: "Opened item" }).getByText(/spring packaging/)).toBeVisible({
    timeout: 60_000,
  });
  await shot("app-inbox");

  await nav("Rooms");
  await page.getByRole("link", { name: /Spring launch/ }).click();
  await page.waitForURL(`**/app/rooms/${s.room}`);
  await expect(page.getByRole("article").filter({ hasText: "Photos for the shoot are in Files now." })).toBeVisible({
    timeout: 60_000,
  });
  const dismiss = page.getByRole("button", { name: /Dismiss|Close/ }).first();
  if (await dismiss.isVisible().catch(() => false)) await dismiss.click();
  await shot("app-room");

  await nav("Capsules");
  await page.waitForURL("**/app/capsules");
  await page
    .getByRole("link", { name: /For the family/ })
    .first()
    .click();
  await page.waitForURL(`**/app/capsules/${s.capsule}`);
  await expect(page.getByText(/Set and waiting/).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("button", { name: "I’m here, check in" })).toBeVisible({ timeout: 90_000 });
  await shot("app-capsule");

  await nav("Passes");
  await page.waitForURL("**/app/passes");
  await page.locator(`a[href="/app/passes/${s.pass}"]`).first().click();
  await expect(page.getByRole("heading", { name: "Active" })).toBeVisible({ timeout: 60_000 });
  await shot("app-pass");

  // The editor's Add a block sheet.
  await nav("Blocks");
  await page.waitForURL("**/app");
  // The editor's own Add button (the setup checklist above it has one too).
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  const sheet = page.getByRole("dialog", { name: "Add" });
  await expect(sheet).toBeVisible();
  await page.waitForTimeout(600);
  await clean(page);
  await sheet.screenshot({ path: `${OUT}/app-add-block.png`, animations: "disabled" });
  await ctx.close();
});
