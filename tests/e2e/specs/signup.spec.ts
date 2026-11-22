/**
 * 5.2 Sign-up as a brand-new person, through the real UI, on QoreChain testnet.
 * The only stand-in is funding: the faucet needs a web sign-in, so the test sends
 * real test QOR from the dev wallet to the new address while the screen polls.
 * Every claim is then checked against the chain and the API.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test, expect } from "./fixtures";
import { DENOMS, resolveOnChain, keyState, waitForTx } from "@mizuhiki/chain";
import { deriveAccount } from "@mizuhiki/core";

const API = process.env.API_URL ?? "http://127.0.0.1:4000";

test.describe.configure({ mode: "serial" });

test("sign up: name, goal, look, blocks, profile, key, setup on chain, live page", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "the chain flow runs once; phone layout is covered below");
  test.setTimeout(420_000);
  const name = `e2e${Date.now().toString(36)}`;

  await page.goto(`/signup?name=${name}`);
  await expect(page.getByRole("heading", { name: "Choose your page name" })).toBeVisible();
  await expect(page.getByText("It's available")).toBeVisible();
  // wrong input first
  await page.getByLabel("Page name").fill("ab");
  await expect(page.getByText("Usernames must be 3 characters or longer")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByLabel("Page name").fill(name);
  await expect(page.getByText("It's available")).toBeVisible();
  await page.screenshot({ path: info.outputPath("s1-name.png") });
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "What is your page for?" })).toBeVisible();
  await page.getByRole("radio", { name: /Business/ }).click();
  await page.screenshot({ path: info.outputPath("s2-goal.png") });
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByRole("radio", { name: /Kinari/ }).click();
  await page.screenshot({ path: info.outputPath("s3-look.png") });
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "What should your page do?" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Pay me/ })).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({ path: info.outputPath("s4-blocks.png") });
  await page.getByRole("button", { name: "Continue" }).click();

  await page.getByLabel("Display name").fill("E2E Studio");
  await page.getByLabel("Bio").fill("Contracts and invoices come through here, sealed.");
  await expect(page.locator("aside").getByRole("heading", { name: "E2E Studio" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("s5-profile.png") });
  await page.getByRole("button", { name: "Continue" }).click();

  await expect(page.getByRole("heading", { name: "Create your key" })).toBeVisible();
  // The words are made just after the step appears.
  await expect(page.locator("ol[aria-label='Your 24 recovery words'] b")).toHaveCount(24);
  const words = await page.locator("ol[aria-label='Your 24 recovery words'] b").allInnerTexts();
  expect(words).toHaveLength(24);
  await page.screenshot({ path: info.outputPath("s6-key.png") });
  const phrase = words.join(" ");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save my spare-key sheet" }).click();
  const file = await (await download).path();
  const text = execFileSync("pdftotext", [file, "-"], { encoding: "utf8" });
  expect(text).toContain(`For @${name}`);
  expect(text).toContain(words[0]);
  expect(text).toContain(words[23]);
  expect(text).toContain(deriveAccount(phrase).address.bech32);
  expect(readFileSync(file).length).toBeGreaterThan(1000);
  await page.getByRole("button", { name: "I saved it" }).click();

  await expect(page.getByRole("heading", { name: "Check your words" })).toBeVisible();
  const labels = await page
    .getByLabel(/^Word \d+$/)
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).labels?.[0]?.textContent ?? ""));
  const positions = labels.map((l) => Number(l.replace("Word ", "")) - 1);
  // a wrong word first
  await page.getByLabel(labels[0] ?? "", { exact: true }).fill("wrongword");
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.getByText(`That is not word ${(positions[0] ?? 0) + 1}. Check your sheet.`)).toBeVisible();
  await page.screenshot({ path: info.outputPath("s7-check-wrong.png") });
  for (const [i, p] of positions.entries())
    await page.getByLabel(labels[i] ?? "", { exact: true }).fill(words[p] ?? "");
  await page.getByRole("button", { name: "Check" }).click();

  await expect(page.getByRole("heading", { name: "Lock this device" })).toBeVisible();
  await page.getByLabel("Device passphrase").fill("short");
  await expect(page.getByText("Use at least 10 characters.")).toBeVisible();
  await page.screenshot({ path: info.outputPath("s8-passphrase.png") });
  await page.getByLabel("Device passphrase").fill("lantern river maple tea");
  await page.getByLabel("Type it again").fill("lantern river maple tea");
  await page.getByRole("button", { name: "Lock and continue" }).click();

  await expect(page.getByRole("heading", { name: "Getting your account ready" })).toBeVisible();
  // No faucet: Mizuhiki's testnet sponsor sends the starter test QOR by itself (ARCHITECTURE 8h).
  const sent = page.getByText(/^Mizuhiki sent you 0\.2 test QOR for the network fees of setup\./);
  await expect(sent).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText("Open the faucet")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("s9-funding.png") });
  const account = deriveAccount(phrase);
  // Source of truth: the sponsor's transaction on QoreChain paid this account exactly 0.2 test QOR.
  const grantTx =
    (await page.getByRole("link", { name: "See the transaction" }).getAttribute("href"))?.split("/tx/")[1] ?? "";
  const gtx = await waitForTx(grantTx);
  expect(gtx.code).toBe(0);
  const send = (
    gtx.tx as {
      body: { memo: string; messages: { to_address: string; amount: { denom: string; amount: string }[] }[] };
    }
  ).body;
  expect(send.memo).toBe("mzk:starter-grant");
  expect(send.messages[0]?.to_address).toBe(account.address.bech32);
  expect(send.messages[0]?.amount).toEqual([{ denom: DENOMS.QOR.denom, amount: "200000" }]);

  await expect(page.getByRole("heading", { name: "Your page is live" })).toBeVisible({ timeout: 300_000 });
  await page.screenshot({ path: info.outputPath("done.png") });

  // Source of truth: the chain, then the API.
  const ks = await keyState(
    { address: account.address.bech32, classical: account.classical, pq: account.pq },
    account.seal,
  );
  expect(ks).toMatchObject({ pq: "ours", kem: "ours", possessionProven: true });
  const reg = await resolveOnChain(name);
  expect(reg.owner?.toLowerCase()).toBe(account.address.hex.toLowerCase());
  const pageRes = (await (await fetch(`${API}/pages/${name}`)).json()) as {
    record: { body: { displayName: string; blocks: { type: string }[] } };
    card: unknown;
  };
  expect(pageRes.record.body.displayName).toBe("E2E Studio");
  expect(pageRes.record.body.blocks.map((b) => b.type)).toEqual(["pay", "message"]);
  expect(pageRes.card).not.toBeNull();
});

test("sign up on a phone: steps fit, no sideways scroll", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone layout");
  await page.goto("/signup?name=phonecheck");
  await expect(page.getByRole("heading", { name: "Choose your page name" })).toBeVisible();
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: info.outputPath("name-phone.png") });
  // Every step before the account exists, on a phone: each fits with no sideways scroll.
  const fits = async (shot: string) => {
    const [w, i] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(w, shot).toBeLessThanOrEqual(i);
    await page.screenshot({ path: info.outputPath(`${shot}.png`), fullPage: true });
  };
  await expect(page.getByText("It's available")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "What is your page for?" })).toBeVisible();
  await page.getByRole("radio", { name: /Business/ }).click();
  await fits("goal-phone");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Kinari/ }).click();
  await fits("look-phone");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "What should your page do?" })).toBeVisible();
  await fits("blocks-phone");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Display name").fill("Phone Studio");
  await fits("profile-phone");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Create your key" })).toBeVisible();
  await expect(page.locator("ol[aria-label='Your 24 recovery words'] b")).toHaveCount(24);
  await fits("key-phone");
});
