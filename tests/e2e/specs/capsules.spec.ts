/**
 * 5.14 Capsules on testnet: owner, guardian and recipient in separate browser
 * contexts.
 * Capsule A (for family after a wait): armed, the guardian requests on chain,
 * the owner rejects, the guardian requests again, the owner cancels.
 * Capsule B: armed, requested, approved now; the guardian's open dashboard
 * hands over the piece by itself; the recipient opens their message and file
 * (bytes compared). Capsule C (if I go quiet): armed, then a check-in recorded
 * on chain.
 * Source of truth: CapsuleVault read from QoreChain after every step; the
 * plan's hash on chain compared with the signed plan the API serves.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { planHash, type CapsulePlan, type Signed } from "@mizuhiki/core";
import { lastCheckInOf, readCapsule } from "@mizuhiki/chain";
import { test, expect } from "./fixtures";
import { PSQL } from "./pg";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const DEV_DB = process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki";

const OWNER = "mzk-e2e-capown";
const GUARD = "mzk-e2e-capgrd";
const RECIP = "mzk-e2e-caprcp";
const PASS = "lantern river maple tea";
const FILE = randomBytes(6000);
// A stuck step fails within two minutes instead of waiting out the whole test.
test.use({ actionTimeout: 120_000 });

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
const unlock = async (page: Page) => {
  await page.getByLabel("Device passphrase").fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
};
const wordsIn = async (page: Page, list: string) => {
  const l = page.getByRole("list", { name: list });
  await expect(l.getByRole("listitem")).toHaveCount(6, { timeout: 30_000 });
  return (await l.getByRole("listitem").allInnerTexts()).join(" ");
};
const chain = (id: string) => readCapsule(`0x${id}`);

/** Owner: steps 1-3 for a new capsule, with the guardian accepting and confirmed. Returns its id. */
async function makeCapsule(
  o: Page,
  g: Page,
  label: string,
  mode: "For family after a wait" | "If I go quiet",
  withFile: boolean,
): Promise<string> {
  // In-app navigation keeps the account unlocked (a full load would lock it).
  await nav(o, "Capsules");
  await o.waitForURL("**/app/capsules");
  await o.getByRole("link", { name: "New capsule" }).first().click();
  await o.getByLabel("Name of the capsule").fill(label);
  await o.waitForURL(/\/app\/capsules\/[0-9a-f]{64}$/, { timeout: 30_000 });
  const id = o.url().split("/").pop() ?? "";
  if (withFile) {
    await o
      .locator('input[type="file"]')
      .setInputFiles({ name: "deeds.pdf", mimeType: "application/pdf", buffer: FILE });
    await expect(o.getByText("deeds.pdf").first()).toBeVisible({ timeout: 60_000 });
  }
  await o.getByLabel("Their @name or address").fill(`@${RECIP}`);
  await o.getByRole("button", { name: "Add", exact: true }).click();
  await expect(o.getByText(`@${RECIP}`, { exact: true })).toBeVisible({ timeout: 30_000 });
  await o.getByLabel(`A message for @${RECIP} (optional)`).fill(`Hana, ${label}: the deeds are in the blue folder.`);
  await o.getByRole("button", { name: "Next", exact: true }).click();
  await o.getByRole("button", { name: mode }).click();
  await o.getByRole("button", { name: "Next", exact: true }).click();
  await o.getByLabel("Guardian's @name or address").fill(`@${GUARD}`);
  await o.getByRole("button", { name: "Invite" }).click();
  await expect(o.getByText(`Invited @${GUARD}.`, { exact: false })).toBeVisible({ timeout: 60_000 });
  // Guardian accepts and reads their words.
  await g.goto("/app/capsules?tab=guard");
  await unlock(g);
  const row = g.getByRole("listitem").filter({ hasText: label });
  await row.getByRole("button", { name: "Accept" }).click();
  const gw = await wordsIn(g, "Your safety words");
  // Owner checks the words and confirms.
  await expect(o.getByRole("button", { name: "Check words" })).toBeVisible({ timeout: 60_000 });
  await o.getByRole("button", { name: "Check words" }).click();
  expect(await wordsIn(o, "Safety words")).toBe(gw);
  await o.getByRole("button", { name: "They match, confirm" }).click();
  await expect(o.getByText(`@${GUARD} is confirmed.`)).toBeVisible({ timeout: 30_000 });
  return id;
}

async function arm(o: Page, info: { outputPath: (n: string) => string }, shot?: string) {
  await o.getByRole("button", { name: /Confirm your plan/ }).click();
  await expect(o.getByRole("list", { name: "Your plan" })).toBeVisible();
  if (shot) await o.screenshot({ path: info.outputPath(shot), fullPage: true });
  await o.getByRole("button", { name: "Confirm and arm" }).click();
  await expect(o.getByText("Armed on QoreChain.")).toBeVisible({ timeout: 240_000 });
}

/** The signed plan the API serves matches the hash CapsuleVault keeps. */
async function planMatchesChain(token: string, id: string, withFile = false) {
  const r = await fetch(`${API}/owner/capsules`, { headers: { authorization: `Bearer ${token}` } });
  const list = (await r.json()) as { capsules: { id: string; plan: Signed<CapsulePlan> | null }[] };
  const plan = list.capsules.find((c) => c.id === id)?.plan?.body;
  expect(plan).toBeTruthy();
  expect(planHash(plan as CapsulePlan).toLowerCase()).toBe((await chain(id)).planHash.toLowerCase());
  // The armed capsule keeps the sealed pieces of its attached file too, not only the envelopes the plan names:
  // a piece nobody holds would be swept a day after upload, long before the capsule opens.
  const p = plan as CapsulePlan;
  const held = Number(
    execFileSync(PSQL, [
      DEV_DB,
      "-At",
      "-c",
      `select count(distinct hash) from blob_holds where purpose = 'capsule:${id}'`,
    ])
      .toString()
      .trim(),
  );
  if (withFile) expect(held).toBeGreaterThan(p.recipients.length + p.pieces.length);
  else expect(held).toBe(p.recipients.length + p.pieces.length);
}

test("capsules: arm with a confirmed guardian; request, reject, request, cancel; a second capsule approved, handed over and opened by the recipient; check in", async ({
  browser,
  problems,
}, info) => {
  test.skip(info.project.name !== "desktop", "three-party on-chain flow runs once, on desktop");
  test.setTimeout(1_500_000);
  const owner = await ensureOwner("e2e-cap-owner", OWNER);
  const guard = await ensureOwner("e2e-cap-guard", GUARD);
  const recip = await ensureOwner("e2e-cap-recip", RECIP);
  const ownerToken = await apiToken(owner);

  const { page: o } = await party(browser, problems, "owner");
  const { page: g } = await party(browser, problems, "guardian");
  const { page: r } = await party(browser, problems, "recipient");
  await restoreInBrowser(o, owner.phrase);
  await restoreInBrowser(g, guard.phrase);
  await restoreInBrowser(r, recip.phrase);
  await nav(o, "Capsules");
  await o.waitForURL("**/app/capsules");
  await expect(o.getByRole("heading", { name: "Capsules", level: 1 })).toBeVisible();
  await o.screenshot({ path: info.outputPath("01-list.png"), fullPage: true });

  // ---- capsule A: after a wait; request, reject, request, cancel
  const labelA = `Family papers ${Date.now().toString(36)}`;
  const a = await makeCapsule(o, g, labelA, "For family after a wait", false);
  await o.screenshot({ path: info.outputPath("02-guardians.png"), fullPage: true });
  await arm(o, info, "03-confirm-plan.png");
  expect((await chain(a)).status).toBe("armed");
  await planMatchesChain(ownerToken, a);
  // Guardian requests on chain.
  await g.goto("/app/capsules?tab=guard");
  await unlock(g);
  await g.getByRole("listitem").filter({ hasText: labelA }).getByRole("button", { name: "Request access" }).click();
  await g.getByRole("dialog").getByRole("button", { name: "Request access" }).click();
  await expect(g.getByText("Requested. The wait has started on QoreChain.")).toBeVisible({ timeout: 180_000 });
  expect((await chain(a)).status).toBe("requested");
  // Owner sees it live and rejects.
  await expect(o.getByRole("heading", { name: "A guardian asked to open it" })).toBeVisible({ timeout: 60_000 });
  await o.screenshot({ path: info.outputPath("04-request-pending.png"), fullPage: true });
  await o.getByRole("button", { name: "Reject" }).click();
  await expect(o.getByText("Rejected. It stays sealed and armed.")).toBeVisible({ timeout: 180_000 });
  const rejected = await chain(a);
  expect(rejected.status).toBe("armed");
  expect(rejected.guardians.map((x) => x.toLowerCase())).toContain(guard.evm.toLowerCase());
  // Requests again; owner cancels.
  await g.reload();
  await unlock(g);
  await g.getByRole("listitem").filter({ hasText: labelA }).getByRole("button", { name: "Request access" }).click();
  await g.getByRole("dialog").getByRole("button", { name: "Request access" }).click();
  await expect(g.getByText("Requested. The wait has started on QoreChain.")).toBeVisible({ timeout: 180_000 });
  await expect(o.getByRole("heading", { name: "A guardian asked to open it" })).toBeVisible({ timeout: 60_000 });
  await o.getByRole("button", { name: "Cancel capsule" }).click();
  await o.getByRole("dialog", { name: "Cancel this capsule?" }).getByRole("button", { name: "Cancel capsule" }).click();
  await expect(o.getByText("Cancelled on QoreChain. It will never open.")).toBeVisible({ timeout: 180_000 });
  expect((await chain(a)).status).toBe("cancelled");
  await r.goto("/app/capsules?tab=for-me");
  await unlock(r);
  await expect(r.getByRole("listitem").filter({ hasText: labelA }).getByText("Cancelled")).toBeVisible({
    timeout: 30_000,
  });

  // ---- capsule B: requested, approved now, handed over by the guardian's open dashboard, opened by the recipient
  const labelB = `Letters ${Date.now().toString(36)}`;
  const b = await makeCapsule(o, g, labelB, "For family after a wait", true);
  await arm(o, info);
  await planMatchesChain(ownerToken, b, true);
  // Before release the recipient sees it sealed, with no Open.
  await r.reload();
  await unlock(r);
  const rRow = r.getByRole("listitem").filter({ hasText: labelB });
  await expect(rRow).toBeVisible({ timeout: 30_000 });
  await expect(rRow.getByRole("button", { name: "Open" })).toHaveCount(0);
  await g.reload();
  await unlock(g);
  await g.getByRole("listitem").filter({ hasText: labelB }).getByRole("button", { name: "Request access" }).click();
  await g.getByRole("dialog").getByRole("button", { name: "Request access" }).click();
  await expect(g.getByText("Requested. The wait has started on QoreChain.")).toBeVisible({ timeout: 180_000 });
  await expect(o.getByRole("heading", { name: "A guardian asked to open it" })).toBeVisible({ timeout: 60_000 });
  await o.getByRole("button", { name: "Approve now" }).click();
  await expect(o.getByText("Released now. Guardians hand over their pieces.")).toBeVisible({ timeout: 180_000 });
  expect((await chain(b)).status).toBe("released");
  // The guardian's dashboard hands the piece over by itself.
  await expect(g.getByText(/piece was handed to its recipient/)).toBeVisible({ timeout: 180_000 });
  await expect(o.getByText("Can open")).toBeVisible({ timeout: 120_000 });
  await o.screenshot({ path: info.outputPath("05-released.png"), fullPage: true });
  // The recipient opens it: the message and the file, byte for byte.
  await r.reload();
  await unlock(r);
  await r.getByRole("listitem").filter({ hasText: labelB }).getByRole("button", { name: "Open" }).click();
  const opened = r.getByRole("dialog", { name: labelB });
  await expect(opened.getByText(`Hana, ${labelB}: the deeds are in the blue folder.`)).toBeVisible({ timeout: 60_000 });
  const dl = r.waitForEvent("download");
  await opened.getByRole("button", { name: "Save" }).click();
  const got = await readFile(await (await dl).path());
  expect(createHash("sha256").update(got).digest("hex")).toBe(createHash("sha256").update(FILE).digest("hex"));
  await r.screenshot({ path: info.outputPath("06-opened.png"), fullPage: true });

  // ---- capsule C: if I go quiet; a check-in is recorded on chain
  const labelC = `If I go quiet ${Date.now().toString(36)}`;
  const c = await makeCapsule(o, g, labelC, "If I go quiet", false);
  await arm(o, info);
  expect((await chain(c)).status).toBe("armed");
  const before = await lastCheckInOf(owner.evm);
  await o.getByRole("button", { name: "I’m here, check in" }).click();
  await expect(o.getByText("Checked in. The quiet clock starts again.")).toBeVisible({ timeout: 180_000 });
  expect(await lastCheckInOf(owner.evm)).toBeGreaterThan(before);
  await o.screenshot({ path: info.outputPath("07-quiet.png"), fullPage: true });
  await nav(o, "Capsules");
  await o.screenshot({ path: info.outputPath("08-list.png"), fullPage: true });
});

test("capsules on a phone: list and the stepper fit", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone layout");
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-cap-owner", OWNER);
  await restoreInBrowser(page, owner.phrase);
  await page.goto("/app/capsules");
  await unlock(page);
  await expect(page.getByRole("heading", { name: "Capsules", level: 1 })).toBeVisible();
  const fits = async () =>
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
  await fits();
  await page.screenshot({ path: info.outputPath("phone-list.png"), fullPage: true });
  const first = page.getByRole("link", { name: /Letters|Family papers|If I go quiet/ }).filter({ visible: true });
  if ((await first.count()) > 0) {
    await first.first().click();
    await expect(page.getByRole("link", { name: "All capsules" })).toBeVisible();
    // Wait for the state read from QoreChain (armed, requested, released or cancelled), or a draft's steps.
    await expect(
      page
        .getByRole("region", { name: "Capsule state" })
        .or(page.getByRole("button", { name: /What and who/ }))
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    await fits();
    await page.screenshot({ path: info.outputPath("phone-capsule.png"), fullPage: true });
  }
});
