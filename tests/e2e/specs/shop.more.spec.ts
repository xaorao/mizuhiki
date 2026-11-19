/**
 * 5.11 Shop, the other ways to sell, on testnet through the screens:
 * Instant delivery (the helper seals it while the seller's dashboard is
 * closed) bought as a gift for another account, who opens it on their own
 * device; a booked call (the slot is taken for the next buyer) refunded from
 * the Sales list; a commission paid as a deposit and then the rest when the
 * seller asks. Source of truth: the API's order records, the deliverer named
 * on them, and the transfers on QoreChain.
 */
import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { getTx } from "@mizuhiki/chain";
import { personaPhrase } from "@mizuhiki/testnet";
import { API, ensureOwner, restoreInBrowser } from "./owner";

test.use({ actionTimeout: 90_000, navigationTimeout: 90_000 });
const NAME = "mzk-shop-e2e";
const PASS = "lantern river maple tea";

async function party(browser: Browser, problems: string[], tag: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") problems.push(`[${tag}] console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[${tag}] pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    if (!f.includes("ERR_ABORTED")) problems.push(`[${tag}] requestfailed: ${r.url()} ${f}`);
  });
  return { ctx, page };
}
const nav = (page: Page, label: string) => page.getByRole("link", { name: label }).filter({ visible: true }).first().click();
const order = async (ref: string) => (await (await fetch(`${API}/orders/${ref}`)).json()) as { status: string; deliveredBy: string | null; depositTx: string | null; balanceTx: string | null; refundTx: string | null; request: { lines: { slot: string | null }[] } };
const untilStatus = (ref: string, status: string, timeout = 300_000) =>
  expect.poll(async () => (await order(ref)).status, { timeout, intervals: [2000] }).toBe(status);

async function makeProduct(page: Page, kind: RegExp, title: string, price: string, setup?: () => Promise<void>) {
  await nav(page, "Shop");
  await page.getByRole("link", { name: "New product" }).first().click();
  await page.getByLabel("Name").fill(title);
  await page.getByRole("radio", { name: kind }).click();
  await page.getByRole("group", { name: "Token" }).getByRole("button", { name: "QOR" }).click();
  await page.getByLabel(/^(Price|Full price)/).fill(price);
  await page.getByRole("button", { name: "Next: Customize" }).click();
  await page.waitForURL(/\/app\/shop\/pr[0-9a-f]+/, { timeout: 60_000 });
  if (setup) await setup();
  await page.getByRole("button", { name: /^Publish/ }).first().click();
  await expect(page.getByText("Your product is live.")).toBeVisible({ timeout: 120_000 });
  await page.getByRole("tab", { name: "Share" }).click();
  await page.getByRole("button", { name: "Add button" }).click();
  await expect(page.getByText(/Added|on your page/i).first()).toBeVisible({ timeout: 120_000 });
}

/** Open a product from the seller's page and get to checkout. */
async function toCheckout(page: Page, title: string, onProduct?: () => Promise<void>) {
  await page.goto(`/@${NAME}`);
  await page.getByRole("link", { name: new RegExp(title) }).first().click();
  await page.waitForURL(new RegExp(`/@${NAME}/p/`));
  if (onProduct) await onProduct();
  await page.locator("aside[aria-label='Buy']").getByRole("button").filter({ hasText: /I want this!|Book a time/ }).first().click();
  await page.waitForURL(new RegExp(`/@${NAME}/checkout`));
}

/** A full page load locks the account: unlock in place if the page asks, once it has drawn either. */
async function unlockIfAsked(page: Page, ready: ReturnType<Page["getByText"]>) {
  const unlock = page.getByLabel("Device passphrase").first();
  await expect(unlock.or(ready).first()).toBeVisible({ timeout: 90_000 });
  if (await unlock.isVisible()) {
    await unlock.fill(PASS);
    await page.getByRole("button", { name: "Unlock" }).first().click();
  }
}

/** Choose "Pay with my Mizuhiki wallet" in a pay panel, unlocking in place if asked, and pay. */
async function payInPanel(page: Page, panel: ReturnType<Page["locator"]> = page.locator("body")) {
  await panel.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  // A full page load locks the account; the wallet choice offers to unlock right there.
  const unlock = page.getByLabel("Device passphrase").first();
  const pay = panel.getByRole("button", { name: /^Pay \d/ });
  await expect(unlock.or(pay).first()).toBeVisible();
  if (await unlock.isVisible()) {
    await unlock.fill(PASS);
    await page.getByRole("button", { name: "Unlock" }).first().click();
  }
  await expect(pay).toBeEnabled({ timeout: 60_000 });
  await pay.click();
}

/** Pay at checkout with the buyer's own Mizuhiki wallet; returns the order reference. */
async function payWithWallet(page: Page): Promise<string> {
  await payInPanel(page);
  await page.waitForURL(/\/library\/[A-Za-z0-9_-]{22}/, { timeout: 120_000 });
  return /library\/([A-Za-z0-9_-]{22})/.exec(page.url())?.[1] ?? "";
}

test("shop: instant delivery as a gift, a booked call refunded, a commission in two payments", async ({ browser, problems }, info) => {
  test.skip(info.project.name !== "desktop", "a multi-party run");
  test.setTimeout(1_500_000);
  await ensureOwner("shop-e2e-seller", NAME);
  await ensureOwner("shop-e2e-buyer", "mzk-shop-e2e-buyer");
  await ensureOwner("room-cai", "mzk-room-cai");
  const helper = ((await (await fetch(`${API}/shop/helper`)).json()) as { address: string | null }).address;
  expect(helper, "the Instant delivery helper is provisioned").toMatch(/^qor1/);
  const id = Date.now().toString(36);
  const report = `Q3 report ${id}`;
  const call = `Intro call ${id}`;
  const portrait = `Portrait ${id}`;

  // ---- the seller makes three products, then closes the dashboard
  const S = await party(browser, problems, "seller");
  await restoreInBrowser(S.page, personaPhrase("shop-e2e-seller"));
  await makeProduct(S.page, /Report or dataset/, report, "0.02", async () => {
    await S.page.getByRole("radio", { name: /Instant delivery/ }).click();
    await expect(S.page.getByLabel("Helper address")).toHaveValue(helper ?? "");
    await S.page.getByRole("tab", { name: "Content" }).click();
    await S.page.getByLabel("Text").first().fill("The Q3 numbers, sealed to you.");
  });
  await makeProduct(S.page, /Booking or call/, call, "0.02");
  await makeProduct(S.page, /Commission with deposit/, portrait, "0.04", async () => {
    await S.page.getByRole("tab", { name: "Content" }).click();
    await S.page.getByLabel("Text").first().fill("Your finished portrait.");
  });
  await S.ctx.close();

  // ---- a gift: the buyer pays, the helper seals it to Cai at once (no seller device is open)
  const B = await party(browser, problems, "buyer");
  await restoreInBrowser(B.page, personaPhrase("shop-e2e-buyer"));
  await toCheckout(B.page, report);
  await B.page.getByRole("radio", { name: /Send to another wallet/ }).click();
  await B.page.getByLabel("Their @name or wallet address").fill("@mzk-room-cai");
  await B.page.getByRole("button", { name: "Find" }).click();
  await expect(B.page.getByText("@mzk-room-cai").first()).toBeVisible({ timeout: 60_000 });
  const giftRef = await payWithWallet(B.page);
  await untilStatus(giftRef, "delivered", 180_000);
  expect((await order(giftRef)).deliveredBy).toBe(helper);
  await B.page.screenshot({ path: info.outputPath("1-gift-sent.png"), animations: "disabled" });

  const C = await party(browser, problems, "gift-receiver");
  await restoreInBrowser(C.page, personaPhrase("room-cai"));
  await C.page.goto(`/library/${giftRef}`);
  const openedC = C.page.getByText("The Q3 numbers, sealed to you.");
  await unlockIfAsked(C.page, openedC.or(C.page.getByRole("button", { name: "Open it" })));
  await expect(openedC.or(C.page.getByRole("button", { name: "Open it" }))).toBeVisible({ timeout: 90_000 });
  if (!(await openedC.isVisible())) await C.page.getByRole("button", { name: "Open it" }).click();
  await expect(openedC).toBeVisible({ timeout: 60_000 });
  await C.page.screenshot({ path: info.outputPath("2-gift-opened.png"), animations: "disabled" });
  await C.ctx.close();

  // ---- a booked call: the first free time; the next buyer sees it taken
  await toCheckout(B.page, call, async () => {
    await B.page.getByRole("tablist", { name: "Days" }).locator("button[role=tab]:not([disabled])").first().click();
    const first = B.page.getByRole("radiogroup", { name: /^Times on/ }).getByRole("radio").first();
    await first.click();
    await expect(first).toHaveAttribute("aria-checked", "true");
  });
  const callRef = await payWithWallet(B.page);
  await untilStatus(callRef, "paid", 120_000);
  const slot = (await order(callRef)).request.lines[0]?.slot ?? "";
  expect(slot).toMatch(/Z$/);
  const pub = (await (await fetch(`${API}/shop/${NAME}`)).json()) as { products: { record: { body: { title: string; slug: string } } }[] };
  const callSlug = pub.products.find((p) => p.record.body.title === call)?.record.body.slug ?? "";
  expect(((await (await fetch(`${API}/products/${NAME}/${callSlug}`)).json()) as { booked: string[] }).booked).toContain(slot);

  // ---- a commission: the deposit now
  await toCheckout(B.page, portrait);
  const comRef = await payWithWallet(B.page);
  await untilStatus(comRef, "in_progress", 120_000);
  await expect(B.page.getByText(/Deposit paid/).first()).toBeVisible({ timeout: 60_000 });

  // ---- the seller comes back: the call is sealed by their device; they ask for the rest of the commission
  const S2 = await party(browser, problems, "seller-back");
  await restoreInBrowser(S2.page, personaPhrase("shop-e2e-seller"));
  await nav(S2.page, "Shop");
  await S2.page.getByRole("tab", { name: /Sales/ }).click();
  await untilStatus(callRef, "delivered", 180_000);
  const comCard = S2.page.getByRole("listitem").filter({ hasText: portrait });
  await comCard.getByRole("button", { name: /Ask for the rest/ }).click();
  await expect.poll(async () => ((await (await fetch(`${API}/orders/${comRef}`)).json()) as { balanceRequested: boolean }).balanceRequested, { timeout: 60_000 }).toBe(true);

  // ---- the buyer pays the rest; the seller's open dashboard seals it
  await B.page.goto(`/library/${comRef}`);
  const rest = B.page.getByRole("region", { name: "Pay the rest" });
  await expect(rest.getByRole("heading", { name: "Pay the rest" })).toBeVisible({ timeout: 90_000 });
  await payInPanel(B.page, rest);
  await untilStatus(comRef, "delivered", 300_000);
  const com = await order(comRef);
  expect((await getTx(com.balanceTx ?? ""))?.tx?.body?.memo).toBe(`mzk:ord:${comRef}-2`);
  await expect(B.page.getByText("Your finished portrait.")).toBeVisible({ timeout: 120_000 });
  await B.page.screenshot({ path: info.outputPath("3-commission-done.png"), animations: "disabled" });

  // ---- the seller refunds the call from the Sales list; recorded once QoreChain shows it
  const callCard = S2.page.getByRole("listitem").filter({ hasText: call });
  await callCard.getByRole("button", { name: /^Refund$/ }).click();
  const sheet = S2.page.getByRole("dialog", { name: "Refund this order" });
  await sheet.getByLabel(/^Amount in QOR/).fill("0.02");
  await sheet.getByRole("checkbox").check();
  await sheet.getByRole("button", { name: "Send refund" }).click();
  await untilStatus(callRef, "refunded", 180_000);
  const refunded = await order(callRef);
  expect((await getTx(refunded.refundTx ?? ""))?.tx?.body?.memo).toBe(`mzk:ord:${callRef}-r`);
  await S2.page.screenshot({ path: info.outputPath("4-seller-sales.png"), animations: "disabled" });

  for (const x of [B, S2]) await x.ctx.close();
});
