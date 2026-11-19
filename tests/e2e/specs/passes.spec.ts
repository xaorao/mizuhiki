/**
 * 5.12 Passes on testnet, owner, accountant, a visitor and a stranger each in
 * their own browser context.
 * Source of truth: the pass record from the API, the owner's signed page read
 * back and verified against the owner's key on chain (its pass keys), and the
 * sealed items opened outside the browser with the key the accountant was
 * sealed (so "the visitor's browser sealed to the pass" is proven, not shown).
 */
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { recipientOf, sealKeysFromSeed } from "@qorechain/qoreseal";
import {
  Purpose,
  fromBase64Url,
  fromUtf8,
  openItem,
  quarterPeriod,
  sealItem,
  solvePow,
  toBase64Url,
  utf8,
  verifyRecord,
  type Manifest,
  type Signed,
} from "@mizuhiki/core";
import { pqKeyViaEvm } from "@mizuhiki/chain";
import { ensurePersona } from "@mizuhiki/testnet";
import { test, expect } from "./fixtures";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-passown";
const HOLDER = "mzk-e2e-passacct";

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
const bytes = async (path: string) => new Uint8Array(await (await fetch(`${API}${path}`)).arrayBuffer());

async function party(
  browser: Browser,
  problems: string[],
  tag: string,
  viewport = { width: 1440, height: 900 },
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport });
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

/** The owner's published page, verified against their key on chain. */
async function signedPage(name: string, owner: string): Promise<Manifest> {
  const { record } = await call<{ record: Signed<Manifest> }>(`/pages/${name}`);
  const pq = await pqKeyViaEvm(owner);
  if (!pq.publicKey) throw new Error("no pq key");
  return verifyRecord(record, { kind: "manifest", signer: owner, pqPublicKey: pq.publicKey });
}

interface PassRow {
  id: string;
  status: string;
  keyEnvelope: string | null;
  invite: { body: { scope: { kind: string } } };
}

test("passes: invite, accept, safety words, confirm, a visitor's message sealed to the pass, older items brought up to date, revoke", async ({
  browser,
  problems,
}, info) => {
  test.skip(info.project.name !== "desktop", "four-party flow runs once, on desktop");
  test.setTimeout(900_000);
  const owner = await ensureOwner("e2e-pass-owner", OWNER);
  const holder = await ensureOwner("e2e-pass-holder", HOLDER);
  const stranger = await ensurePersona("e2e-pass-stranger");
  const ownerToken = await apiToken(owner);
  const holderToken = await apiToken(holder);
  // Each run starts with no live passes (a page lists at most 16 pass keys).
  for (const p of (await call<{ passes: PassRow[] }>("/owner/passes", { token: ownerToken })).passes)
    if (["invited", "accepted", "active"].includes(p.status))
      await call(`/passes/${p.id}/revoke`, { method: "POST", body: {}, token: ownerToken });

  // An older message, sealed to the owner only, before any pass exists.
  const oldText = `Receipt for March rent ${Date.now()}`;
  {
    const sealed = sealItem({
      purpose: Purpose.message,
      readers: [recipientOf(owner.seal)],
      plaintext: utf8(
        JSON.stringify({
          v: 1,
          kind: "message",
          text: oldText,
          contact: "",
          files: [],
          sentAt: new Date().toISOString(),
        }),
      ),
      anonymous: true,
    });
    const cfg = await call<{ powBits: number }>("/drop/config");
    await call(`/drop/${owner.address}`, {
      method: "POST",
      body: {
        envelope: toBase64Url(sealed.envelope),
        kind: "message",
        chunks: [],
        pow: solvePow(owner.address, sealed.hash, cfg.powBits),
      },
    });
  }

  // ---- owner: empty list, then New pass
  const { page: o } = await party(browser, problems, "owner");
  await restoreInBrowser(o, owner.phrase);
  await nav(o, "Passes");
  await o.waitForURL("**/app/passes");
  await expect(o.getByRole("heading", { name: "Passes", level: 1 })).toBeVisible();
  await o.getByRole("button", { name: "New pass" }).first().click();
  const sheet = o.getByRole("dialog", { name: "New pass" });
  // Wrong input first
  await sheet.getByLabel("Their @name or address").fill("qor1abc");
  await sheet.getByRole("button", { name: "Send invite" }).click();
  await expect(sheet.getByText("That address is not complete. Check it and try again.")).toBeVisible();
  await sheet.getByLabel("Their @name or address").fill("@nobody-here-zz9");
  await sheet.getByLabel("Note for them (optional)").click();
  await expect(sheet.getByText(/No Mizuhiki account has that name/)).toBeVisible({ timeout: 20_000 });
  await sheet.getByLabel("Their @name or address").fill(`@${OWNER}`);
  await sheet.getByLabel("Note for them (optional)").click();
  await expect(sheet.getByText("A pass is for someone else.")).toBeVisible({ timeout: 20_000 });
  await sheet.getByLabel("Their @name or address").fill(`@${HOLDER}`);
  await sheet.getByLabel("Note for them (optional)").click();
  await expect(sheet.getByText(`@${HOLDER}`, { exact: true })).toBeVisible({ timeout: 20_000 });
  const now = new Date();
  const q = (Math.floor(now.getUTCMonth() / 3) + 1) as 1 | 2 | 3 | 4;
  const label = `Q${q} ${now.getUTCFullYear()}`;
  await sheet.getByRole("radio", { name: label }).click();
  await sheet.getByRole("button", { name: "Messages and files" }).click();
  await expect(sheet.getByRole("button", { name: "Messages and files" })).toHaveAttribute("aria-pressed", "true");
  await sheet.getByRole("radio", { name: "Until the period ends" }).click();
  await sheet.getByLabel("Note for them (optional)").fill("Hi, here is this quarter for the VAT return.");
  const period = quarterPeriod(now.getUTCFullYear(), q);
  const lastDay = new Date(Date.parse(period.until) - 1).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  await expect(
    sheet.getByText(
      new RegExp(
        `^Can read: messages and files, payment notes and invoices, .* to ${lastDay}\\. Cannot read anything else\\. Cannot change anything\\.`,
      ),
    ),
  ).toBeVisible();
  await o.screenshot({ path: info.outputPath("01-new-pass.png") });
  await sheet.getByRole("button", { name: "Send invite" }).click();
  await o.waitForURL(/\/app\/passes\/pass_/);
  const passId = o.url().split("/").pop() ?? "";
  await expect(o.getByRole("heading", { name: `Waiting for @${HOLDER} to accept` })).toBeVisible();
  await expect(o.getByRole("banner").getByText("Invited", { exact: true })).toBeVisible();
  // Source of truth: the signed invite on the API, nothing sealed yet
  const invited = await call<PassRow>(`/passes/${passId}`, { token: ownerToken });
  expect(invited).toMatchObject({ status: "invited", keyEnvelope: null });
  expect((await signedPage(OWNER, owner.address)).periodKeys.some((k) => k.passId === passId)).toBe(false);
  await o.screenshot({ path: info.outputPath("02-invited.png"), fullPage: true });

  // ---- a stranger cannot see it
  const { page: x } = await party(browser, problems, "stranger");
  await restoreInBrowser(x, stranger.phrase);
  await x.goto(`/app/passes/${passId}`);
  await x.getByLabel("Device passphrase").fill("lantern river maple tea");
  await x.getByRole("button", { name: "Unlock" }).click();
  await expect(x.getByText("This pass does not exist or is not for you.")).toBeVisible({ timeout: 30_000 });
  problems.splice(0, problems.length, ...problems.filter((p) => !(p.startsWith("[stranger]") && p.includes("404"))));

  // ---- accountant: accepts, sees safety words
  const { page: h } = await party(browser, problems, "holder");
  await restoreInBrowser(h, holder.phrase);
  await nav(h, "Passes");
  await h.getByRole("tab", { name: /Shared with me/ }).click();
  await h.locator(`a[href="/app/passes/${passId}"]`).click();
  await expect(h.getByRole("tab", { name: /Shared with me/ })).toBeVisible();
  await expect(h.getByRole("heading", { name: `${"@" + OWNER} wants to give you read-only access` })).toBeVisible();
  await expect(h.getByText("Hi, here is this quarter for the VAT return.")).toBeVisible();
  await h.screenshot({ path: info.outputPath("03-holder-invite.png"), fullPage: true });
  await h.getByRole("button", { name: "Accept" }).click();
  await expect(h.getByRole("heading", { name: "Your safety words" })).toBeVisible({ timeout: 30_000 });
  await expect(h.getByRole("list", { name: "Your safety words" }).getByRole("listitem")).toHaveCount(6, {
    timeout: 30_000,
  });
  const holderWords = (
    await h.getByRole("list", { name: "Your safety words" }).getByRole("listitem").allInnerTexts()
  ).join(" ");
  expect(holderWords.split(" ")).toHaveLength(6);

  // ---- owner: live update to "Needs confirmation", words match, confirm
  await expect(o.getByRole("heading", { name: `Check it is really @${HOLDER}` })).toBeVisible({ timeout: 30_000 });
  await expect(o.getByRole("list", { name: "Safety words" }).getByRole("listitem")).toHaveCount(6, { timeout: 30_000 });
  const ownerWords = (await o.getByRole("list", { name: "Safety words" }).getByRole("listitem").allInnerTexts()).join(
    " ",
  );
  expect(ownerWords).toBe(holderWords);
  await o.screenshot({ path: info.outputPath("04-compare-words.png"), fullPage: true });
  await o.getByRole("button", { name: "They match, confirm" }).click();
  await expect(o.getByText(`The pass is active. @${HOLDER} can read what it covers.`)).toBeVisible({
    timeout: 240_000,
  });
  await expect(o.getByRole("heading", { name: "Active" })).toBeVisible();
  const active = await call<PassRow>(`/passes/${passId}`, { token: ownerToken });
  expect(active.status).toBe("active");
  expect(active.keyEnvelope).toMatch(/^[0-9a-f]{64}$/);
  const keys = (await signedPage(OWNER, owner.address)).periodKeys.filter((k) => k.passId === passId);
  expect(keys).toHaveLength(1);
  expect(keys[0]?.kinds).toEqual(["messages", "payments", "invoices"]);
  // The holder's key opens the sealed pass key; it matches the key on the signed page.
  const seed = (
    JSON.parse(
      fromUtf8(
        openItem({
          purpose: Purpose.pass(passId),
          envelope: await bytes(`/blobs/${active.keyEnvelope ?? ""}`),
          keys: holder.seal,
          context: "key",
        }),
      ),
    ) as { seed: string }
  ).seed;
  const passKeys = sealKeysFromSeed(fromBase64Url(seed));
  expect(Buffer.from(passKeys.x25519PublicKey).toString("hex")).toBe(keys[0]?.x25519);
  // The older message was brought up to date: one copy sealed to the holder.
  const covered = await call<{ resealed: { source: string; envelope: string }[] }>(`/passes/${passId}/items`, {
    token: holderToken,
  });
  expect(covered.resealed.length).toBeGreaterThanOrEqual(1);

  // ---- a visitor sends a message from the public page; their browser seals it to the pass key too
  const newText = `Invoice 0042 paid by bank transfer ${Date.now()}`;
  const { page: v } = await party(browser, problems, "visitor");
  await v.goto(`/@${OWNER}/message`);
  const msg = v.getByRole("dialog", { name: /something private/ });
  await msg.getByLabel("Message").fill(newText);
  await msg.getByRole("button", { name: "Next" }).click();
  await msg.getByRole("button", { name: "Seal and send" }).click();
  await expect(v.getByRole("dialog", { name: /^Sealed for/ })).toBeVisible({ timeout: 120_000 });
  const items = await call<{ live: { envelope: string; kind: string }[] }>(`/passes/${passId}/items`, {
    token: holderToken,
  });
  const texts: string[] = [];
  for (const it of items.live) {
    try {
      texts.push(
        (
          JSON.parse(
            fromUtf8(
              openItem({ purpose: Purpose.message, envelope: await bytes(`/blobs/${it.envelope}`), keys: passKeys }),
            ),
          ) as { text: string }
        ).text,
      );
    } catch {
      // sealed before the pass: covered by a copy instead
    }
  }
  expect(texts).toContain(newText);

  // ---- accountant: both items open on their device
  await h.reload();
  await h.getByLabel("Device passphrase").fill("lantern river maple tea");
  await h.getByRole("button", { name: "Unlock" }).click();
  await expect(h.getByRole("heading", { name: "What this pass covers" })).toBeVisible({ timeout: 60_000 });
  await expect(h.getByRole("button", { name: new RegExp(oldText) })).toBeVisible({ timeout: 60_000 });
  await h.getByRole("button", { name: new RegExp(newText) }).click();
  await expect(h.getByRole("dialog", { name: "Message" }).getByText(newText)).toBeVisible();
  await h.screenshot({ path: info.outputPath("05-holder-item.png"), fullPage: true });
  await h.keyboard.press("Escape");

  // ---- owner: bring up to date is idempotent; revoke with the honest words
  await o.getByRole("button", { name: "Bring up to date" }).click();
  await expect(o.getByText(/^Up to date\. The pass covers \d+ items?\.$|sealed to @/)).toBeVisible({
    timeout: 120_000,
  });
  await o.getByRole("button", { name: "Revoke" }).click();
  const revoke = o.getByRole("dialog", { name: `Revoke @${HOLDER}'s pass?` });
  await expect(
    revoke.getByText(`@${HOLDER} keeps anything already opened. Future items are not sealed to them.`),
  ).toBeVisible();
  await revoke.getByRole("button", { name: "Revoke" }).click();
  await expect(o.getByRole("heading", { name: "Revoked" })).toBeVisible({ timeout: 60_000 });
  expect((await call<PassRow>(`/passes/${passId}`, { token: ownerToken })).status).toBe("revoked");
  expect((await signedPage(OWNER, owner.address)).periodKeys.some((k) => k.passId === passId)).toBe(false);
  await o.screenshot({ path: info.outputPath("06-revoked.png"), fullPage: true });

  // ---- accountant: told plainly, keeps what was covered
  await expect(h.getByText(`@${OWNER} revoked this pass. You keep what it covered; nothing new arrives.`)).toBeVisible({
    timeout: 60_000,
  });
  await nav(o, "Passes");
  await expect(o.getByRole("link", { name: new RegExp(`@${HOLDER}`) }).first()).toBeVisible();
  await o.screenshot({ path: info.outputPath("07-list.png"), fullPage: true });
});

test("passes on a phone: list, new pass sheet and one pass fit", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone layout");
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-pass-owner", OWNER);
  await restoreInBrowser(page, owner.phrase);
  await page.goto("/app/passes");
  await page.getByLabel("Device passphrase").fill("lantern river maple tea");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "Passes", level: 1 })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Shared by me/ })).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("phone-list.png"), fullPage: true });
  await page.getByRole("button", { name: "New pass" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New pass" });
  await expect(sheet.getByRole("button", { name: "Send invite" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("phone-new.png"), fullPage: true });
  await page.keyboard.press("Escape");
  const first = page.getByRole("link", { name: /@/ }).filter({ visible: true });
  if ((await first.count()) > 0) {
    await first.first().click();
    await expect(page.getByRole("link", { name: "All passes" })).toBeVisible();
    const o2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(o2).toBeLessThanOrEqual(0);
    await page.screenshot({ path: info.outputPath("phone-detail.png"), fullPage: true });
  }
});
