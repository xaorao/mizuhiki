/**
 * 5.5 Pay me, on testnet, each payer in their own browser context:
 * - a Mizuhiki account pays fUSD from a deep link (/pay/2.5, the path amount wins),
 *   unlocking in the sheet, with a sealed note readable by owner and payer;
 * - a QoreX user (the official QoreX wallet mock, signing for real) pays QOR;
 *   a rejection in the wallet moves no money;
 * - a manual payer copies address and memo; an outside wallet pays; the page notices;
 * - blocked states: nothing entered, more than the balance.
 * Source of truth: the committed transaction (memo, amount, recipient), the
 * owner's index linking payment and note, and the note opened with each key.
 */
import { createQorexMock } from "@qorechain/qorex-wallet-mock";
import { test, expect } from "./fixtures";
import { DENOMS, getTx, msgSend, sendTx } from "@mizuhiki/chain";
import { Purpose, fromUtf8, openItem, parseMemo } from "@mizuhiki/core";
import { devWallet, personaPhrase, topUp } from "@mizuhiki/testnet";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-editor";
const VISITOR = "mzk-e2e-visitor";

interface IndexRow {
  id: string;
  kind: string;
  envelope: string | null;
  noteMissing?: boolean;
  payment: { txHash: string; denom: string; amount: string; memo: string } | null;
  sender: { address: string } | null;
}

async function ownerIndex(token: string): Promise<IndexRow[]> {
  const r = await fetch(`${API}/owner/inbox`, { headers: { authorization: `Bearer ${token}` } });
  return ((await r.json()) as { rows: IndexRow[] }).rows;
}
async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(`${API}${path}`)).arrayBuffer());
}
function txOf(text: string): string {
  return (text.match(/([0-9A-F]{8} ?){8}/i)?.[0] ?? "").replace(/ /g, "");
}

test("pay: Mizuhiki wallet from a deep link, fUSD, sealed note for both; owner sees it linked", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "on-chain flow runs once");
  test.setTimeout(420_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  const visitor = await ensureOwner("e2e-visitor", VISITOR);
  await topUp(visitor.address, DENOMS.fUSD.denom, 10_000_000n, "e2e-visitor-fusd");
  const note = `Deposit for the spring launch. ${Date.now()}`;

  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  await restoreInBrowser(v, visitor.phrase);
  await v.goto(`/@${OWNER}/pay/2.5`);
  const sheet = v.getByRole("dialog", { name: "Pay Kinari" });
  await expect(sheet.getByLabel("Amount")).toHaveValue("2.5");
  await expect(sheet.getByText("@mzk-e2e-editor")).toBeVisible();
  await expect(sheet.getByText("The amount and addresses are public on chain.")).toBeVisible();
  await sheet.getByLabel("Note to Kinari (optional)").fill(note);
  await sheet.getByRole("button", { name: /Continue · 2\.5 fUSD/ }).click();
  // the page load locked the account: unlock in the sheet, then pay with the Mizuhiki wallet
  await sheet.getByLabel("Device passphrase").fill("lantern river maple tea");
  await sheet.getByRole("button", { name: "Unlock my wallet" }).click();
  await expect(sheet.getByText("Signed here with your keys. Your note can be read by you too.")).toBeVisible();
  // more than the balance is blocked on review
  await sheet.getByRole("button", { name: "Back" }).click();
  await sheet.getByLabel("Amount").fill("999999");
  await sheet.getByRole("button", { name: /Continue/ }).click();
  await sheet.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  const tooMuch = v.getByRole("dialog", { name: "Review" });
  await expect(
    tooMuch.getByText(/Your Mizuhiki wallet has [\d.]+ fUSD\. Add funds or pay another way\. Nothing was sent\./),
  ).toBeVisible({ timeout: 30_000 });
  await expect(tooMuch.getByRole("button", { name: /^Pay 999999/ })).toBeDisabled();
  await tooMuch.getByRole("button", { name: "Back" }).click();
  await sheet.getByRole("button", { name: "Back" }).click();
  await sheet.getByLabel("Amount").fill("2.5");
  await sheet.getByRole("button", { name: /Continue · 2\.5 fUSD/ }).click();
  await sheet.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  const review = v.getByRole("dialog", { name: "Review" });
  await expect(review.getByText(/^0\.\d+ QOR$/)).toBeVisible({ timeout: 30_000 });
  await expect(review.getByText(owner.address)).toBeVisible();
  await expect(review.getByText("Sealed · Kinari and you")).toBeVisible();
  await v.screenshot({ path: info.outputPath("review.png") });
  await review.getByRole("button", { name: "Pay 2.5 fUSD" }).click();
  const done = v.getByRole("dialog", { name: "Paid Kinari" });
  await expect(done.getByText("Paid Kinari 2.5 fUSD.")).toBeVisible({ timeout: 180_000 });
  await expect(done.getByText("Sealed and delivered")).toBeVisible();
  await v.screenshot({ path: info.outputPath("paid.png") });
  const txHash = txOf(await done.innerText());
  expect(txHash).toMatch(/^[0-9A-F]{64}$/i);

  // Source of truth: the chain transaction.
  const tx = await getTx(txHash);
  expect(tx?.code).toBe(0);
  const body = (
    tx as unknown as {
      tx: {
        body: {
          memo: string;
          messages: { to_address: string; from_address: string; amount: { denom: string; amount: string }[] }[];
        };
      };
    }
  ).tx.body;
  expect(body.messages[0]).toMatchObject({
    from_address: visitor.address,
    to_address: owner.address,
    amount: [{ denom: DENOMS.fUSD.denom, amount: "2500000" }],
  });
  const memo = parseMemo(body.memo);
  expect(memo?.kind).toBe("pay");
  expect(memo?.noteHash).toMatch(/^[0-9a-f]{64}$/);

  // The note opens with the owner's key and with the payer's key; it names the amount and ref.
  const env = await bytes(`/blobs/${memo?.noteHash ?? ""}`);
  for (const keys of [owner.seal, visitor.seal]) {
    const n = JSON.parse(fromUtf8(openItem({ purpose: Purpose.payNote, envelope: env, keys }))) as {
      note: string;
      ref: string;
      amount: string;
      from: string;
    };
    expect(n).toMatchObject({ note, ref: memo?.ref, amount: "2.5", from: visitor.address });
  }

  // The owner's index links payment and note once the indexer has the transaction.
  const token = await apiToken(owner);
  await expect
    .poll(async () => (await ownerIndex(token)).find((r) => r.payment?.txHash === txHash)?.envelope, {
      timeout: 90_000,
    })
    .toBe(memo?.noteHash);
  // and the note is shown inside the payment row, not twice
  expect((await ownerIndex(token)).filter((r) => r.envelope === memo?.noteHash)).toHaveLength(1);

  // The owner opens it in the inbox.
  const octx = await browser.newContext();
  const o = await octx.newPage();
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: /Inbox/ }).first().click();
  await o
    .getByRole("region", { name: "Inbox list" })
    .getByRole("button", { name: /Payment.*2\.5 fUSD/ })
    .first()
    .click();
  const d = o.getByRole("region", { name: "Opened item" });
  await expect(d.getByText(note)).toBeVisible({ timeout: 30_000 });
  await expect(d.getByText("Settled on QoreChain")).toBeVisible();
  await o.screenshot({ path: info.outputPath("owner-payment.png") });
  await ctx.close();
  await octx.close();
});

test("pay: QoreX (wallet mock, real signing) pays QOR; a rejection moves nothing", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "on-chain flow runs once");
  test.setTimeout(420_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  const mock = createQorexMock({ mnemonic: personaPhrase("e2e-qorex"), rest: `${API}/chain` });
  const payer = mock.addresses().native;
  await topUp(payer, DENOMS.QOR.denom, 3_000_000n, "e2e-qorex");

  const ctx = await browser.newContext();
  await ctx.addInitScript({ content: mock.initScript() });
  const p = await ctx.newPage();
  await p.goto(`/@${OWNER}`);
  await p.getByRole("button", { name: /Pay Kinari/ }).click();
  const sheet = p.getByRole("dialog", { name: "Pay Kinari" });
  await sheet.getByLabel("Amount").fill("0.25");
  await sheet.getByRole("button", { name: "QOR (test)" }).click();
  await sheet.getByLabel("Note to Kinari (optional)").fill("For the sticker pack");
  await expect(sheet.getByText("Only Kinari can read this.")).toBeVisible();
  await sheet.getByRole("button", { name: /Continue · 0\.25 QOR/ }).click();
  await sheet.getByRole("radio", { name: /Pay with QoreX/ }).click();
  const review = p.getByRole("dialog", { name: "Review" });
  await expect(review.getByText("QoreX shows it before you approve")).toBeVisible();

  // Rejected in the wallet: no money moved.
  await p.evaluate(() => (window as unknown as { __qorexMock: { rejectNext(): void } }).__qorexMock.rejectNext());
  await review.getByRole("button", { name: "Pay 0.25 QOR" }).click();
  await expect(p.getByText("Not paid. No money moved.")).toBeVisible({ timeout: 60_000 });
  await p.getByRole("button", { name: "Back to review" }).click();

  await p.getByRole("dialog", { name: "Review" }).getByRole("button", { name: "Pay 0.25 QOR" }).click();
  const done = p.getByRole("dialog", { name: "Paid Kinari" });
  await expect(done.getByText("Paid Kinari 0.25 QOR.")).toBeVisible({ timeout: 180_000 });
  const txHash = txOf(await done.innerText());
  const tx = await getTx(txHash);
  expect(tx?.code).toBe(0);
  const body = (
    tx as unknown as {
      tx: {
        body: {
          memo: string;
          messages: { from_address: string; to_address: string; amount: { denom: string; amount: string }[] }[];
        };
      };
    }
  ).tx.body;
  expect(body.messages[0]).toMatchObject({
    from_address: payer,
    to_address: owner.address,
    amount: [{ denom: "uqor", amount: "250000" }],
  });
  const memo = parseMemo(body.memo);
  const env = await bytes(`/blobs/${memo?.noteHash ?? ""}`);
  expect(
    JSON.parse(fromUtf8(openItem({ purpose: Purpose.payNote, envelope: env, keys: owner.seal }))) as { note: string },
  ).toMatchObject({ note: "For the sticker pack" });
  await p.screenshot({ path: info.outputPath("qorex-paid.png") });
  await ctx.close();
});

test("pay: manual payment with address and memo; the page notices the payment", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "on-chain flow runs once");
  test.setTimeout(420_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  const ctx = await browser.newContext();
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const p = await ctx.newPage();
  await p.goto(`/@${OWNER}/pay`);
  const sheet = p.getByRole("dialog", { name: "Pay Kinari" });
  await expect(sheet.getByRole("button", { name: "Enter an amount" })).toBeDisabled();
  await sheet.getByLabel("Amount").fill("0.1");
  await sheet.getByRole("button", { name: "QOR (test)" }).click();
  await sheet.getByLabel("Note to Kinari (optional)").fill("Paid from my exchange wallet");
  await sheet.getByRole("button", { name: /Continue/ }).click();
  await sheet.getByRole("radio", { name: /Copy address and reference/ }).click();
  const review = p.getByRole("dialog", { name: "Review" });
  const memoText = (await review.innerText()).match(/mzk:pay:[a-z0-9]+:[0-9a-f]{64}/)?.[0] ?? "";
  expect(parseMemo(memoText)?.noteHash).toMatch(/^[0-9a-f]{64}$/);
  await review.getByRole("button", { name: "I've sent it" }).click();
  await expect(p.getByText(/Waiting for 0\.1 QOR with reference/)).toBeVisible();
  // the note is delivered up front for manual payments
  await expect.poll(async () => (await fetch(`${API}/blobs/${parseMemo(memoText)?.noteHash ?? ""}`)).status).toBe(200);
  // an outside wallet pays with that memo
  const dev = devWallet();
  const sent = await sendTx(dev, [msgSend(dev.address, owner.address, "uqor", 100_000n)], memoText);
  await expect(p.getByRole("dialog", { name: "Paid Kinari" }).getByText("Paid Kinari 0.1 QOR.")).toBeVisible({
    timeout: 120_000,
  });
  expect(txOf(await p.getByRole("dialog", { name: "Paid Kinari" }).innerText()).toUpperCase()).toBe(
    sent.txHash.toUpperCase(),
  );
  await ctx.close();
});

test("pay on a phone: keypad, presets, tip, token", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone");
  await ensureOwner("e2e-editor", OWNER);
  await page.goto(`/@${OWNER}/pay`);
  const sheet = page.getByRole("dialog", { name: "Pay Kinari" });
  for (const k of ["1", "2", ".", "5"]) await sheet.locator(`button:text-is("${k}")`).first().click();
  await expect(sheet.getByLabel("Amount")).toHaveValue("12.5");
  await sheet.getByRole("button", { name: "QOR (test)" }).click();
  await expect(sheet.getByRole("button", { name: /Continue · 12\.5 QOR/ })).toBeVisible();
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: info.outputPath("pay-phone.png"), fullPage: true });
  await page.goBack();
  await expect(sheet).toBeHidden();
});

test("pay: the note fails to arrive; resend from the receipt, and from the banner on the next visit", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "on-chain flow runs once");
  test.setTimeout(480_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  const visitor = await ensureOwner("e2e-visitor", VISITOR);
  await topUp(visitor.address, DENOMS.fUSD.denom, 5_000_000n, "e2e-visitor-fusd");
  const token = await apiToken(owner);
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  await restoreInBrowser(v, visitor.phrase);

  // The drop service is unreachable for note uploads only (simulated outage).
  const blockDrops = () =>
    v.route(/\/drop\/qor1/, (r) =>
      r.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":{"code":"DOWN","message":"down","dataState":"unknown"}}',
      }),
    );
  const pay = async (amount: string, note: string) => {
    await v.goto(`/@${OWNER}/pay/${amount}`);
    const sheet = v.getByRole("dialog", { name: "Pay Kinari" });
    await sheet.getByLabel("Note to Kinari (optional)").fill(note);
    await sheet.getByRole("button", { name: /Continue/ }).click();
    // Wait until this device's account has loaded: either it asks to unlock, or it is ready to sign.
    const ready = sheet.getByText("Signed here with your keys. Your note can be read by you too.");
    await expect(sheet.getByLabel("Device passphrase").or(ready)).toBeVisible();
    if (await sheet.getByLabel("Device passphrase").isVisible()) {
      await sheet.getByLabel("Device passphrase").fill("lantern river maple tea");
      await sheet.getByRole("button", { name: "Unlock my wallet" }).click();
      await expect(ready).toBeVisible();
    }
    await sheet.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
    await v
      .getByRole("dialog", { name: "Review" })
      .getByRole("button", { name: `Pay ${amount} fUSD` })
      .click();
    const done = v.getByRole("dialog", { name: "Paid Kinari" });
    await expect(done.getByText("Sealed, not delivered yet")).toBeVisible({ timeout: 180_000 });
    return { done, txHash: txOf(await done.innerText()) };
  };

  // 1. Resend from the receipt.
  await blockDrops();
  const first = await pay("0.3", "Receipt retry");
  await expect(first.done.getByText("Your payment arrived; the note did not")).toBeVisible();
  await expect
    .poll(async () => (await ownerIndex(token)).find((r) => r.payment?.txHash === first.txHash)?.noteMissing, {
      timeout: 90_000,
    })
    .toBe(true);
  await v.unroute(/\/drop\/qor1/);
  await first.done.getByRole("button", { name: "Send the note again" }).click();
  await expect(v.getByText("Note delivered")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(async () => (await ownerIndex(token)).find((r) => r.payment?.txHash === first.txHash)?.noteMissing ?? false)
    .toBe(false);

  // 2. Close the sheet; on the next visit the page offers the kept note.
  await blockDrops();
  const second = await pay("0.4", "Banner retry");
  await second.done.getByRole("button", { name: "Done" }).click();
  await v.unroute(/\/drop\/qor1/);
  await v.goto(`/@${OWNER}`);
  await expect(v.getByText("A sealed note for Kinari did not arrive")).toBeVisible({ timeout: 30_000 });
  await v.getByRole("button", { name: "Send it now" }).click();
  await expect(v.getByText("Note delivered")).toBeVisible({ timeout: 60_000 });
  await expect(v.getByText("A sealed note for Kinari did not arrive")).toHaveCount(0);
  await expect
    .poll(async () => (await ownerIndex(token)).find((r) => r.payment?.txHash === second.txHash)?.envelope ?? null, {
      timeout: 90_000,
    })
    .toMatch(/^[0-9a-f]{64}$/);
  await expect
    .poll(async () => (await ownerIndex(token)).find((r) => r.payment?.txHash === second.txHash)?.noteMissing ?? false)
    .toBe(false);

  await ctx.close();
});

test("pay setup in the editor: decimal presets, tip, thank-you, redirect, at least one token; the payer sees them", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "editor flow runs once");
  test.setTimeout(300_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await restoreInBrowser(page, owner.phrase);
  const pay = page.locator("ol li[data-block]").filter({ has: page.locator('input[value="Pay Kinari"]') });
  await pay.getByRole("button", { name: /More for/ }).click();
  await page.getByRole("menuitem", { name: "Edit settings" }).click();
  // "2." must survive on the way to "2.5"
  const presets = pay.getByLabel("Preset amounts");
  await presets.fill("");
  await presets.pressSequentially("2.5, 10");
  await expect(presets).toHaveValue("2.5, 10");
  await presets.fill("2.5, abc");
  await expect(pay.getByText("“abc” is not an amount. Use numbers like 10 or 2.5.")).toBeVisible();
  await presets.fill("2.5, 10");
  // the last accepted token cannot be unticked
  await pay.getByLabel("Test QOR").uncheck();
  await expect(pay.getByLabel("Test dollars (fUSD)")).toBeDisabled();
  await pay.getByLabel("Test QOR").check();
  await pay.getByText("Ask for a tip").click();
  await pay.getByLabel("Thank-you message").fill("Arigatou! Your files are on the way.");
  await pay.getByLabel("After paying, offer a link to (optional)").fill("http://insecure.example");
  await expect(pay.getByText("Use a full https:// address.")).toBeVisible();
  await pay.getByLabel("After paying, offer a link to (optional)").fill("https://kinari.example/thanks");
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published to/)).toBeVisible();

  // Source of truth: the signed manifest the API serves.
  const res = (await (await fetch(`${API}/pages/${OWNER}`)).json()) as {
    record: { body: { blocks: Record<string, unknown>[] } };
  };
  const b = res.record.body.blocks.find((x) => x.title === "Pay Kinari");
  expect(b).toMatchObject({
    presets: ["2.5", "10"],
    tip: true,
    thanks: "Arigatou! Your files are on the way.",
    redirect: "https://kinari.example/thanks",
    tokens: ["fUSD", "QOR"],
  });

  // The payer sees presets and tips; the tip is added to the total.
  const v = await (await browser.newContext()).newPage();
  await v.goto(`/@${OWNER}/pay`);
  const sheet = v.getByRole("dialog", { name: "Pay Kinari" });
  await sheet.getByRole("group", { name: "Preset amounts" }).getByRole("button", { name: "10" }).click();
  await sheet.getByRole("group", { name: "Tip" }).getByRole("button", { name: "+15%" }).click();
  await expect(sheet.getByRole("button", { name: /Continue · 11\.5 fUSD/ })).toBeVisible();
  await v.screenshot({ path: info.outputPath("pay-with-tip.png") });
  await ctx.close();
});
