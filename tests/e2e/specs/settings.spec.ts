/**
 * 5.17 Settings on testnet: names claimed, moved and released on
 * MizuhikiRegistry; passphrase change and the 24 words behind re-auth;
 * notification toggles; a default reader invite; the export zip read back;
 * delete with Undo, then a real delete on a throwaway account; the access
 * window closed on chain.
 * Source of truth: the registry read from QoreChain, the API, the zip's files.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { resolveOnChain, readWindow } from "@mizuhiki/chain";
import { test, expect } from "./fixtures";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-settings";
const READER = "mzk-e2e-setreader";
const GONE = "mzk-e2e-setgone";
const PASS = "lantern river maple tea";
const NEWPASS = "maple river lantern tea two";
test.use({ actionTimeout: 120_000 });

interface Reply<T> {
  status: number;
  body: T;
}
async function call<T>(path: string, token?: string): Promise<Reply<T>> {
  const r = await fetch(`${API}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
}

test("settings: names on chain, security behind re-auth, notifications, a default reader, export, delete with Undo, access window", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "on-chain flow runs once, on desktop");
  test.setTimeout(1_200_000);
  const owner = await ensureOwner("e2e-settings-owner", OWNER);
  await ensureOwner("e2e-settings-reader", READER);
  const token = await apiToken(owner);
  // Start from every notification kind on.
  await fetch(`${API}/owner/notifications`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      prefs: { items: true, payments: true, orders: true, rooms: true, access: true, recovery: true, checkin: true },
    }),
  });
  await restoreInBrowser(page, owner.phrase);
  await page.getByRole("link", { name: "Settings" }).filter({ visible: true }).first().click();
  await page.waitForURL("**/app/settings");
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  await expect(page.getByText("Your page's address")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("01-settings.png"), fullPage: true });

  // ---- names: claim a second, move the page to it, move back, release it
  const second = `mzk-set-${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "Claim another name" }).click();
  const claim = page.getByRole("dialog", { name: "Claim another name" });
  await claim.getByLabel("New name").fill("x");
  await claim.getByRole("button", { name: "Claim it" }).click();
  await expect(claim.getByRole("alert").or(claim.locator("[aria-invalid=true]")).first()).toBeVisible();
  await claim.getByLabel("New name").fill(second);
  await claim.getByRole("button", { name: "Claim it" }).click();
  await expect(page.getByText(`@${second} is yours.`)).toBeVisible({ timeout: 240_000 });
  expect((await resolveOnChain(second)).owner?.toLowerCase()).toBe(owner.evm.toLowerCase());
  const row = page.getByRole("listitem").filter({ hasText: `@${second}` });
  await row.getByRole("button", { name: "Use for my page" }).click();
  await expect(page.getByText(`Your page now lives at @${second}.`)).toBeVisible({ timeout: 240_000 });
  expect((await call(`/pages/${second}`)).status).toBe(200);
  expect((await call(`/pages/${OWNER}`)).status).toBe(410);
  await page
    .getByRole("listitem")
    .filter({ hasText: `@${OWNER}` })
    .getByRole("button", { name: "Use for my page" })
    .click();
  await expect(page.getByText(`Your page now lives at @${OWNER}.`)).toBeVisible({ timeout: 240_000 });
  expect((await call(`/pages/${OWNER}`)).status).toBe(200);
  await page.getByRole("button", { name: `Release @${second}` }).click();
  await page
    .getByRole("dialog", { name: `Release @${second}?` })
    .getByRole("button", { name: "Release" })
    .click();
  await expect(page.getByText(`@${second} is released.`)).toBeVisible({ timeout: 240_000 });
  expect((await resolveOnChain(second)).owner).toBeUndefined();

  // ---- the access window those actions opened, closed on chain
  await page.reload();
  await page.getByLabel("Device passphrase").fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  const win = page.locator("#window");
  await expect(win.getByRole("button", { name: "Close it now" })).toBeVisible({ timeout: 60_000 });
  await win.getByRole("button", { name: "Close it now" }).click();
  await expect(page.getByText("The access window is closed.")).toBeVisible({ timeout: 120_000 });
  expect((await readWindow(owner.address)).live).toBe(false);

  // ---- security: the 24 words only after the passphrase; change it and back
  await page.locator("#security").getByRole("button", { name: "Show" }).click();
  const sheet = page.getByRole("dialog", { name: "Your recovery phrase" });
  await sheet.getByLabel("Device passphrase").fill("not it at all");
  await sheet.getByRole("button", { name: "Show my words" }).click();
  await expect(sheet.getByText("That passphrase is not right. Nothing was shown or changed.")).toBeVisible({
    timeout: 30_000,
  });
  await sheet.getByLabel("Device passphrase").fill(PASS);
  await sheet.getByRole("button", { name: "Show my words" }).click();
  await expect(sheet.getByRole("list", { name: "Recovery phrase" }).getByRole("listitem")).toHaveCount(24, {
    timeout: 30_000,
  });
  const words = (await sheet.getByRole("list", { name: "Recovery phrase" }).getByRole("listitem").allInnerTexts()).join(
    " ",
  );
  expect(words).toBe(owner.phrase);
  await sheet.getByRole("button", { name: "Hide" }).click();
  await page.locator("#security").getByRole("button", { name: "Change" }).click();
  const pw = page.getByRole("dialog", { name: "Change device passphrase" });
  await pw.getByLabel("Current passphrase").fill(PASS);
  await pw.getByLabel("New passphrase").fill(NEWPASS);
  await pw.getByRole("button", { name: "Change passphrase" }).click();
  await expect(page.getByText("Passphrase changed on this device.")).toBeVisible({ timeout: 30_000 });
  await page.locator("#security").getByRole("button", { name: "Lock now" }).click();
  await page.getByLabel("Device passphrase").fill(NEWPASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForURL("**/app/settings");
  await page.locator("#security").getByRole("button", { name: "Change" }).click();
  await pw.getByLabel("Current passphrase").fill(NEWPASS);
  await pw.getByLabel("New passphrase").fill(PASS);
  await pw.getByRole("button", { name: "Change passphrase" }).click();
  await expect(page.getByText("Passphrase changed on this device.")).toBeVisible({ timeout: 30_000 });

  // ---- notifications: per-kind toggles are kept by the server
  const notif = page.locator("#notifications");
  await expect(notif.getByText("This browser", { exact: true })).toBeVisible({ timeout: 30_000 });
  const rooms = notif.getByRole("switch", { name: /Rooms/ });
  await expect(rooms).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
  await rooms.click();
  await expect(rooms).toHaveAttribute("aria-checked", "false");
  await expect
    .poll(async () => (await call<{ prefs: { rooms: boolean } }>("/owner/notifications", token)).body.prefs.rooms)
    .toBe(false);
  await rooms.click();
  await expect(rooms).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await call<{ prefs: { rooms: boolean } }>("/owner/notifications", token)).body.prefs.rooms)
    .toBe(true);

  // ---- readers: a default reader is a pass with no end, over every kind
  const readers = page.locator("#readers");
  await readers.getByRole("button", { name: "Add a default reader" }).click();
  await readers.getByLabel("Their @name or address").fill(`@${READER}`);
  await readers.getByRole("button", { name: "Invite" }).click();
  await page.waitForURL(/\/app\/passes\/pass_/, { timeout: 60_000 });
  await expect(
    page.getByText(
      /^Can read: messages and files, payment notes, form answers and invoices, from .* on\. Cannot read anything else\. Cannot change anything\.$/,
    ),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Cancel invite" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel invite" }).click();
  await expect(page.getByText("The invite is cancelled.")).toBeVisible({ timeout: 30_000 });

  // ---- data: export everything, read the zip back
  await page.getByRole("link", { name: "Settings" }).filter({ visible: true }).first().click();
  await page.waitForURL("**/app/settings");
  const dl = page.waitForEvent("download", { timeout: 300_000 });
  await page.locator("#data").getByRole("button", { name: "Export" }).click();
  const zip = unzipSync(new Uint8Array(await readFile(await (await dl).path())));
  expect(Object.keys(zip)).toContain("page.json");
  expect(JSON.parse(strFromU8(zip["page.json"] ?? new Uint8Array())).name).toBe(OWNER);
  expect(Object.keys(zip)).toContain("passes.json");
  // ---- delete with Undo: nothing is sent
  await page.locator("#data").getByRole("button", { name: "Delete" }).click();
  const del = page.getByRole("dialog", { name: "Delete your page?" });
  await expect(del.getByRole("button", { name: "Delete my page" })).toBeDisabled();
  await del.getByLabel('Type "delete my page" to confirm').fill("delete my page");
  await del.getByRole("button", { name: "Delete my page" }).click();
  await expect(page.getByText(/Deleting in \d+/)).toBeVisible();
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByText("Nothing was deleted.")).toBeVisible();
  await page.waitForTimeout(11_000);
  expect((await call(`/pages/${OWNER}`)).status).toBe(200);
  await page.screenshot({ path: info.outputPath("02-settings-after.png"), fullPage: true });
});

test("settings: export packs large files in a same-origin worker, allowed by the CSP, with every byte", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  test.setTimeout(600_000);
  const owner = await ensureOwner("e2e-visitor", "mzk-e2e-visitor");
  // A visitor sends a file large enough that the zip library would have used a worker (over 160 KB).
  const big = {
    name: `export-check-${Date.now()}.bin`,
    mimeType: "application/octet-stream",
    buffer: randomBytes(400 * 1024),
  };
  const gctx = await browser.newContext();
  const g = await gctx.newPage();
  await g.goto("/@mzk-e2e-visitor/message");
  const sheet = g.getByRole("dialog", { name: /something private/ });
  await sheet.getByLabel("Message").fill("For the export check");
  await sheet.locator('input[type="file"]').setInputFiles(big);
  await sheet.getByRole("button", { name: "Next" }).click();
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  await expect(g.getByText(/Stored for .+, sealed\./)).toBeVisible({ timeout: 180_000 });
  await gctx.close();

  const octx = await browser.newContext({ acceptDownloads: true });
  const o = await octx.newPage();
  const workers: string[] = [];
  o.on("worker", (w) => workers.push(w.url()));
  const csp: string[] = [];
  o.on(
    "console",
    (m) => /Content Security Policy|worker/i.test(m.text()) && m.type() === "error" && csp.push(m.text()),
  );
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: "Settings" }).filter({ visible: true }).first().click();
  await o.waitForURL("**/app/settings");
  const dl = o.waitForEvent("download", { timeout: 300_000 });
  await o.locator("#data").getByRole("button", { name: "Export" }).click();
  const zip = unzipSync(new Uint8Array(await readFile(await (await dl).path())));
  const entry = Object.keys(zip).find((k) => k.endsWith(`/${big.name}`));
  expect(entry).toBeDefined();
  expect(Buffer.from(zip[entry ?? ""] ?? new Uint8Array()).equals(big.buffer)).toBe(true);
  expect(csp).toEqual([]);
  expect(workers.some((u) => u.startsWith("http://localhost:3000/"))).toBe(true);
  await octx.close();
});

test("settings: a real delete removes the page and everything stored, chain stays", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  test.setTimeout(600_000);
  const gone = await ensureOwner("e2e-settings-gone", GONE);
  await restoreInBrowser(page, gone.phrase);
  await page.getByRole("link", { name: "Settings" }).filter({ visible: true }).first().click();
  await page.locator("#data").getByRole("button", { name: "Delete" }).click();
  const del = page.getByRole("dialog", { name: "Delete your page?" });
  await del.getByLabel('Type "delete my page" to confirm').fill("delete my page");
  await del.getByRole("button", { name: "Delete my page" }).click();
  await page.waitForURL((u) => u.pathname === "/", { timeout: 60_000 });
  // The landing page says what happened, once, and the address is tidied; this device holds no key any more.
  await expect(page.getByText("Your page is deleted. What is on QoreChain stays.")).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  expect((await call(`/pages/${GONE}`)).status).toBe(404);
  // No key left on this device: the app asks for the 24 words, not for the device passphrase.
  await page.goto("/app");
  await expect(page.getByRole("heading", { name: "Use your recovery phrase" })).toBeVisible();
  // The name stays on QoreChain.
  expect((await resolveOnChain(GONE)).owner?.toLowerCase()).toBe(gone.evm.toLowerCase());
});

test("settings on a phone: sections stack and fit", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone layout");
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-settings-owner", OWNER);
  await restoreInBrowser(page, owner.phrase);
  await page.goto("/app/settings");
  await page.getByLabel("Device passphrase").fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath("phone-settings.png"), fullPage: true });
  for (const doc of ["privacy", "terms", "report"]) {
    await page.goto(`/legal/${doc}`);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
    ).toBeLessThanOrEqual(0);
  }
});
