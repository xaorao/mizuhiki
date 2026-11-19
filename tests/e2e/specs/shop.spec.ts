/**
 * 5.11 Shop end to end on testnet, everyone in their own browser context:
 * a seller makes and publishes a digital product with a sealed file and puts
 * it on their page; a buyer with a Mizuhiki account pays with their wallet; a
 * buyer with no account makes a 12-word buyer key and pays by hand from
 * another wallet; the seller's open dashboard seals each copy; each buyer
 * opens the file on their own device and gets the exact bytes. Source of
 * truth: the order and its payment on QoreChain, the API's order record, and
 * the delivery opening only with the buyer's key.
 */
import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { DENOMS, getTx, msgSend, sendTx, waitForTx } from "@mizuhiki/chain";
import { personaPhrase, ensurePersona } from "@mizuhiki/testnet";
import { API, ensureOwner, restoreInBrowser } from "./owner";

// A stuck click should fail with its step named, not wait out the whole test.
test.use({ actionTimeout: 90_000, navigationTimeout: 90_000 });

const FILE = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31) % 251));
const NAME = "mzk-shop-e2e";

async function party(
  browser: Browser,
  problems: string[],
  tag: string,
  viewport = { width: 1440, height: 900 },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport, acceptDownloads: true });
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
const nav = (page: Page, label: string) =>
  page.getByRole("link", { name: label }).filter({ visible: true }).first().click();

async function downloadedBytes(page: Page, click: () => Promise<void>): Promise<Buffer> {
  const dl = page.waitForEvent("download");
  await click();
  const d = await dl;
  return Buffer.concat(await (await d.createReadStream()).toArray());
}

test("shop: publish a sealed product; an account buyer and a 12-word buyer each pay on testnet and open their own copy", async ({
  browser,
  problems,
}, info) => {
  test.skip(info.project.name !== "desktop", "multi-party run; phone layouts are captured inside it");
  test.setTimeout(1_200_000);
  await ensureOwner("shop-e2e-seller", NAME);
  await ensureOwner("shop-e2e-buyer", "mzk-shop-e2e-buyer");
  const payer = await ensurePersona("shop-e2e-payer", { minQor: 3n });
  const title = `Field recordings ${Date.now().toString(36)}`;

  // ---- the seller makes a product: name, kind, price in QOR, a sealed file, publish, put it on the page
  const S = await party(browser, problems, "seller");
  await restoreInBrowser(S.page, personaPhrase("shop-e2e-seller"));
  await nav(S.page, "Shop");
  await S.page.getByRole("link", { name: "New product" }).first().click();
  await S.page.getByLabel("Name").fill(title);
  await S.page.getByRole("radio", { name: /Digital file/ }).click();
  await S.page.getByRole("group", { name: "Token" }).getByRole("button", { name: "QOR" }).click();
  await S.page.getByLabel("Price").fill("0.02");
  await S.page.getByRole("button", { name: "Next: Customize" }).click();
  await S.page.waitForURL(/\/app\/shop\/pr[0-9a-f]+/, { timeout: 60_000 });
  const productId = /shop\/(pr[0-9a-f]+)/.exec(S.page.url())?.[1] ?? "";
  await S.page.getByRole("tab", { name: "Content" }).click();
  await S.page.getByLabel("Text").first().fill("Thank you for buying. The recordings are below.");
  await S.page
    .locator("input[type=file]")
    .last()
    .setInputFiles({ name: "dawn-chorus.wav", mimeType: "audio/wav", buffer: FILE });
  await expect(S.page.getByText("dawn-chorus.wav").first()).toBeVisible({ timeout: 60_000 });
  await S.page
    .getByRole("button", { name: /^Publish/ })
    .first()
    .click();
  await expect(S.page.getByText("Your product is live.")).toBeVisible({ timeout: 120_000 });
  await S.page.getByRole("tab", { name: "Share" }).click();
  await S.page.getByRole("button", { name: "Add button" }).click();
  await expect(S.page.getByText(/Added|on your page/i).first()).toBeVisible({ timeout: 120_000 });
  await S.page.screenshot({ path: info.outputPath("1-seller-share.png"), animations: "disabled" });

  const pub = (await (
    await fetch(
      `${API}/products/${NAME}/${((await (await fetch(`${API}/shop/${NAME}`)).json()) as { products: { record: { body: { id: string; slug: string } } }[] }).products.find((p) => p.record.body.id === productId)?.record.body.slug ?? ""}`,
    )
  ).json()) as { record: { body: { id: string; content: string } } };
  expect(pub.record.body.id).toBe(productId);
  expect(pub.record.body.content).toMatch(/^[0-9a-f]{64}$/);

  // The seller keeps the Sales tab open: their device seals paid orders.
  await nav(S.page, "Shop");
  await S.page.getByRole("tab", { name: /Sales/ }).click();

  // ---- buyer 1: a Mizuhiki account, pays with the Mizuhiki wallet
  const B = await party(browser, problems, "buyer");
  await restoreInBrowser(B.page, personaPhrase("shop-e2e-buyer"));
  await B.page.goto(`/@${NAME}`);
  await B.page
    .getByRole("link", { name: new RegExp(title) })
    .first()
    .click();
  await B.page.waitForURL(new RegExp(`/@${NAME}/p/`));
  await expect(B.page.getByText(/Signed by @mzk-shop-e2e's key, checked on/)).toBeVisible({ timeout: 60_000 });
  await B.page.screenshot({ path: info.outputPath("2-product.png"), animations: "disabled" });
  await B.page
    .getByRole("button", { name: /I want this!/ })
    .first()
    .click();
  await B.page.waitForURL(new RegExp(`/@${NAME}/checkout`));
  const unlock = B.page.getByLabel("Device passphrase");
  await B.page.getByRole("radio", { name: /My Mizuhiki account/ }).click();
  if (await unlock.isVisible().catch(() => false)) {
    await unlock.fill("lantern river maple tea");
    await B.page.getByRole("button", { name: "Unlock" }).click();
  }
  await B.page.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  await B.page.getByRole("button", { name: /^Pay 0\.02 QOR/ }).click();
  await B.page.waitForURL(/\/library\/[A-Za-z0-9_-]{22}/, { timeout: 120_000 });
  const ref1 = /library\/([A-Za-z0-9_-]{22})/.exec(B.page.url())?.[1] ?? "";
  // The seller's open dashboard seals it; wait on the order record, then the page.
  await expect
    .poll(async () => ((await (await fetch(`${API}/orders/${ref1}`)).json()) as { status: string }).status, {
      timeout: 300_000,
      intervals: [2000],
    })
    .toBe("delivered");
  // The page opens the purchase by itself once it is sealed ("Open it" shows only if it was not opened here).
  const openedB = B.page.getByText("Thank you for buying. The recordings are below.");
  await expect(openedB.or(B.page.getByRole("button", { name: "Open it" }))).toBeVisible({ timeout: 90_000 });
  if (!(await openedB.isVisible())) await B.page.getByRole("button", { name: "Open it" }).click();
  // Source of truth: the order is delivered, its payment is on QoreChain with the order memo.
  const o1 = (await (await fetch(`${API}/orders/${ref1}`)).json()) as {
    status: string;
    depositTx: string;
    dueNow: string;
    delivery: string | null;
  };
  expect(o1.status).toBe("delivered");
  const t1 = await getTx(o1.depositTx);
  expect(t1?.tx?.body?.memo).toBe(`mzk:ord:${ref1}`);
  await expect(B.page.getByText("Thank you for buying. The recordings are below.")).toBeVisible({ timeout: 90_000 });
  const got1 = await downloadedBytes(B.page, () =>
    B.page
      .getByRole("button", { name: /Decrypt and download/ })
      .first()
      .click(),
  );
  expect(got1.equals(FILE)).toBe(true);
  await B.page
    .getByRole("radio", { name: /5/ })
    .first()
    .click()
    .catch(() => undefined);
  await B.page.getByLabel("Want to leave a written review?").fill("Lovely recordings.");
  await B.page.getByRole("button", { name: "Post review" }).click();
  // Source of truth: the review is stored as a verified purchase of this order.
  await expect
    .poll(
      async () =>
        (
          (await (await fetch(`${API}/orders/${ref1}/review`)).json()) as {
            reviews: { rating: number; text: string }[];
          }
        ).reviews[0],
      { timeout: 60_000 },
    )
    .toMatchObject({ rating: 5, text: "Lovely recordings." });
  await B.page.screenshot({ path: info.outputPath("3-buyer-opened.png"), animations: "disabled" });

  // ---- buyer 2: no account; a 12-word buyer key; pays by hand from another wallet
  const K = await party(browser, problems, "keybuyer");
  await K.page.goto(`/@${NAME}`);
  await K.page
    .getByRole("link", { name: new RegExp(title) })
    .first()
    .click();
  await K.page
    .getByRole("button", { name: /I want this!/ })
    .first()
    .click();
  await K.page.getByRole("radio", { name: /I don't have Mizuhiki/ }).click();
  const words = (await K.page.getByRole("list", { name: "Your 12 words" }).locator("b").allTextContents()).map((w) =>
    w.trim(),
  );
  expect(words).toHaveLength(12);
  await K.page.getByRole("button", { name: "I saved them" }).click();
  for (const field of await K.page.getByLabel(/^Word \d+$/).all()) {
    const n = Number(
      /Word (\d+)/.exec(
        (await field.getAttribute("aria-label")) ??
          (await field.evaluate((el) => (el as HTMLInputElement).labels?.[0]?.textContent ?? "")),
      )?.[1] ?? 0,
    );
    await field.fill(words[n - 1] ?? "");
  }
  await K.page.getByRole("button", { name: "Use this key" }).click();
  await K.page.getByRole("radio", { name: /Send it myself/ }).click();
  await K.page.screenshot({ path: info.outputPath("4-key-checkout.png"), animations: "disabled", fullPage: true });
  await K.page.getByRole("button", { name: /Continue to pay 0\.02 QOR/ }).click();
  await K.page.waitForURL(/\/library\/[A-Za-z0-9_-]{22}/, { timeout: 60_000 });
  const ref2 = /library\/([A-Za-z0-9_-]{22})/.exec(K.page.url())?.[1] ?? "";
  const o2 = (await (await fetch(`${API}/orders/${ref2}`)).json()) as { payTo: string; memo: string; dueNow: string };
  // The page shows exactly what to send; the payment comes from a wallet that is not the buyer's key.
  await expect(K.page.getByText(o2.memo).first()).toBeVisible();
  const sent = await sendTx(payer, [msgSend(payer.address, o2.payTo, DENOMS.QOR.denom, BigInt(o2.dueNow))], o2.memo);
  await waitForTx(sent.txHash);
  await expect
    .poll(async () => ((await (await fetch(`${API}/orders/${ref2}`)).json()) as { status: string }).status, {
      timeout: 300_000,
      intervals: [2000],
    })
    .toBe("delivered");
  // The page opens the purchase by itself once it is sealed ("Open it" shows only if it was not opened here).
  const openedK = K.page.getByText("Thank you for buying. The recordings are below.");
  await expect(openedK.or(K.page.getByRole("button", { name: "Open it" }))).toBeVisible({ timeout: 90_000 });
  if (!(await openedK.isVisible())) await K.page.getByRole("button", { name: "Open it" }).click();
  await expect(K.page.getByText("Thank you for buying. The recordings are below.")).toBeVisible({ timeout: 90_000 });
  const got2 = await downloadedBytes(K.page, () =>
    K.page
      .getByRole("button", { name: /Decrypt and download/ })
      .first()
      .click(),
  );
  expect(got2.equals(FILE)).toBe(true);
  // The library on this device lists it (found by the buyer key, no account).
  await K.page.goto("/library");
  await expect(K.page.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible({ timeout: 60_000 });

  // ---- a phone: the seller's Sales list and the 12-word buyer opening it on another device
  const P = await party(browser, problems, "keybuyer-phone", { width: 390, height: 844 });
  await P.page.goto("/library");
  await P.page.getByRole("button", { name: /Open with my 12 words/ }).click();
  await P.page.getByLabel("Your buyer key's 12 words").fill(words.join(" "));
  await P.page
    .locator("form")
    .filter({ has: P.page.getByLabel("Your buyer key's 12 words") })
    .locator("button[type=submit]")
    .click();
  await expect(P.page.getByRole("link", { name: new RegExp(title) }).first()).toBeVisible({ timeout: 60_000 });
  await P.page.screenshot({ path: info.outputPath("5-phone-library.png"), animations: "disabled" });

  await S.page.screenshot({ path: info.outputPath("6-seller-sales.png"), animations: "disabled" });
  // The seller on a phone: Shop is under More; products are cards, every order's buyer fits.
  const SP = await party(browser, problems, "seller-phone", { width: 390, height: 844 });
  await restoreInBrowser(SP.page, personaPhrase("shop-e2e-seller"));
  await SP.page
    .getByRole("navigation", { name: "Owner sections" })
    .last()
    .getByRole("button", { name: "More" })
    .click();
  await SP.page.getByRole("dialog", { name: "Everything" }).getByRole("link", { name: "Shop" }).click();
  await expect(SP.page.getByRole("link", { name: title }).first()).toBeVisible({ timeout: 60_000 });
  const [sw, iw] = await SP.page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await SP.page.screenshot({ path: info.outputPath("7-seller-phone-products.png"), animations: "disabled" });
  await SP.page.getByRole("tab", { name: /Sales/ }).click();
  await expect(SP.page.getByText("Delivered").first()).toBeVisible({ timeout: 60_000 });
  await SP.page.screenshot({ path: info.outputPath("8-seller-phone-sales.png"), animations: "disabled" });
  await SP.ctx.close();
  await expect(S.page.getByText(/Sealed to the buyer/).first()).toBeVisible();
  for (const x of [S, B, K, P]) await x.ctx.close();
});
