/**
 * The README's "Try it in two minutes", step by step, exactly as a stranger would follow it: so the guide a judge
 * reads first can never drift from what the product does. Each step is timed; the whole path must stay short.
 */
import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

const PASS = "lantern river maple tea";

async function sendSealed(page: Page, name: string, first: string, text: string) {
  await page.goto(`/@${name}`);
  await expect(
    page.getByText(new RegExp(`This page really is @${name.replace(".", "\\.")}'s, checked on QoreChain`)),
  ).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "Message" }).first().click();
  const sheet = page.getByRole("dialog", { name: `Send ${first} something private` });
  await sheet.getByRole("button", { name: "Next" }).click();
  await sheet.getByLabel("Message").fill(text);
  await sheet.locator('input[type="file"]').setInputFiles({
    name: "brief.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("The brief for the spring launch."),
  });
  await sheet.getByRole("button", { name: "Next" }).click();
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  await expect(page.getByRole("dialog", { name: `Sealed for ${first}` })).toBeVisible({ timeout: 120_000 });
}

test("the README's two-minute judge path, followed as a stranger", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(600_000);
  const started = Date.now();
  const lap: Record<string, number> = {};
  const mark = (k: string) => (lap[k] = Math.round((Date.now() - started) / 1000));
  const visitor = await (await browser.newContext()).newPage();

  // 1. A real page checks itself against QoreChain before it lets you send anything.
  // 2. Send it something sealed: the receipt says what was sealed and that the server cannot read it.
  await sendSealed(visitor, "aria", "Aria", `Hello from a judge. ${Date.now()}`);
  await visitor.screenshot({ path: info.outputPath("1-sealed-for-aria.png") });
  mark("sealed to @aria");

  // 3. The proof, read live from the chain by your browser.
  await visitor.goto("/onchain");
  await expect(visitor.getByText("Verified in your browser").first()).toBeVisible({ timeout: 120_000 });
  await expect(
    visitor.getByRole("region", { name: "A stolen classical key cannot act" }).getByText(/Refused by the contract/),
  ).toHaveCount(2, { timeout: 90_000 });
  mark("proof page");

  // 4. Your own page: no faucet, the starter test QOR arrives by itself.
  const owner = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const name = `judge${Date.now().toString(36)}`;
  await owner.goto(`/signup?name=${name}`);
  await expect(owner.getByText("It's available")).toBeVisible({ timeout: 30_000 });
  await owner.getByRole("button", { name: "Continue" }).click();
  await owner.getByRole("radio", { name: /Business/ }).click();
  await owner.getByRole("button", { name: "Continue" }).click();
  await owner.getByRole("radio", { name: /Washi/ }).click();
  await owner.getByRole("button", { name: "Continue" }).click();
  await owner.getByRole("button", { name: "Continue" }).click();
  await owner.getByLabel("Display name").fill("Judge Studio");
  await owner.getByRole("button", { name: "Continue" }).click();
  const words = owner.locator("ol[aria-label='Your 24 recovery words'] b");
  await expect(words).toHaveCount(24);
  const list = await words.allInnerTexts();
  const sheet = owner.waitForEvent("download");
  await owner.getByRole("button", { name: "Save my spare-key sheet" }).click();
  await sheet;
  await owner.getByRole("button", { name: "I saved it" }).click();
  const labels = await owner
    .getByLabel(/^Word \d+$/)
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).labels?.[0]?.textContent ?? ""));
  for (const l of labels)
    await owner.getByLabel(l, { exact: true }).fill(list[Number(l.replace("Word ", "")) - 1] ?? "");
  await owner.getByRole("button", { name: "Check" }).click();
  await owner.getByLabel("Device passphrase").fill(PASS);
  await owner.getByLabel("Type it again").fill(PASS);
  await owner.getByRole("button", { name: "Lock and continue" }).click();
  // Nothing funds this account but the starter grant: reaching a live page proves it arrived.
  await expect(owner.getByRole("heading", { name: "Your page is live" })).toBeVisible({ timeout: 300_000 });
  await owner.screenshot({ path: info.outputPath("4-live.png") });
  mark("own page live");

  // 5. Send yourself something from another window, and open it: only your device can.
  const secret = `Only you can read this. ${Date.now()}`;
  await sendSealed(visitor, name, "Judge", secret);
  await owner.getByRole("button", { name: "Open dashboard" }).click();
  await owner.getByRole("link", { name: /Inbox/ }).first().click();
  await owner
    .getByRole("region", { name: "Inbox list" })
    .getByRole("button", { name: /Sealed · tap to open on this device/ })
    .first()
    .click();
  await expect(owner.getByRole("region", { name: "Opened item" }).getByText(secret)).toBeVisible({ timeout: 60_000 });
  await owner.screenshot({ path: info.outputPath("5-opened.png") });
  mark("opened on own device");

  console.log("judge path laps (seconds from start):", JSON.stringify(lap));
});
