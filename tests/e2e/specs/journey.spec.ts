/**
 * The carried-state journey (QA guide 4.4 and Part 6): one brand-new person, never reset, from the landing page to
 * a page that has been used, with every other party in its own browser. Nothing is prepared in the database.
 *
 *  1. A stranger lands, claims a free name in the claim box, signs up through every step; setup lands on chain.
 *  2. A visitor with no account opens the page (signature checked in the browser) and sends a sealed note and file.
 *     The owner's inbox shows it live, without a reload; the owner opens it and saves the exact bytes.
 *  3. A payer with a Mizuhiki account pays the page with a sealed note; the owner sees payment and note linked.
 *  4. The owner invoices that payer; the payer pays from the link; the owner's list turns Paid from the chain.
 *  5. The owner proves the received file existed; a stranger checks it on the certificate.
 *  6. Insights count exactly what happened; the export holds every item, payment and invoice.
 *  7. The owner restores on a second device from the 24 words and sees the same inbox.
 *  8. Money reconciles on chain: the owner's balances moved by exactly what was paid, minus the fees the owner
 *     spent, and nothing else.
 *
 * Source of truth at every hop: QoreChain (transactions, balances, keys, names, anchors), then the API, then the UI.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { DENOMS, getTx, msgSend, publicClient, readAnchor, resolveOnChain, sendTx, keyState } from "@mizuhiki/chain";
import { Purpose, deriveAccount, fromUtf8, openItem, parseMemo, sha256Hex } from "@mizuhiki/core";
import { devWallet, topUp } from "@mizuhiki/testnet";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const PASS = "lantern river maple tea";
const PAYER = "mzk-e2e-visitor";
const REST = process.env.QORE_REST ?? "https://api-testnet.qore.host";

test.describe.configure({ mode: "serial" });

async function balances(address: string): Promise<Record<string, bigint>> {
  const r = (await (await fetch(`${REST}/cosmos/bank/v1beta1/balances/${address}`)).json()) as {
    balances: { denom: string; amount: string }[];
  };
  return Object.fromEntries(r.balances.map((b) => [b.denom, BigInt(b.amount)]));
}

/** The account's exact QOR balance in wei (1 uqor = 10^12 wei), which includes the EVM lane's fractions. */
const weiOf = (hex: `0x${string}`) => publicClient().getBalance({ address: hex });

/**
 * Every fee this account paid, in wei, read from its own transactions on chain. Native-lane transactions pay
 * their fee field in uqor. EVM transactions pay gasUsed x effectiveGasPrice from the receipt, not the fee cap on
 * the transaction (custody kit docs/signing.md and docs/deposits.md: the rest comes back as a refund).
 */
async function feesPaidBy(address: string): Promise<bigint> {
  let total = 0n;
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ query: `message.sender='${address}'`, page: String(page), limit: "50" });
    const r = (await (await fetch(`${REST}/cosmos/tx/v1beta1/txs?${q.toString()}`)).json()) as {
      tx_responses?: {
        tx: {
          body: { messages: { "@type": string }[] };
          auth_info: { fee: { amount: { denom: string; amount: string }[] } };
        };
        events: { type: string; attributes: { key: string; value: string }[] }[];
      }[];
    };
    const rows = r.tx_responses ?? [];
    for (const t of rows) {
      const evm = t.events.find((e) => e.type === "ethereum_tx")?.attributes.find((a) => a.key === "ethereumTxHash")
        ?.value as `0x${string}` | undefined;
      if (evm) {
        const rc = await publicClient().getTransactionReceipt({ hash: evm });
        total += rc.gasUsed * rc.effectiveGasPrice;
      } else for (const a of t.tx.auth_info.fee.amount) if (a.denom === "uqor") total += BigInt(a.amount) * 10n ** 12n;
    }
    if (rows.length < 50) break;
  }
  return total;
}

async function newContext(browser: Browser, info: { project: { use: unknown } }) {
  const ctx = await browser.newContext({ ...(info.project.use as object), acceptDownloads: true });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    if (!/net::ERR_ABORTED/.test(r.failure()?.errorText ?? "")) problems.push(`requestfailed: ${r.url()}`);
  });
  return { ctx, page, problems };
}

const shot = (p: Page, info: { outputPath: (n: string) => string }, n: string) =>
  p.screenshot({ path: info.outputPath(`${n}.png`), fullPage: true });

const openNav = async (p: Page, label: RegExp) => {
  const more = p.getByRole("navigation", { name: "Owner sections" }).getByRole("button", { name: "More" });
  if (await more.isVisible()) {
    await more.click();
    await p.getByRole("navigation", { name: "All sections" }).getByRole("link", { name: label }).click();
  } else await p.getByRole("navigation", { name: "Owner sections" }).getByRole("link", { name: label }).first().click();
};

test("carried state: a new person from the landing page to a page that has been used", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "the on-chain journey runs once; screens are checked on phones elsewhere");
  test.setTimeout(1_800_000);
  const name = `jr${Date.now().toString(36)}`;
  const payer = await ensureOwner("e2e-visitor", PAYER);
  await topUp(payer.address, DENOMS.fUSD.denom, 10_000_000n, "e2e-visitor-fusd");

  // ---------------------------------------------------------------- 1. land, claim, sign up
  const O = await newContext(browser, info);
  const o = O.page;
  await o.goto("/");
  await o.getByRole("textbox", { name: /name/i }).first().fill(name);
  await expect(o.getByText(/is yours to claim|available/i).first()).toBeVisible({ timeout: 30_000 });
  await shot(o, info, "01-claim");
  await o.getByRole("button", { name: "Claim your page" }).first().click();
  await o.waitForURL(/\/signup/);
  await expect(o.getByRole("heading", { name: "Choose your page name" })).toBeVisible();
  await expect(o.getByLabel("Page name")).toHaveValue(name);
  await expect(o.getByText("It's available")).toBeVisible();
  await o.getByRole("button", { name: "Continue" }).click();
  await o.getByRole("radio", { name: /Business/ }).click();
  await o.getByRole("button", { name: "Continue" }).click();
  await o.getByRole("radio", { name: /Kinari/ }).click();
  await o.getByRole("button", { name: "Continue" }).click();
  await expect(o.getByRole("heading", { name: "What should your page do?" })).toBeVisible();
  await o.getByRole("button", { name: "Continue" }).click();
  await o.getByLabel("Display name").fill("Journey Studio");
  await o.getByLabel("Bio").fill("A page used end to end, sealed.");
  await o.getByRole("button", { name: "Continue" }).click();
  await expect(o.getByRole("heading", { name: "Create your key" })).toBeVisible();
  await expect(o.locator("ol[aria-label='Your 24 recovery words'] b")).toHaveCount(24);
  const words = await o.locator("ol[aria-label='Your 24 recovery words'] b").allInnerTexts();
  expect(words).toHaveLength(24);
  const phrase = words.join(" ");
  const sheet = o.waitForEvent("download");
  await o.getByRole("button", { name: "Save my spare-key sheet" }).click();
  expect(execFileSync("pdftotext", [await (await sheet).path(), "-"], { encoding: "utf8" })).toContain(`For @${name}`);
  await o.getByRole("button", { name: "I saved it" }).click();
  const labels = await o
    .getByLabel(/^Word \d+$/)
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).labels?.[0]?.textContent ?? ""));
  for (const l of labels) await o.getByLabel(l, { exact: true }).fill(words[Number(l.replace("Word ", "")) - 1] ?? "");
  await o.getByRole("button", { name: "Check" }).click();
  await o.getByLabel("Device passphrase").fill(PASS);
  await o.getByLabel("Type it again").fill(PASS);
  await o.getByRole("button", { name: "Lock and continue" }).click();
  await expect(o.getByText("Open the faucet")).toBeVisible({ timeout: 60_000 });
  await expect(o.getByText(/sign in to the QoreChain dashboard/)).toBeVisible();
  await shot(o, info, "02-funding");
  const account = deriveAccount(phrase);
  const owner = { address: account.address.bech32, seal: account.seal };
  // Funding stands in for the faucet (Compromise ledger: the faucet needs a dashboard sign-in).
  const dev = devWallet();
  await sendTx(dev, [msgSend(dev.address, owner.address, DENOMS.QOR.denom, 400_000n)], "mzk:test-fund:journey");
  await expect(o.getByRole("heading", { name: "Your page is live" })).toBeVisible({ timeout: 420_000 });
  await shot(o, info, "03-live");
  const ks = await keyState({ address: owner.address, classical: account.classical, pq: account.pq }, account.seal);
  expect(ks).toMatchObject({ pq: "ours", kem: "ours", possessionProven: true });
  expect((await resolveOnChain(name)).owner?.toLowerCase()).toBe(account.address.hex.toLowerCase());
  // Money in, to the wei: funded 0.4 QOR, minus exactly the fees of the account's own transactions.
  const evmAddr = account.address.hex as `0x${string}`;
  const FUND = 400_000n * 10n ** 12n;
  expect(await weiOf(evmAddr)).toBe(FUND - (await feesPaidBy(owner.address)));
  await o.getByRole("button", { name: "Open dashboard" }).click();
  await o.waitForURL("**/app");
  await openNav(o, /^Inbox/);
  await o.waitForURL("**/app/inbox");
  // The only thing in a new inbox: the funding transfer, shown as the payment it is.
  await expect(o.getByRole("region", { name: "Inbox list" }).getByRole("button", { name: /0\.4 QOR/ })).toBeVisible({
    timeout: 60_000,
  });
  await shot(o, info, "04-inbox-new");

  // ---------------------------------------------------------------- 2. a visitor sends; the owner sees it live
  const V = await newContext(browser, info);
  const v = V.page;
  await v.goto(`/@${name}`);
  await expect(v.getByText(new RegExp(`This page really is @${name}'s, checked on QoreChain`))).toBeVisible({
    timeout: 60_000,
  });
  await expect(v.getByRole("heading", { name: "Journey Studio" })).toBeVisible();
  await shot(v, info, "05-public");
  const note = `Signed brief for the journey ${Date.now()}`;
  const file = { name: "journey-brief.pdf", mimeType: "application/pdf", buffer: randomBytes(300 * 1024) };
  await v.getByRole("button", { name: /Send me something private/ }).click();
  const send = v.getByRole("dialog", { name: /Send Journey something private/ });
  await send.getByLabel("Message").fill(note);
  await send.locator('input[type="file"]').setInputFiles(file);
  await send.getByRole("button", { name: "Next" }).click();
  await send.getByRole("button", { name: "Seal and send" }).click();
  await expect(v.getByText("Stored for Journey, sealed.")).toBeVisible({ timeout: 180_000 });
  // Live: the owner's open inbox shows it without a reload.
  const list = o.getByRole("region", { name: "Inbox list" });
  const item = list.getByRole("button", { name: /Sealed · tap to open/ }).first();
  await expect(item).toBeVisible({ timeout: 60_000 });
  await item.click();
  const detail = o.getByRole("region", { name: "Opened item" });
  await expect(detail.getByText(note)).toBeVisible({ timeout: 60_000 });
  const [dl] = await Promise.all([o.waitForEvent("download"), detail.getByRole("button", { name: "Save" }).click()]);
  expect(Buffer.from(await readFile(await dl.path())).equals(file.buffer)).toBe(true);
  await shot(o, info, "06-message-opened");
  expect(V.problems).toEqual([]);

  // ---------------------------------------------------------------- 3. a payer pays the page with a sealed note
  const P = await newContext(browser, info);
  const p = P.page;
  await restoreInBrowser(p, payer.phrase);
  const payNote = `For the journey launch ${Date.now()}`;
  await p.goto(`/@${name}/pay/1.5`);
  const pay = p.getByRole("dialog", { name: "Pay Journey" });
  await expect(pay.getByLabel("Amount")).toHaveValue("1.5");
  await pay.getByLabel("Note to Journey (optional)").fill(payNote);
  const cont = pay.getByRole("button", { name: /Continue · 1\.5 (\w+)/ });
  const token = (/1\.5 (\w+)/.exec((await cont.textContent()) ?? "")?.[1] ?? "") as "QOR" | "fUSD";
  expect(["QOR", "fUSD"]).toContain(token);
  await cont.click();
  await pay.getByLabel("Device passphrase").fill(PASS);
  await pay.getByRole("button", { name: "Unlock my wallet" }).click();
  await expect(pay.getByLabel("Device passphrase")).toHaveCount(0, { timeout: 60_000 });
  await pay.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  const review = p.getByRole("dialog", { name: "Review" });
  await expect(review.getByText(owner.address)).toBeVisible({ timeout: 30_000 });
  await shot(p, info, "07-pay-review");
  await review.getByRole("button", { name: `Pay 1.5 ${token}` }).click();
  const paid = p.getByRole("dialog", { name: "Paid Journey" });
  await expect(paid.getByText(`Paid Journey 1.5 ${token}.`)).toBeVisible({ timeout: 180_000 });
  await expect(paid.getByText(/^Sealed and stored for /)).toBeVisible();
  const payTx = ((await paid.innerText()).match(/([0-9A-F]{8} ?){8}/i)?.[0] ?? "").replace(/ /g, "");
  const tx1 = (await getTx(payTx)) as unknown as {
    code: number;
    tx: { body: { memo: string; messages: { to_address: string; amount: { denom: string; amount: string }[] }[] } };
  };
  expect(tx1.code).toBe(0);
  expect(tx1.tx.body.messages[0]?.to_address).toBe(owner.address);
  const payDenom = DENOMS[token].denom;
  expect(tx1.tx.body.messages[0]?.amount).toEqual([{ denom: payDenom, amount: "1500000" }]);
  const memo = parseMemo(tx1.tx.body.memo);
  const noteEnv = new Uint8Array(await (await fetch(`${API}/blobs/${memo?.noteHash ?? ""}`)).arrayBuffer());
  expect(fromUtf8(openItem({ purpose: Purpose.payNote, envelope: noteEnv, keys: owner.seal }))).toContain(payNote);
  await paid.getByRole("button", { name: "Done" }).click();
  // The owner sees the payment with its note, linked.
  await expect(list.getByRole("button", { name: new RegExp(`1\\.5 ${token}`) }).first()).toBeVisible({
    timeout: 120_000,
  });
  await list
    .getByRole("button", { name: new RegExp(`1\\.5 ${token}`) })
    .first()
    .click();
  await expect(detail.getByText(payNote)).toBeVisible({ timeout: 60_000 });
  await shot(o, info, "08-payment-in-inbox");

  // ---------------------------------------------------------------- 4. invoice to the payer, paid from the link
  await openNav(o, /^Invoices/);
  await o.waitForURL("**/app/invoices");
  await o.getByRole("link", { name: "New invoice" }).first().click();
  await o.getByRole("button", { name: "A Mizuhiki @name" }).click();
  await o.getByLabel("Their @name").fill(PAYER);
  await o.getByLabel("Their business name (optional)").fill("Leaf & Kettle Tea");
  await o.getByLabel("Item 1 name").fill("Journey workshop");
  await o.getByLabel("Price (fUSD)").first().fill("2");
  await expect(o.getByText("Draft saved, sealed")).toBeVisible({ timeout: 30_000 });
  await o.getByRole("button", { name: "Send", exact: true }).click();
  const share = o.getByRole("dialog", { name: /Invoice #\d{4} is ready/ });
  const link =
    (await share.innerText({ timeout: 60_000 })).match(/http:\/\/[^\s]+\/i\/[a-z0-9]+#k=[A-Za-z0-9_-]+&n=\d+/)?.[0] ??
    "";
  expect(link).not.toBe("");
  await share.getByRole("button", { name: `Send to @${PAYER}` }).click();
  await expect(share.getByRole("button", { name: "Sent" })).toBeVisible({ timeout: 120_000 });
  await p.goto(link);
  await expect(p.getByText(new RegExp(`This invoice really is from @${name}, checked on QoreChain`))).toBeVisible({
    timeout: 60_000,
  });
  await p.getByRole("button", { name: /^Pay #\d{4}$/ }).click();
  const ipay = p.getByRole("dialog", { name: /Pay invoice #\d{4}/ });
  await ipay.getByLabel("Device passphrase").fill(PASS);
  await ipay.getByRole("button", { name: "Unlock my wallet" }).click();
  await expect(ipay.getByLabel("Device passphrase")).toHaveCount(0, { timeout: 60_000 });
  await ipay.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  await p.getByRole("dialog", { name: "Review" }).getByRole("button", { name: "Pay 2 fUSD" }).click();
  const ipaid = p.getByRole("dialog", { name: "Paid Journey" });
  await expect(ipaid.getByText("Paid Journey 2 fUSD.")).toBeVisible({ timeout: 180_000 });
  const invTx = ((await ipaid.innerText()).match(/([0-9A-F]{8} ?){8}/i)?.[0] ?? "").replace(/ /g, "");
  expect(((await getTx(invTx)) as unknown as { code: number }).code).toBe(0);
  await share.getByRole("button", { name: "Done" }).click();
  await expect(
    o
      .getByRole("row", { name: /Leaf & Kettle Tea/ })
      .first()
      .getByText("Paid", { exact: true }),
  ).toBeVisible({ timeout: 180_000 });
  await shot(o, info, "09-invoice-paid");
  expect(P.problems).toEqual([]);
  await P.ctx.close();

  // ---------------------------------------------------------------- 5. prove the received file; a stranger checks it
  await openNav(o, /^Inbox/);
  await list
    .getByRole("button", { name: /journey-brief|Anonymous/ })
    .first()
    .click();
  await detail.getByRole("button", { name: "Prove it existed" }).click();
  const prove = o.getByRole("dialog", { name: "Prove it existed" });
  await prove.getByRole("button", { name: "Anchor on QoreChain" }).click();
  await expect(prove.getByText("Anchored. It is on QoreChain now.")).toBeVisible({ timeout: 240_000 });
  await prove.getByRole("button", { name: "Done" }).click();
  const fileHash = sha256Hex(file.buffer);
  const anchor = await readAnchor(fileHash);
  expect(anchor?.byAddress).toBe(owner.address);
  await v.goto(`/proof/${fileHash}`);
  await expect(v.getByRole("link", { name: `@${name}` })).toBeVisible({ timeout: 60_000 });
  await v.locator('input[type="file"]').setInputFiles(file);
  await expect(v.getByText("Match", { exact: true })).toBeVisible();
  await shot(v, info, "10-certificate");
  await V.ctx.close();

  // ---------------------------------------------------------------- 6. Insights and the export reconcile
  const token6 = await apiToken({ address: account.address.bech32, classical: account.classical, pq: account.pq });
  const inbox = (await (
    await fetch(`${API}/owner/inbox?limit=200`, { headers: { authorization: `Bearer ${token6}` } })
  ).json()) as {
    rows: { kind: string; payment: unknown; envelope: string | null }[];
  };
  const payments = inbox.rows.filter((r) => r.payment).length;
  // The funding transfer, the page payment and the invoice payment.
  expect(payments).toBe(3);
  await openNav(o, /^Insights/);
  await o.waitForURL("**/app/insights");
  const tile = (label: string) => o.getByText(label, { exact: true }).locator("xpath=..").locator("b");
  // Exactly what happened: two page views (the visitor and the payer), the sealed note and the payment note,
  // two payments through the page (the funding transfer is not page money). Read after the count-up settles.
  await expect(tile("Views")).toHaveText("2", { timeout: 60_000 });
  await expect(tile("Sealed items received")).toHaveText("2");
  await expect(o.getByText("1 message, 1 payment note")).toBeVisible();
  await expect(o.getByText(/^2 payments/)).toBeVisible();
  await shot(o, info, "11-insights");
  await openNav(o, /^Settings/);
  await o.waitForURL("**/app/settings");
  const exp = o.waitForEvent("download", { timeout: 300_000 });
  await o.locator("#data").getByRole("button", { name: "Export" }).click();
  const zip = unzipSync(new Uint8Array(await readFile(await (await exp).path())));
  const keys = Object.keys(zip);
  expect(JSON.parse(strFromU8(zip["page.json"] ?? new Uint8Array())).name).toBe(name);
  expect(keys.filter((k) => k.startsWith("payments/"))).toHaveLength(3);
  expect(keys.filter((k) => k.startsWith("invoices/"))).toHaveLength(1);
  const saved = keys.find((k) => k.endsWith("/journey-brief.pdf"));
  expect(saved && Buffer.from(zip[saved] ?? new Uint8Array()).equals(file.buffer)).toBe(true);
  expect(O.problems).toEqual([]);
  await O.ctx.close();

  // ---------------------------------------------------------------- 7. a second device from the 24 words
  const D = await newContext(browser, info);
  await restoreInBrowser(D.page, phrase);
  await openNav(D.page, /^Inbox/);
  await expect(
    D.page.getByRole("region", { name: "Inbox list" }).getByRole("button", { name: new RegExp(`1\\.5 ${token}`) }),
  ).toBeVisible({ timeout: 60_000 });
  await shot(D.page, info, "12-second-device");
  expect(D.problems).toEqual([]);
  await D.ctx.close();

  // ---------------------------------------------------------------- 8. money reconciles on chain
  const end = await balances(owner.address);
  const fees = await feesPaidBy(owner.address);
  const wei = await weiOf(evmAddr);
  expect(wei).toBe(FUND - fees + (token === "QOR" ? 1_500_000n * 10n ** 12n : 0n));
  expect(end[DENOMS.fUSD.denom] ?? 0n).toBe(2_000_000n + (token === "fUSD" ? 1_500_000n : 0n));
  info.annotations.push({
    type: "reconciled",
    description: `@${name} ${owner.address}: ${String(wei)} wei = 0.4 QOR funded - ${String(fees)} wei fees${token === "QOR" ? " + 1.5 QOR paid" : ""}; fUSD ${String(end[DENOMS.fUSD.denom])}; pay ${payTx}; invoice ${invTx}`,
  });
});
