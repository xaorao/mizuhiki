/**
 * Demo content for @aria, made through the real app the way Aria and her clients would make it: a product in the
 * shop, a client intake form, a file request, a proof, a paid page payment from a client, an invoice to that
 * client, a form answer and an upload. Everything is real: sealed in the browser, signed with Aria's keys, paid
 * on the QoreChain test network. Run after `tsx tools/demo-seed.ts`, against a running stack:
 *
 *   npx playwright test -c tools/demo.config.ts
 */
import { randomBytes } from "node:crypto";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { DENOMS } from "@mizuhiki/chain";
import { ensurePersona, personaPhrase, topUp } from "@mizuhiki/testnet";
import { API, apiToken, restoreInBrowser } from "../specs/owner";

const ARIA = "aria";
const CLIENT_LABEL = "demo-client-leaf";
const CLIENT = "leaf.kettle";

test.describe.configure({ mode: "serial" });
test.setTimeout(900_000);

const open: { close: () => Promise<void> }[] = [];
test.afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function as(browser: Browser, phrase: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  open.push(ctx);
  const page = await ctx.newPage();
  await restoreInBrowser(page, phrase);
  return page;
}

async function nav(page: Page, name: string): Promise<void> {
  await page.getByRole("link", { name }).filter({ visible: true }).first().click();
}

test.beforeAll(async () => {
  await ensurePersona("demo-aria", { name: ARIA, minQor: 4n });
  const client = await ensurePersona(CLIENT_LABEL, { name: CLIENT, minQor: 3n });
  await topUp(client.address, DENOMS.fUSD.denom, 200_000_000n, "demo-client-fusd");
  // The client finished sign-up: their key card is published, so sealed items can reach them.
  const token = await apiToken(client);
  const res = await fetch(`${API}/cards`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ card: client.card }),
  });
  expect(res.ok).toBe(true);
});

test("aria: a product in the shop, on her page", async ({ browser }) => {
  const a = await as(browser, personaPhrase("demo-aria"));
  await nav(a, "Shop");
  await a.getByRole("link", { name: "New product" }).first().click();
  await a.getByLabel("Name").fill("Brand starter kit");
  await a.getByRole("radio", { name: /Digital file/ }).click();
  await a.getByRole("group", { name: "Token" }).getByRole("button", { name: "fUSD" }).click();
  await a.getByLabel("Price").fill("24");
  await a.getByRole("button", { name: "Next: Customise" }).click();
  await a.waitForURL(/\/app\/shop\/pr[0-9a-f]+/, { timeout: 60_000 });
  await a.getByRole("tab", { name: "Content" }).click();
  await a
    .getByLabel("Text")
    .first()
    .fill(
      "Thank you. Inside: logo files, a colour and type sheet, and a one-page brand guide you can hand to a printer.",
    );
  await a
    .locator("input[type=file]")
    .last()
    .setInputFiles({ name: "brand-starter-kit.zip", mimeType: "application/zip", buffer: randomBytes(48_000) });
  await expect(a.getByText("brand-starter-kit.zip").first()).toBeVisible({ timeout: 60_000 });
  await a
    .getByRole("button", { name: /^Publish/ })
    .first()
    .click();
  await expect(a.getByText("Your product is live.")).toBeVisible({ timeout: 120_000 });
  await a.getByRole("tab", { name: "Share" }).click();
  await a.getByRole("button", { name: "Add button" }).click();
  await expect(a.getByText(/Added|on your page/i).first()).toBeVisible({ timeout: 120_000 });
});

test("aria: a client intake form and a file request, both on her page", async ({ browser }) => {
  const a = await as(browser, personaPhrase("demo-aria"));
  await nav(a, "Forms");
  await a.getByRole("button", { name: "New form" }).first().click();
  await a.getByRole("button", { name: /Client intake/ }).click();
  await a.waitForURL(/\/app\/forms\/f[a-z0-9]+/);
  await a.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(a.getByText("Published", { exact: true })).toBeVisible({ timeout: 60_000 });
  await a.getByRole("tab", { name: "Share" }).click();
  await a.getByRole("button", { name: "Add to my page" }).click();
  await expect(a.getByText(/on your page|is on your page|Added/i).first()).toBeVisible({ timeout: 60_000 });

  await nav(a, "File requests");
  await a.waitForURL("**/app/requests");
  await a.getByRole("button", { name: "New request" }).first().click();
  const sheet = a.getByRole("dialog", { name: "New request" });
  await sheet.getByLabel("Title").fill("Signed contract and brand assets");
  await sheet
    .getByLabel("Description (optional)")
    .fill("Your signed contract, your current logo files and any photos you want used.");
  await sheet.getByRole("button", { name: "Create request" }).click();
  const share = a.getByRole("dialog", { name: "Your request is ready" });
  await share.getByRole("button", { name: "Add to my page" }).click();
  await expect(a.getByText("Added to your page and published")).toBeVisible({ timeout: 120_000 });
  await share.getByRole("button", { name: "Done" }).click();
});

test("aria: proves a signed contract existed", async ({ browser }) => {
  const a = await as(browser, personaPhrase("demo-aria"));
  await nav(a, "Proofs");
  await a.waitForURL("**/app/proof");
  await a.locator('input[type="file"]').setInputFiles({
    name: "leaf-kettle-contract-signed.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.concat([Buffer.from("%PDF-1.7\n"), randomBytes(20_000)]),
  });
  const sheet = a.getByRole("dialog", { name: "Prove it existed" });
  await sheet.getByLabel("Private note (optional)").fill("Spring packaging contract, signed by both sides.");
  await sheet.getByRole("button", { name: "Anchor on QoreChain" }).click();
  await expect(sheet.getByText("Anchored. It is on QoreChain now.")).toBeVisible({ timeout: 240_000 });
  await sheet.getByRole("button", { name: "Done" }).click();
});

test("a client pays a deposit from Aria's page, with a sealed note", async ({ browser }) => {
  const v = await as(browser, personaPhrase(CLIENT_LABEL));
  await v.goto(`/@${ARIA}/pay/48`);
  const sheet = v.getByRole("dialog", { name: "Pay Aria" });
  await expect(sheet.getByLabel("Amount")).toHaveValue("48");
  await sheet.getByLabel("Note to Aria (optional)").fill("Deposit for the spring packaging refresh. Excited to start!");
  await sheet.getByRole("button", { name: /Continue · 48 fUSD/ }).click();
  await sheet.getByLabel("Device passphrase").fill("lantern river maple tea");
  await sheet.getByRole("button", { name: "Unlock my wallet" }).click();
  await sheet.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  const review = v.getByRole("dialog", { name: "Review" });
  await review.getByRole("button", { name: "Pay 48 fUSD" }).click();
  await expect(v.getByRole("dialog", { name: "Paid Aria" }).getByText("Paid Aria 48 fUSD.")).toBeVisible({
    timeout: 180_000,
  });
});

test("aria: invoices the client for the remaining work", async ({ browser }) => {
  const a = await as(browser, personaPhrase("demo-aria"));
  await nav(a, "Invoices");
  await a.waitForURL("**/app/invoices");
  await a.getByRole("link", { name: "New invoice" }).first().click();
  await a.getByRole("button", { name: "A Mizuhiki @name" }).click();
  await a.getByLabel("Their @name").fill(CLIENT);
  await a.getByLabel("Their business name (optional)").click();
  await expect(a.getByText(`@${CLIENT} is on Mizuhiki. The invoice is sealed to their key too.`)).toBeVisible();
  await a.getByLabel("Their business name (optional)").fill("Leaf & Kettle Tea");
  await a.getByLabel("Item 1 name").fill("Packaging design, three tins");
  await a.getByLabel("Price (fUSD)").first().fill("120");
  await a.getByRole("button", { name: "Add item" }).click();
  await a.getByLabel("Item 2 name").fill("Print-ready files and proofs");
  await a.getByLabel("Price (fUSD)").nth(1).fill("36");
  await a
    .getByLabel("Message to customer")
    .fill("Thank you for the spring launch work. The deposit of 48 fUSD is already deducted.");
  await a.getByLabel("Discount").fill("48");
  await expect(a.getByText("Draft saved, sealed")).toBeVisible({ timeout: 30_000 });
  await a.getByRole("button", { name: "Send", exact: true }).click();
  const share = a.getByRole("dialog", { name: /Invoice #\d{4} is ready/ });
  await share.getByRole("button", { name: `Send to @${CLIENT}` }).click();
  await expect(share.getByRole("button", { name: "Sent" })).toBeVisible({ timeout: 120_000 });
});
