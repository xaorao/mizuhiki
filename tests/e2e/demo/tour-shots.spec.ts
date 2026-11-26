/**
 * Screens for the proof deck (/tour): every feature driven as a real person would, on the demo accounts, against
 * QoreChain testnet. Aria Kapoor runs a brand studio; Leaf & Kettle Tea is her client. Steps that move money or
 * create records run once (state in var/tour.json), so a rerun retakes the views without paying twice.
 * Writes PNGs to TOUR_PNG_DIR (default var/tour-png); tools/tour-images.mjs turns them into the deck's images.
 * Run: pnpm --filter @mizuhiki/e2e demo:tour (after demo:seed and demo:content).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { personaPhrase } from "@mizuhiki/testnet";
import { test, expect } from "../specs/fixtures";
import { restoreInBrowser } from "../specs/owner";

const ROOT = resolve(import.meta.dirname, "../../..");
const OUT = process.env.TOUR_PNG_DIR ?? resolve(ROOT, "var/tour-png");
const STATE = resolve(ROOT, "var/tour.json");
const DEMO = resolve(ROOT, "var/demo-content.json");
const PASS = "lantern river maple tea";
mkdirSync(OUT, { recursive: true });

type State = Record<string, string | boolean>;
const load = (): State => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : {});
const mark = (k: string, v: string | boolean = true) => {
  const s = load();
  s[k] = v;
  writeFileSync(STATE, JSON.stringify(s, null, 2));
};
const demo = () => JSON.parse(readFileSync(DEMO, "utf8")) as { room: string; pass: string; capsule: string };

const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

async function context(browser: Browser, phone = false): Promise<BrowserContext> {
  const ctx = await browser.newContext({ ...(phone ? PHONE : DESKTOP), reducedMotion: "reduce" });
  // The development build's corner badge is not part of the product.
  await ctx.addInitScript(() => {
    const s = document.createElement("style");
    s.textContent = "nextjs-portal{display:none!important}";
    document.addEventListener("DOMContentLoaded", () => document.head.appendChild(s));
  });
  return ctx;
}
async function as(browser: Browser, label: string): Promise<Page> {
  const page = await (await context(browser)).newPage();
  await restoreInBrowser(page, personaPhrase(label));
  return page;
}
async function shot(page: Page, name: string, target?: Locator) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(700);
  if (target) {
    // A margin around the element, so its own edges and text never touch the frame.
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    if (!box) throw new Error(`${name}: nothing to capture`);
    const m = 28;
    await page.screenshot({
      path: `${OUT}/${name}.png`,
      animations: "disabled",
      fullPage: true,
      clip: {
        x: Math.max(0, box.x - m),
        y: Math.max(0, box.y + (await page.evaluate(() => scrollY)) - m),
        width: box.width + 2 * m,
        height: box.height + 2 * m,
      },
    });
  } else await page.screenshot({ path: `${OUT}/${name}.png`, animations: "disabled" });
}
const nav = (page: Page, label: string) =>
  page.getByRole("link", { name: label }).filter({ visible: true }).first().click();
async function unlockIfAsked(page: Page) {
  const box = page.getByLabel("Device passphrase");
  if (await box.isVisible().catch(() => false)) {
    await box.fill(PASS);
    await page.getByRole("button", { name: /^Unlock/ }).click();
  }
}
/** A full load of the owner app locks the key: wait for the lock screen or the app, and unlock if asked. */
async function ownerReady(page: Page) {
  const box = page.getByLabel("Device passphrase");
  const nav = page.getByRole("navigation", { name: "Owner sections" }).first();
  await expect(box.or(nav).first()).toBeVisible({ timeout: 60_000 });
  if (await box.isVisible()) {
    await box.fill(PASS);
    await page.getByRole("button", { name: "Unlock" }).click();
  }
  await expect(nav).toBeVisible({ timeout: 60_000 });
}
function pdf(title: string): Buffer {
  const text = `BT /F1 18 Tf 72 720 Td (${title}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body);
}

test.describe.configure({ mode: "serial" });
test.use({ actionTimeout: 120_000 });

test("0 aria's client intake form gets its real choices", async ({ browser }) => {
  test.setTimeout(300_000);
  if (load().intakeChoices) return;
  const aria = await as(browser, "demo-aria");
  await nav(aria, "Forms");
  await aria
    .getByRole("link", { name: /Client intake/ })
    .first()
    .click();
  await aria.getByRole("tab", { name: "Build" }).click();
  const block = (n: number) =>
    aria
      .locator("div")
      .filter({ has: aria.getByLabel(`Question ${n} title`) })
      .filter({ has: aria.getByLabel("Choice 1", { exact: true }) })
      .last();
  for (const [n, labels] of [
    [3, ["Brand identity", "Packaging", "Website", "Print and signage"]],
    [4, ["Under $2,000", "$2,000 to $5,000", "$5,000 to $15,000", "Over $15,000"]],
  ] as const) {
    const b = block(n);
    for (const [i, label] of labels.entries()) {
      const box = b.getByLabel(`Choice ${i + 1}`, { exact: true });
      if (!(await box.isVisible().catch(() => false))) await b.getByRole("button", { name: "Add choice" }).click();
      await b.getByLabel(`Choice ${i + 1}`, { exact: true }).fill(label);
    }
  }
  await aria.getByRole("button", { name: /Publish changes/ }).click();
  await expect(aria.getByText("Published", { exact: true }).first()).toBeVisible({ timeout: 120_000 });
  await aria.context().close();
  mark("intakeChoices");
});

test("1 the page", async ({ browser }) => {
  test.setTimeout(300_000);
  for (const phone of [false, true]) {
    const page = await (await context(browser, phone)).newPage();
    await page.goto("/@aria");
    await expect(page.getByText(/checked on QoreChain just now/)).toBeVisible({ timeout: 60_000 });
    await shot(page, phone ? "page-phone" : "page-desktop");
    await page.context().close();
  }
});

test("2 a sealed message", async ({ browser }) => {
  test.setTimeout(600_000);
  if (!load().message) {
    const v = await (await context(browser)).newPage();
    await v.goto("/@aria/message");
    const sheet = v.getByRole("dialog", { name: "Send Aria something private" });
    await sheet
      .getByLabel("Message")
      .fill("Final logo files attached. Could the tea-leaf mark go on the tin lid as well?");
    await sheet
      .locator('input[type="file"]')
      .setInputFiles({ name: "leaf-kettle-logo-final.pdf", mimeType: "application/pdf", buffer: pdf("Logo, final") });
    await expect(sheet.getByText("leaf-kettle-logo-final.pdf")).toBeVisible();
    await shot(v, "message-1-write");
    await sheet.getByRole("button", { name: "Next" }).click();
    await sheet.getByLabel("Your name or how to reach you (optional)").fill("Leaf & Kettle Tea");
    await shot(v, "message-2-who");
    await sheet.getByRole("button", { name: "Seal and send" }).click();
    await expect(v.getByRole("dialog", { name: "Sealed for Aria" })).toBeVisible({ timeout: 180_000 });
    await shot(v, "message-3-sealed");
    await v.context().close();
    mark("message");
  }
  const aria = await as(browser, "demo-aria");
  await nav(aria, "Inbox");
  await aria.waitForURL("**/app/inbox**");
  await aria.getByRole("button", { name: "Messages", exact: true }).click();
  const list = aria.getByRole("region", { name: "Inbox list" });
  // The newest item is the message sent above; it opens on this device.
  await list
    .getByRole("button", { name: /Sealed · tap to open/ })
    .first()
    .click();
  await expect(aria.getByRole("region", { name: "Opened item" }).getByText(/tea-leaf mark/)).toBeVisible({
    timeout: 90_000,
  });
  await shot(aria, "message-4-opened");
  await aria.context().close();
});

test("3 paying with a sealed note", async ({ browser }) => {
  test.setTimeout(600_000);
  if (load().pay) return;
  const v = await as(browser, "demo-client-leaf");
  await v.goto("/@aria/pay");
  const sheet = v.getByRole("dialog", { name: "Pay Aria" });
  await sheet.getByLabel("Amount").fill("12");
  await sheet.getByLabel("Note to Aria (optional)").fill("Rush fee for the print proofs. Thank you!");
  await shot(v, "pay-1-amount");
  await sheet.getByRole("button", { name: /Continue · 12 fUSD/ }).click();
  await unlockIfAsked(v);
  await sheet.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  const review = v.getByRole("dialog", { name: "Review" });
  await expect(review.getByRole("button", { name: "Pay 12 fUSD" })).toBeEnabled({ timeout: 60_000 });
  await expect(review.getByText("Working it out")).toHaveCount(0, { timeout: 60_000 });
  await shot(v, "pay-2-review");
  await review.getByRole("button", { name: "Pay 12 fUSD" }).click();
  await expect(v.getByRole("dialog", { name: "Paid Aria" }).getByText("Paid Aria 12 fUSD.")).toBeVisible({
    timeout: 180_000,
  });
  await shot(v, "pay-3-paid");
  await v.context().close();
  mark("pay");
});

test("4 the shop: buy, the seller's device seals it, the buyer opens it", async ({ browser }) => {
  test.setTimeout(900_000);
  const v = await as(browser, "demo-client-leaf");
  let ref = load().shopRef as string | undefined;
  if (!ref) {
    await v.goto("/@aria?tab=shop");
    await expect(v.getByText("Brand starter kit").first()).toBeVisible({ timeout: 60_000 });
    await shot(v, "shop-1-tab");
    await v
      .getByRole("link", { name: /Brand starter kit/ })
      .first()
      .click();
    await v.waitForURL(/\/@aria\/p\//);
    await expect(v.getByText(/This really is @aria's product, checked on/)).toBeVisible({ timeout: 60_000 });
    await shot(v, "shop-2-product");
    await v
      .locator("aside[aria-label='Buy']")
      .getByRole("button")
      .filter({ hasText: /I want this/ })
      .first()
      .click();
    await v.waitForURL(/\/@aria\/checkout/);
    await v.getByRole("radio", { name: /My Mizuhiki account/ }).click();
    await unlockIfAsked(v);
    await v.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
    await v.getByRole("button", { name: /^Pay 24 fUSD/ }).click();
    await v.waitForURL(/\/library\/[A-Za-z0-9_-]{22}/, { timeout: 180_000 });
    ref = /library\/([A-Za-z0-9_-]{22})/.exec(v.url())?.[1] ?? "";
    mark("shopRef", ref);
    await v.waitForTimeout(1500);
    await shot(v, "shop-4-waiting");
  }
  // The seller's open dashboard seals the key to the buyer.
  const aria = await as(browser, "demo-aria");
  await nav(aria, "Shop");
  await aria.getByRole("tab", { name: /Sales/ }).click();
  await expect
    .poll(
      async () => ((await (await fetch(`http://127.0.0.1:4000/orders/${ref}`)).json()) as { status: string }).status,
      { timeout: 300_000, intervals: [3000] },
    )
    .toBe("delivered");
  await aria.reload();
  await ownerReady(aria);
  await aria.getByRole("tab", { name: /Sales/ }).click();
  await expect(aria.getByText("@leaf.kettle").first()).toBeVisible({ timeout: 60_000 });
  await shot(aria, "shop-5-sales");
  await aria.context().close();
  await v.goto(`/library/${ref}`);
  const opened = v.getByText(/logo files, a colour and type sheet/);
  const open = v.getByRole("button", { name: "Open it" });
  const box = v.getByLabel("Device passphrase");
  await expect(opened.or(open).or(box).first()).toBeVisible({ timeout: 120_000 });
  if (await box.isVisible()) {
    await box.fill(PASS);
    await v.getByRole("button", { name: "Unlock" }).click();
  }
  await expect(opened.or(open).first()).toBeVisible({ timeout: 120_000 });
  if (await open.isVisible()) await open.click();
  await expect(opened).toBeVisible({ timeout: 90_000 });
  await shot(v, "shop-6-opened");
  // The checkout as a buyer sees it before paying, with the network fee worked out. Nothing is bought here.
  await v.goto("/@aria/p/brand-starter-kit");
  await v
    .locator("aside[aria-label='Buy']")
    .getByRole("button")
    .filter({ hasText: /I want this/ })
    .first()
    .click();
  await v.waitForURL(/\/@aria\/checkout/);
  await v.getByRole("radio", { name: /My Mizuhiki account/ }).click();
  await unlockIfAsked(v);
  await v.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  const fee = v.getByText(/^About [\d.]+ QOR, paid by you$/);
  await expect(fee).toBeVisible({ timeout: 90_000 });
  // A taller window, so the order, who opens it and the payment are on one screen.
  await v.setViewportSize({ width: 1440, height: 1560 });
  await v.evaluate(() => window.scrollTo(0, 0));
  await shot(v, "shop-3-checkout");
  await v.context().close();
});

test("5 an invoice: sent sealed, paid from the inbox, marked paid from the chain", async ({ browser }) => {
  test.setTimeout(900_000);
  const aria = await as(browser, "demo-aria");
  await nav(aria, "Invoices");
  await aria.waitForURL("**/app/invoices");
  await expect(aria.getByRole("row", { name: /Leaf & Kettle Tea/ }).first()).toBeVisible({ timeout: 60_000 });
  if (!load().invoice) await shot(aria, "invoice-1-list");
  if (!load().invoice) {
    const v = await as(browser, "demo-client-leaf");
    await nav(v, "Inbox");
    await v
      .getByRole("region", { name: "Inbox list" })
      .getByRole("button", { name: /Invoice.*@aria/ })
      .first()
      .click();
    const item = v.getByRole("region", { name: "Opened item" });
    await expect(item.getByText("Verified: @aria")).toBeVisible({ timeout: 60_000 });
    await shot(v, "invoice-2-inbox");
    await item.getByRole("link", { name: "Open the invoice" }).click();
    await expect(v.getByText("This invoice really is from @aria, checked on QoreChain just now")).toBeVisible({
      timeout: 60_000,
    });
    await shot(v, "invoice-3-invoice");
    await v.getByRole("button", { name: /^Pay #\d{4}$/ }).click();
    const sheet = v.getByRole("dialog", { name: /Pay invoice #\d{4}/ });
    await sheet.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
    await unlockIfAsked(v);
    const review = v.getByRole("dialog", { name: "Review" });
    await review.getByRole("button", { name: /^Pay 108 fUSD/ }).click();
    await expect(v.getByRole("dialog", { name: "Paid Aria" }).getByText("Paid Aria 108 fUSD.")).toBeVisible({
      timeout: 180_000,
    });
    await shot(v, "invoice-4-paid");
    await v.context().close();
    mark("invoice");
  }
  await expect(
    aria
      .getByRole("row", { name: /Leaf & Kettle Tea/ })
      .first()
      .getByText("Paid", { exact: true }),
  ).toBeVisible({ timeout: 180_000 });
  await shot(aria, "invoice-5-paid");
  await aria.context().close();
});

test("6 a form and a file request from the page", async ({ browser }) => {
  test.setTimeout(900_000);
  const v = await (await context(browser)).newPage();
  if (!load().form) {
    await v.goto("/@aria");
    await v
      .getByRole("button", { name: /Client intake/ })
      .first()
      .click();
    await v.getByRole("button", { name: "Start" }).click();
    await shot(v, "form-1-question");
    // Answer every question the template asks, as a client would, until the form is sent.
    const answers = [
      "Leaf & Kettle Tea",
      "hello@leafkettle.co",
      "A spring packaging refresh for three tea tins, with the leaf mark on every lid.",
      "https://leafkettle.co",
    ];
    for (let i = 0; i < 25; i++) {
      if (await v.getByText("Your answers are sealed and stored", { exact: false }).isVisible()) break;
      const submit = v.getByRole("button", { name: "Submit" });
      const box = v
        .locator(
          "input[type=text]:visible, input[type=email]:visible, input[type=url]:visible, input[type=tel]:visible, input[type=date]:visible, input[type=number]:visible, textarea:visible",
        )
        .first();
      const choice = v.getByRole("radio").or(v.getByRole("checkbox")).filter({ visible: true }).first();
      if (await box.isVisible().catch(() => false)) {
        const type = await box.getAttribute("type");
        await box.fill(
          type === "email"
            ? "hello@leafkettle.co"
            : type === "url"
              ? "https://leafkettle.co"
              : type === "tel"
                ? "+44 20 7946 0000"
                : type === "date"
                  ? new Date(Date.now() + 42 * 86_400_000).toISOString().slice(0, 10)
                  : type === "number"
                    ? "1500"
                    : (answers.shift() ?? "Thank you."),
        );
      } else if (await choice.isVisible().catch(() => false)) await choice.click();
      if (i === 2) await shot(v, "form-2-answer");
      if (await submit.isVisible().catch(() => false)) {
        await submit.click();
        break;
      } else await v.getByRole("button", { name: /^OK/ }).filter({ visible: true }).first().click();
      await v.waitForTimeout(500);
    }
    await expect(v.getByText("Your answers are sealed and stored", { exact: false })).toBeVisible({ timeout: 120_000 });
    await shot(v, "form-3-sent");
    mark("form");
  }
  // The first questions as a client sees them, with the real choices. Nothing is submitted here.
  await v.goto("/@aria");
  await v
    .getByRole("button", { name: /Client intake/ })
    .first()
    .click();
  await v.getByRole("button", { name: "Start" }).click();
  await v.getByRole("textbox", { name: "What's your name?" }).fill("Leaf & Kettle Tea");
  await shot(v, "form-1-question");
  await v.getByRole("button", { name: /^OK/ }).filter({ visible: true }).first().click();
  await v.getByRole("textbox", { name: "Company" }).fill("Leaf & Kettle Tea Co.");
  await v.getByRole("button", { name: /^OK/ }).filter({ visible: true }).first().click();
  await v.getByRole("checkbox", { name: /Packaging/ }).click();
  await v.getByRole("checkbox", { name: /Print and signage/ }).click();
  await shot(v, "form-2-answer");
  if (!load().request) {
    await v.goto("/@aria");
    await v
      .getByRole("button", { name: /Signed contract and brand assets/ })
      .first()
      .click();
    await v.getByLabel("Choose files to upload").setInputFiles([
      { name: "contract-signed.pdf", mimeType: "application/pdf", buffer: pdf("Contract, signed") },
      { name: "brand-photos.pdf", mimeType: "application/pdf", buffer: pdf("Brand photos") },
    ]);
    const sheet = v.getByRole("dialog", { name: /Upload files for/ });
    await sheet.getByRole("button", { name: "Next" }).click();
    await sheet.getByLabel("Your name").fill("Leaf & Kettle Tea");
    await shot(v, "request-1-upload");
    await sheet.getByRole("button", { name: "Seal and send" }).click();
    await expect(v.getByRole("dialog", { name: /Sealed for/ })).toBeVisible({ timeout: 180_000 });
    await shot(v, "request-2-sealed");
    mark("request");
  }
  await v.context().close();
  const aria = await as(browser, "demo-aria");
  await nav(aria, "Forms");
  await aria
    .getByRole("link", { name: /Client intake/ })
    .first()
    .click();
  await aria.getByRole("tab", { name: "Results" }).click();
  await expect(aria.getByText("Leaf & Kettle Tea").first()).toBeVisible({ timeout: 90_000 });
  await aria.waitForTimeout(2500);
  await shot(aria, "form-4-results");
  await nav(aria, "File requests");
  await aria.waitForURL("**/app/requests");
  await aria.getByText("Signed contract and brand assets").first().click();
  await expect(aria.getByText("contract-signed.pdf").first()).toBeVisible({ timeout: 90_000 });
  await shot(aria, "request-3-received");
  await aria.context().close();
});

test("7 rooms, passes and capsules", async ({ browser }) => {
  test.setTimeout(600_000);
  const s = demo();
  const aria = await as(browser, "demo-aria");
  await nav(aria, "Rooms");
  await aria.getByRole("link", { name: /Spring launch/ }).click();
  await aria.waitForURL(`**/app/rooms/${s.room}`);
  await expect(aria.getByRole("article").filter({ hasText: "Photos for the shoot are in Files now." })).toBeVisible({
    timeout: 90_000,
  });
  await shot(aria, "room-1-chat");
  await nav(aria, "Passes");
  await aria.locator(`a[href="/app/passes/${s.pass}"]`).first().click();
  await expect(aria.getByText(/@mila\.cpa/).first()).toBeVisible({ timeout: 60_000 });
  await shot(aria, "pass-1-detail");
  await nav(aria, "Capsules");
  await aria.locator(`a[href="/app/capsules/${s.capsule}"]`).first().click();
  await expect(aria.getByText("For the family").first()).toBeVisible({ timeout: 60_000 });
  await expect(aria.getByText("Confirm your plan")).toBeVisible({ timeout: 60_000 });
  await aria.waitForTimeout(4000);
  await shot(aria, "capsule-1-detail");
  await aria.context().close();
  const mila = await as(browser, "demo-mila");
  await nav(mila, "Passes");
  await mila.getByRole("tab", { name: /Shared with me/ }).click();
  await mila.locator(`a[href="/app/passes/${s.pass}"]`).click();
  await expect(mila.getByText(/@aria/).first()).toBeVisible({ timeout: 60_000 });
  await shot(mila, "pass-2-accountant");
  await mila.context().close();
  const rohan = await as(browser, "demo-rohan");
  await rohan.goto("/app/capsules?tab=guard");
  await ownerReady(rohan);
  await expect(rohan.getByText(/From @aria/).first()).toBeVisible({ timeout: 60_000 });
  await shot(rohan, "capsule-2-guardian");
  await rohan.context().close();
});

test("8 proofs, the owner app and the spare key", async ({ browser }) => {
  test.setTimeout(600_000);
  const aria = await as(browser, "demo-aria");
  await aria.waitForTimeout(1500);
  await shot(aria, "app-1-blocks");
  for (const [label, url, name] of [
    ["Design", "**/app/design", "app-2-design"],
    ["Insights", "**/app/insights", "app-3-insights"],
    ["Proofs", "**/app/proof", "proof-1-list"],
  ] as const) {
    await nav(aria, label);
    await aria.waitForURL(url);
    await aria.waitForTimeout(2500);
    await shot(aria, name);
  }
  await aria.goto("/app/spare-key");
  await ownerReady(aria);
  // Aria saves her spare-key sheet here, as the page asks; the first item ticks.
  const sheetButton = aria.getByRole("button", { name: /Download the sheet|Download it again/ });
  await expect(sheetButton).toBeVisible({ timeout: 60_000 });
  if ((await sheetButton.innerText()).includes("Download the sheet")) {
    await sheetButton.click();
    await aria.getByLabel("Device passphrase").fill(PASS);
    const download = aria.waitForEvent("download");
    await aria.getByRole("button", { name: "Make the sheet" }).click();
    await (await download).delete();
  }
  await expect(aria.getByText(/^Saved \d/)).toBeVisible({ timeout: 60_000 });
  await aria.evaluate(() => window.scrollTo(0, 0));
  await aria.waitForTimeout(1200);
  await shot(aria, "app-4-spare-key");
  await aria.context().close();
  const v = await (await context(browser)).newPage();
  await v.goto("/recover");
  await shot(v, "recover-1");
  await v.goto("/proof");
  await shot(v, "proof-2-check");
  await v.context().close();
});

test("9 sign-up, with no faucet", async ({ browser }) => {
  test.setTimeout(900_000);
  if (load().signup) return;
  const page = await (await context(browser)).newPage();
  const name = process.env.TOUR_SIGNUP_NAME ?? "hana.flowers";
  await page.goto(`/signup?name=${name}`);
  await expect(page.getByText("It's available")).toBeVisible({ timeout: 60_000 });
  await shot(page, "signup-1-name");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Business/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Kinari/ }).click();
  await shot(page, "signup-2-look");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Display name").fill("Hana Blooms");
  await page.getByLabel("Bio").fill("Wedding flowers in Bristol. Send your brief and deposit here, sealed.");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Create your key" })).toBeVisible();
  // These are a real account's recovery words; the published screen shows that they are there, not what they are.
  await page.addStyleTag({ content: "ol[aria-label='Your 24 recovery words'] b { filter: blur(7px) }" });
  await shot(page, "signup-3-key");
  const words = await page.locator("ol[aria-label='Your 24 recovery words'] b").allInnerTexts();
  const sheet = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save my spare-key sheet" }).click();
  await (await sheet).delete();
  await page.getByRole("button", { name: "I saved it" }).click();
  const labels = await page
    .getByLabel(/^Word \d+$/)
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).labels?.[0]?.textContent ?? ""));
  for (const l of labels) await page.getByLabel(l, { exact: true }).fill(words[Number(l.split(" ")[1]) - 1] ?? "");
  await page.getByRole("button", { name: "Check" }).click();
  await page.getByLabel("Device passphrase").fill(PASS);
  await page.getByLabel("Type it again").fill(PASS);
  await page.getByRole("button", { name: "Lock and continue" }).click();
  await expect(page.getByText(/^Mizuhiki sent you 0\.2 test QOR/)).toBeVisible({ timeout: 180_000 });
  await shot(page, "signup-4-onchain");
  await expect(page.getByRole("heading", { name: "Your page is live" })).toBeVisible({ timeout: 300_000 });
  await shot(page, "signup-5-live");
  await page.context().close();
  mark("signup", name);
});

test("10 on chain: keys, contracts and the Q-Day Drill", async ({ browser }) => {
  test.setTimeout(600_000);
  const page = await (await context(browser)).newPage();
  await page.goto("/onchain");
  await expect(page.getByText("Verified in your browser").first()).toBeVisible({ timeout: 120_000 });
  await page.waitForTimeout(4000);
  const section = (re: RegExp) =>
    page
      .locator("section")
      .filter({ has: page.getByRole("heading", { name: re }) })
      .first();
  await shot(page, "chain-1-contracts", section(/^Our contracts$/));
  await shot(page, "chain-2-keys", section(/keys of @aria/i));
  await shot(page, "chain-3-signatures", section(/Signatures you can check yourself/));
  await shot(page, "chain-4-drill", section(/A stolen classical key cannot act/));
  await page.context().close();
});
