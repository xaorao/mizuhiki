/**
 * 5.13 Spare key and recovery on testnet: the owner, two recovery contacts,
 * a new device, a stranger's device and an offline reader, each in its own
 * browser context.
 * Source of truth: the sheet read back with pdftotext; the pieces fetched from
 * the API and opened outside the browser with each contact's key, then
 * combined into the owner's phrase; request states from the API and the
 * database; the restored device's account checked against the owner's address.
 * The 48-hour wait is advanced in the database (the one clock the test moves).
 */
import { execFileSync } from "node:child_process";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { Purpose, combinePhrase, openItem } from "@mizuhiki/core";
import { test, expect } from "./fixtures";
import { PSQL } from "./pg";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-recown";
const C1 = "mzk-e2e-reck1";
const C2 = "mzk-e2e-reck2";
const PASS = "lantern river maple tea";
const DEV_DB = process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki";
const sqlRun = (q: string) => execFileSync(PSQL, [DEV_DB, "-At", "-c", q], { encoding: "utf8" }).trim();

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
const bytes = async (h: string) => new Uint8Array(await (await fetch(`${API}/blobs/${h}`)).arrayBuffer());

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
const wordsIn = async (page: Page, list: string) => {
  const l = page.getByRole("list", { name: list });
  await expect(l.getByRole("listitem")).toHaveCount(6, { timeout: 30_000 });
  return (await l.getByRole("listitem").allInnerTexts()).join(" ");
};

interface Mine {
  settings: { version: number; threshold: number };
  contacts: { contact: string; status: string; piece: string | null; pieceVersion: number | null }[];
  requests: { id: string; status: string; test: boolean }[];
}

/** A contact's browser answers the open request from the given owner, after comparing words. */
async function help(page: Page, expectWords: string) {
  await page.reload();
  await page.getByLabel("Device passphrase").fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.getByRole("tab", { name: /People you help/ }).click();
  await page.getByRole("button", { name: `Help @${OWNER}` }).click();
  const sheet = page.getByRole("dialog", { name: `Help @${OWNER}` });
  expect(await wordsIn(page, "Words on their new device")).toBe(expectWords);
  await sheet.getByRole("button", { name: "They match, send my piece" }).click();
  await expect(page.getByText(`Your piece is sealed to @${OWNER}'s new device.`)).toBeVisible({ timeout: 60_000 });
}

test("spare key: sheet with re-auth, contacts with safety words, pieces, test run, real recovery on a new device after the wait, a stranger's recovery cancelled, offline reader", async ({
  browser,
  problems,
}, info) => {
  test.skip(info.project.name !== "desktop", "multi-party flow runs once, on desktop");
  test.setTimeout(1_200_000);
  const owner = await ensureOwner("e2e-rec-owner", OWNER);
  const c1 = await ensureOwner("e2e-rec-c1", C1);
  const c2 = await ensureOwner("e2e-rec-c2", C2);
  const ownerToken = await apiToken(owner);
  // Start clean: no contacts, no open requests, no offline reader.
  const before = await call<Mine>("/owner/recovery", { token: ownerToken });
  for (const c of before.contacts)
    if (c.status !== "removed")
      await call(`/owner/recovery/contacts/${c.contact}`, { method: "DELETE", token: ownerToken });
  for (const r of before.requests)
    if (["open", "waiting", "ready"].includes(r.status))
      await call(`/owner/recovery/requests/${r.id}/cancel`, { method: "POST", body: {}, token: ownerToken });
  await call("/owner/recovery/offline", { method: "PUT", body: { key: null }, token: ownerToken });
  sqlRun(`update recovery_settings set sheet_saved_at = null, tested_at = null where owner = '${owner.address}'`);

  // ---- owner: the page, the sheet behind a passphrase check
  const { page: o } = await party(browser, problems, "owner");
  await restoreInBrowser(o, owner.phrase);
  await nav(o, "Spare key");
  await o.waitForURL("**/app/spare-key");
  await expect(o.getByRole("heading", { name: "0 of 3 done" })).toBeVisible({ timeout: 30_000 });
  await o.screenshot({ path: info.outputPath("01-empty.png"), fullPage: true });
  await o.getByRole("button", { name: "Download the sheet" }).click();
  const confirm = o.getByRole("dialog", { name: "Confirm it is you" });
  await confirm.getByLabel("Device passphrase").fill("not my passphrase");
  await confirm.getByRole("button", { name: "Make the sheet" }).click();
  await expect(confirm.getByText("That passphrase is not right. Nothing was shown.")).toBeVisible({ timeout: 30_000 });
  await confirm.getByLabel("Device passphrase").fill(PASS);
  const dl = o.waitForEvent("download");
  await confirm.getByRole("button", { name: "Make the sheet" }).click();
  const file = await (await dl).path();
  const text = execFileSync("pdftotext", [file, "-"], { encoding: "utf8" });
  expect(text).toContain(`For @${OWNER}`);
  for (const w of owner.phrase.split(" ").slice(0, 3)) expect(text).toContain(w);
  await expect(o.getByRole("heading", { name: "1 of 3 done" })).toBeVisible({ timeout: 30_000 });

  // ---- owner adds two contacts (wrong input first)
  await o.getByRole("button", { name: "Add a contact" }).click();
  let add = o.getByRole("dialog", { name: "Add a recovery contact" });
  await add.getByLabel("Their @name or address").fill(`@${OWNER}`);
  await add.getByRole("button", { name: "Send invite" }).click();
  await expect(add.getByText(/A recovery contact is someone else/)).toBeVisible({ timeout: 30_000 });
  await add.getByLabel("Their @name or address").fill(`@${C1}`);
  await add.getByLabel("A note for them (optional)").fill("If I ever lose my phone, I may call you.");
  await add.getByRole("button", { name: "Send invite" }).click();
  await expect(o.getByText(`Invited @${C1}.`, { exact: false })).toBeVisible({ timeout: 60_000 });
  await o.getByRole("button", { name: "Add a contact" }).click();
  add = o.getByRole("dialog", { name: "Add a recovery contact" });
  await add.getByLabel("Their @name or address").fill(`@${C2}`);
  await add.getByRole("button", { name: "Send invite" }).click();
  await expect(o.getByText(`Invited @${C2}.`, { exact: false })).toBeVisible({ timeout: 60_000 });

  // ---- contacts accept and read their safety words
  const contactPages: Page[] = [];
  const contactWords: string[] = [];
  for (const [c, name] of [
    [c1, C1],
    [c2, C2],
  ] as const) {
    const { page } = await party(browser, problems, name);
    await restoreInBrowser(page, c.phrase);
    await nav(page, "Spare key");
    await page.getByRole("tab", { name: /People you help/ }).click();
    await expect(
      page
        .getByText("If I ever lose my phone, I may call you.")
        .or(page.getByText("Asks you to hold a piece of their spare key.")),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Accept" }).click();
    contactWords.push(await wordsIn(page, "Your safety words"));
    contactPages.push(page);
  }
  await contactPages[0]?.screenshot({ path: info.outputPath("02-contact-accepted.png"), fullPage: true });

  // ---- owner compares words and confirms each, then seals the pieces
  for (const [i, name] of [C1, C2].entries()) {
    await expect(o.getByRole("button", { name: "Check words" }).first()).toBeVisible({ timeout: 60_000 });
    const row = o.getByRole("listitem").filter({ hasText: `@${name}` });
    await row.getByRole("button", { name: "Check words" }).click();
    expect(await wordsIn(o, "Safety words")).toBe(contactWords[i]);
    await o
      .getByRole("dialog", { name: `Check it is really @${name}` })
      .getByRole("button", { name: "They match, confirm" })
      .click();
    await expect(o.getByText(`@${name} is confirmed.`)).toBeVisible({ timeout: 30_000 });
  }
  await expect(o.getByText("2 contacts are ready.")).toBeVisible();
  await o.screenshot({ path: info.outputPath("03-ready-to-seal.png"), fullPage: true });
  await o.getByRole("button", { name: "Seal the pieces" }).click();
  await expect(o.getByText("Pieces sealed. Any 2 of 2 contacts can help you.")).toBeVisible({ timeout: 120_000 });
  await expect(o.getByRole("heading", { name: "2 of 3 done" })).toBeVisible();
  // Source of truth: one piece each, opened only with that contact's key; together they are the phrase.
  const mine = await call<Mine>("/owner/recovery", { token: ownerToken });
  const held = mine.contacts.filter((c) => c.piece && c.pieceVersion === mine.settings.version);
  expect(held.map((c) => c.contact).sort()).toEqual([c1.address, c2.address].sort());
  const parts = [];
  for (const c of [c1, c2]) {
    const h = held.find((x) => x.contact === c.address)?.piece ?? "";
    parts.push(
      openItem({
        purpose: Purpose.recoveryShare(String(mine.settings.version)),
        envelope: await bytes(h),
        keys: c.seal,
        context: c.address,
      }),
    );
  }
  expect(await combinePhrase(parts, 2)).toBe(owner.phrase);

  // ---- test run: both contacts answer, no wait, passed
  await o.getByRole("button", { name: "Start a test" }).click();
  const testWords = await wordsIn(o, "Test words");
  for (const page of contactPages) await help(page, testWords);
  await expect(o.getByText("Recovery works. Your contacts' pieces rebuild your phrase.")).toBeVisible({
    timeout: 60_000,
  });
  await expect(o.getByRole("heading", { name: "Your spare key is ready" })).toBeVisible({ timeout: 30_000 });
  await o.screenshot({ path: info.outputPath("04-ready.png"), fullPage: true });
  // A passed test stays passed (it is not re-checked after the server marks it done).
  await o.waitForTimeout(6_000);
  await expect(o.getByText("Passed", { exact: true })).toBeVisible();

  // ---- a stranger starts a recovery; the owner sees the alarm everywhere and cancels it
  const { page: x } = await party(browser, problems, "stranger");
  await x.goto("/recover");
  await x.getByLabel("Your @name or address").fill(`@${OWNER}`);
  await x.getByRole("button", { name: "Start recovery" }).click();
  await expect(x.getByRole("heading", { name: `Recovering @${OWNER}` })).toBeVisible({ timeout: 30_000 });
  await nav(o, "Inbox");
  await o.waitForURL("**/app/inbox");
  await expect(
    o.getByRole("alert").filter({ hasText: "Someone is recovering your account on another device." }),
  ).toBeVisible({ timeout: 60_000 });
  await o.screenshot({ path: info.outputPath("05-alarm-bar.png") });
  await o.getByRole("link", { name: "Review and cancel" }).click();
  await o.getByRole("button", { name: "It wasn’t me, cancel it" }).click();
  await expect(o.getByText("Cancelled. Nothing is released to that device.")).toBeVisible({ timeout: 30_000 });
  await x.reload();
  await expect(x.getByText("This recovery was cancelled")).toBeVisible({ timeout: 30_000 });

  // ---- the owner on a new device: request, both contacts answer, 48-hour wait, then restore
  const { page: n } = await party(browser, problems, "new-device");
  await n.goto("/recover");
  await n.getByLabel("Your @name or address").fill("@nobody-here-zz9");
  await n.getByRole("button", { name: "Start recovery" }).click();
  await expect(n.getByText(/has no recovery contacts set up/)).toBeVisible({ timeout: 30_000 });
  // That refusal is a deliberate 404; the browser logs it as a failed load.
  problems.splice(
    0,
    problems.length,
    ...problems.filter((pr) => !(pr.startsWith("[new-device]") && pr.includes("404"))),
  );
  await n.getByLabel("Your @name or address").fill(`@${OWNER}`);
  await n.getByRole("button", { name: "Start recovery" }).click();
  const newWords = await wordsIn(n, "Words for your contacts");
  await n.screenshot({ path: info.outputPath("06-new-device.png"), fullPage: true });
  for (const page of contactPages) await help(page, newWords);
  await n.reload();
  await expect(n.getByText("Waiting 48 hours")).toBeVisible({ timeout: 30_000 });
  await expect(n.getByText(/to go$/)).toBeVisible();
  await n.screenshot({ path: info.outputPath("07-waiting.png"), fullPage: true });
  const reqId = sqlRun(
    `select id from recovery_requests where owner = '${owner.address}' and status = 'waiting' and not test order by created_at desc limit 1`,
  );
  expect(reqId).toMatch(/^rq_/);
  // Pieces are not released before the wait, even to the right secret holder (checked through the page: still waiting).
  sqlRun(`update recovery_requests set release_at = now() - interval '1 second' where id = '${reqId}'`);
  await n.reload();
  await expect(n.getByText("Ready", { exact: true })).toBeVisible({ timeout: 30_000 });
  await n.getByLabel("New passphrase for this device").fill(PASS);
  await n.getByRole("button", { name: "Restore my account here" }).click();
  await n.waitForURL("**/app/spare-key", { timeout: 60_000 });
  await expect(n.getByRole("heading", { name: "Spare key", level: 1 })).toBeVisible();
  expect(sqlRun(`select status from recovery_requests where id = '${reqId}'`)).toBe("done");
  // The restored device signs in as the owner: its own token reads the owner's recovery settings.
  await expect(n.getByRole("heading", { name: "Your spare key is ready" })).toBeVisible({ timeout: 30_000 });
  await n.screenshot({ path: info.outputPath("08-restored.png"), fullPage: true });

  // ---- offline reader: make it, save the sheet, a visitor's message is sealed to it, read it elsewhere
  await o.goto("/app/spare-key");
  await o.getByLabel("Device passphrase").fill(PASS);
  await o.getByRole("button", { name: "Unlock" }).click();
  await o.getByRole("button", { name: "Make an offline reader" }).click();
  await expect(o.getByRole("list", { name: "Offline reader words" }).getByRole("listitem")).toHaveCount(24, {
    timeout: 60_000,
  });
  const offlineWords = (
    await o.getByRole("list", { name: "Offline reader words" }).getByRole("listitem").allInnerTexts()
  ).join(" ");
  expect(offlineWords.split(" ")).toHaveLength(24);
  const dl2 = o.waitForEvent("download");
  await o.getByRole("button", { name: "Save the offline reader sheet" }).click();
  const offlineText = execFileSync("pdftotext", [await (await dl2).path(), "-"], { encoding: "utf8" });
  expect(offlineText).toContain("Offline reader sheet");
  expect(offlineText).toContain(offlineWords.split(" ")[0] ?? "");
  await expect(o.getByText("Offline reader sheet saved.")).toBeVisible({ timeout: 30_000 });
  const msg = `Lease renewal signed ${Date.now()}`;
  const { page: v } = await party(browser, problems, "visitor");
  await v.goto(`/@${OWNER}/message`);
  const sheet = v.getByRole("dialog", { name: /something private/ });
  await sheet.getByLabel("Message").fill(msg);
  await sheet.getByRole("button", { name: "Next" }).click();
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  await expect(v.getByRole("dialog", { name: /^Sealed for/ })).toBeVisible({ timeout: 120_000 });
  const { page: r } = await party(browser, problems, "offline-reader");
  await r.goto("/recover/offline");
  await r.getByLabel("Their @name or address").fill(`@${OWNER}`);
  await r.getByLabel("Offline reader key (24 words)").fill(owner.phrase);
  await r.getByRole("button", { name: "Open what it can read" }).click();
  await expect(r.getByText(/do not open this account's offline reader/)).toBeVisible({ timeout: 30_000 });
  problems.splice(
    0,
    problems.length,
    ...problems.filter((pr) => !(pr.startsWith("[offline-reader]") && pr.includes("403"))),
  );
  await r.getByLabel("Offline reader key (24 words)").fill(offlineWords);
  await r.getByRole("button", { name: "Open what it can read" }).click();
  await r.getByRole("button", { name: new RegExp(msg) }).click();
  await expect(r.getByRole("dialog", { name: "Message" }).getByText(msg)).toBeVisible();
  await r.screenshot({ path: info.outputPath("09-offline-reader.png"), fullPage: true });
});

test("spare key on a phone: page, contacts and the recovery screens fit", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone layout");
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-rec-owner", OWNER);
  await restoreInBrowser(page, owner.phrase);
  await page.goto("/app/spare-key");
  await page.getByLabel("Device passphrase").fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "Spare key", level: 1 })).toBeVisible();
  const fits = async () =>
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
  await fits();
  await page.screenshot({ path: info.outputPath("phone-spare-key.png"), fullPage: true });
  await page.getByRole("tab", { name: /People you help/ }).click();
  await fits();
  for (const path of ["/recover", "/recover/offline"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await fits();
    await page.screenshot({ path: info.outputPath(`phone${path.replace(/\//g, "-")}.png`), fullPage: true });
  }
});
