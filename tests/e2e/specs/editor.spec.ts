/**
 * 5.2 returning-user paths and 5.3 the editor, as the owner, in a real browser,
 * against the local API and QoreChain testnet. The published page is read back
 * from the API (and its signature checked) after Publish.
 */
import { readFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { verifyRecord, type Manifest, type Signed } from "@mizuhiki/core";
import { pqKeyViaEvm } from "@mizuhiki/chain";
import { API, ensureOwner, restoreInBrowser } from "./owner";

test.describe.configure({ mode: "serial" });
const NAME = "mzk-e2e-editor";

test("returning: restore on a new device, lock, wrong passphrase, unlock, second tab", async ({
  page,
  context,
}, info) => {
  test.skip(info.project.name !== "desktop", "once");
  const owner = await ensureOwner("e2e-editor", NAME);
  // a wrong word first
  await page.goto("/login");
  await page.getByLabel("Recovery phrase").fill(`${owner.phrase.split(" ").slice(0, 23).join(" ")} notaword`);
  await expect(page.getByText(/Not a recovery word: notaword/)).toBeVisible();
  await restoreInBrowser(page, owner.phrase);
  await expect(page.getByRole("heading", { name: "My page" })).toBeVisible();

  // Lock now, then a wrong passphrase, then the right one
  await page.getByRole("button", { name: "Lock now" }).click();
  await page.waitForURL("**/login**");
  await page.getByLabel("Device passphrase").fill("not the passphrase");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("That passphrase did not unlock this device. Nothing changed.")).toBeVisible();
  await page.getByLabel("Device passphrase").fill("lantern river maple tea");
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForURL("**/app");

  // A second tab of the same browser shows "Open elsewhere" and can take over
  const second = await context.newPage();
  await second.goto("/login");
  await expect(second.getByRole("heading", { name: "Open elsewhere" })).toBeVisible();
  await second.getByRole("button", { name: "Use it here instead" }).click();
  await expect(second.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await second.close();
});

test("editor: add, edit, reorder, hide, archive, restore, undo, design, publish", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "once; phone covered below");
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  await restoreInBrowser(page, owner.phrase);
  await expect(page.getByRole("heading", { name: "My page" })).toBeVisible();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  const blocks = page.locator("ol li[data-block]");
  await expect(blocks).toHaveCount(2);

  // Add a link by pasting it into the Add sheet
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "Add" });
  await sheet.getByLabel("Paste a link or search").fill("example.org/portfolio");
  await sheet.getByRole("button", { name: /Add a link to example.org/ }).click();
  await expect(blocks).toHaveCount(3);
  await expect(blocks.first().getByLabel("Title", { exact: true })).toHaveValue("Example");
  await expect(page.getByText("Draft · not published yet")).toBeVisible();

  // Edit the title in place; the preview follows
  await blocks.first().getByLabel("Title", { exact: true }).fill("My portfolio");
  await expect(page.locator("aside").getByText("My portfolio")).toBeVisible();

  // An unfinished text block shows Finish setup and cannot be switched on
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Add" }).getByRole("button", { name: "Text", exact: true }).first().click();
  await expect(blocks.first().getByText(/Finish setup · Write the text/)).toBeVisible();
  await expect(blocks.first().getByRole("switch")).toBeDisabled();
  await blocks.first().getByLabel("Text", { exact: true }).fill("Office hours are Monday to Thursday.");
  await expect(blocks.first().getByRole("switch")).toBeEnabled();
  await blocks.first().getByRole("switch").click();

  // Reorder with the keyboard-friendly menu, then hide a block
  await blocks
    .first()
    .getByRole("button", { name: /More for/ })
    .click();
  await page.getByRole("menuitem", { name: "Move down" }).click();
  await expect(blocks.nth(1).getByLabel("Title", { exact: true })).toHaveValue("A note");
  const pay = blocks.filter({ has: page.locator('input[value="Pay Kinari"]') });
  await pay.getByRole("switch").click();
  await expect(page.locator("aside").getByText("Pay Kinari")).toHaveCount(0);

  // Archive (with Undo), view the archive, restore
  await pay.getByRole("button", { name: /More for/ }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await pay.getByRole("button", { name: "Archive" }).click();
  await expect(blocks).toHaveCount(3);
  await page.getByRole("button", { name: "Undo", exact: true }).last().click();
  await expect(blocks).toHaveCount(4);
  // Each Undo reverses exactly one step: the archive is back, still hidden; the next Undo shows it again.
  await expect(page.locator("aside").getByText("Pay Kinari")).toHaveCount(0);
  await page.getByRole("button", { name: "Undo", exact: true }).first().click();
  await expect(blocks).toHaveCount(4);
  await expect(page.locator("aside").getByText("Pay Kinari")).toHaveCount(1);
  await expect(pay.getByRole("switch")).toHaveAttribute("aria-checked", "true");
  // Hide it again for the rest of the run.
  await pay.getByRole("switch").click();
  await expect(page.locator("aside").getByText("Pay Kinari")).toHaveCount(0);

  // Drag to reorder with the mouse: move the last block to the top
  const handles = page.getByRole("button", { name: /Drag to reorder/ });
  const lastTitle = await blocks.last().getByLabel("Title", { exact: true }).inputValue();
  // Press on the last handle, then drag to the top edge: the page scrolls up under the pointer.
  await handles.last().scrollIntoViewIfNeeded();
  const from = await handles.last().boundingBox();
  if (!from) throw new Error("no drag handle");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, 20, { steps: 10 });
  await expect.poll(async () => (await handles.first().boundingBox())?.y ?? -1).toBeGreaterThan(30);
  const top = await handles.first().boundingBox();
  if (!top) throw new Error("no first handle");
  await page.mouse.move(top.x + top.width / 2, top.y + 2, { steps: 6 });
  await page.mouse.up();
  await expect(blocks.first().getByLabel("Title", { exact: true })).toHaveValue(lastTitle);

  // A collection groups blocks under a heading on the page
  await page.getByRole("button", { name: "Add", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Add" }).getByLabel("Paste a link or search").fill("collection");
  await page
    .getByRole("dialog", { name: "Add" })
    .getByRole("button", { name: /Collection/ })
    .click();
  await blocks.first().getByLabel("Title", { exact: true }).fill("Work");
  const portfolio = blocks.filter({ has: page.locator('input[value="My portfolio"]') });
  await portfolio.getByRole("button", { name: /More for/ }).click();
  await page.getByRole("menuitem", { name: "Edit settings" }).click();
  await portfolio.getByRole("tab", { name: "Layout" }).click();
  await portfolio.getByLabel("Collection").selectOption({ label: "Work" });
  await expect(page.locator("aside").getByRole("heading", { name: "Work" })).toBeVisible();

  // Design: wallpaper, readable-text guard, Save
  await page.getByRole("link", { name: "Design" }).click();
  await expect(page.getByRole("heading", { name: "Design", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Matcha" }).click();
  await expect(page.getByText("Unsaved changes")).toBeVisible();
  await page.getByLabel("Text colour hex").fill("#dcebc8");
  await expect(page.getByText("Text colour changed so it stays readable")).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("design.png") });

  // Publish and check what the API now serves, signature included
  await page.getByRole("link", { name: "Blocks" }).click();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published to/)).toBeVisible();
  const res = (await (await fetch(`${API}/pages/${NAME}`)).json()) as { record: Signed<Manifest> };
  const pq = await pqKeyViaEvm(owner.address);
  const body = verifyRecord(res.record, {
    kind: "manifest",
    signer: owner.address,
    pqPublicKey: pq.publicKey ?? new Uint8Array(),
  });
  expect(body.theme.preset).toBe("matcha");
  expect(body.blocks.map((b) => b.title)).toContain("My portfolio");
  const work = body.blocks.find((b) => b.type === "collection");
  expect(body.blocks.find((b) => b.title === "My portfolio")?.collection).toBe(work?.id);
  expect(body.blocks.find((b) => b.title === "Pay Kinari")?.on).toBe(false);
  await page.screenshot({ path: info.outputPath("editor.png"), fullPage: true });

  // Reload: the sealed draft and published state come back
  await page.reload();
  await page.getByLabel("Device passphrase").fill("lantern river maple tea");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Published", { exact: true })).toBeVisible();
  await expect(blocks).toHaveCount(5);
});

test("two tabs of one account: a page published in one tab is not lost when the other publishes", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(300_000);
  const owner = await ensureOwner("e2e-two-tabs", "mzk-e2e-two-tabs");
  const tab = async () => {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await restoreInBrowser(p, owner.phrase);
    await expect(p.getByRole("heading", { name: "My page" })).toBeVisible();
    return { ctx, p };
  };
  const addLink = async (p: Page, host: string) => {
    await p.getByRole("button", { name: "Add", exact: true }).first().click();
    const sheet = p.getByRole("dialog", { name: "Add" });
    await sheet.getByLabel("Paste a link or search").fill(`${host}/work`);
    await sheet.getByRole("button", { name: new RegExp(`Add a link to ${host.replace(".", "\\.")}`) }).click();
  };
  // Both tabs open the same published page; A publishes first, then B, which loaded before A's change.
  const A = await tab();
  const B = await tab();
  await addLink(A.p, "alpha.example");
  await A.p.getByRole("button", { name: "Publish" }).click();
  await expect(A.p.getByText(/Published to/)).toBeVisible({ timeout: 60_000 });
  await addLink(B.p, "beta.example");
  await B.p.getByRole("button", { name: "Publish" }).click();
  await expect(B.p.getByText(/Published to/)).toBeVisible({ timeout: 60_000 });
  await expect(B.p.getByText(/was not published/)).toHaveCount(0);

  // Source of truth: the published page, signature checked, carries both tabs' links.
  const res = (await (await fetch(`${API}/pages/mzk-e2e-two-tabs`)).json()) as { record: Signed<Manifest> };
  const pq = await pqKeyViaEvm(owner.address);
  const body = verifyRecord(res.record, {
    kind: "manifest",
    signer: owner.address,
    pqPublicKey: pq.publicKey ?? new Uint8Array(),
  });
  const urls = body.blocks.flatMap((b) => ("url" in b ? [b.url] : []));
  expect(urls.some((u) => u.includes("alpha.example"))).toBe(true);
  expect(urls.some((u) => u.includes("beta.example"))).toBe(true);
  // B's own screen shows A's link too, after the publish.
  await expect
    .poll(async () =>
      (
        await B.p
          .locator("ol li[data-block]")
          .getByLabel("Title", { exact: true })
          .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))
      ).join(" | "),
    )
    .toMatch(/Alpha/i);
  await B.p.screenshot({ path: info.outputPath("two-tabs.png"), fullPage: true });
  await A.ctx.close();
  await B.ctx.close();
});

/** A small solid-colour PNG, made here (no image files in the repo). */
function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] ?? 0) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("setup checklist: photo, design, spare-key sheet, share and a block, each through its own action", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(300_000);
  const owner = await ensureOwner("e2e-checklist", "mzk-e2e-checklist");
  const ctx = await browser.newContext({ acceptDownloads: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"]);
  const page = await ctx.newPage();
  await restoreInBrowser(page, owner.phrase);
  const list = page.locator("#checklist");
  const row = (title: string) => list.getByRole("listitem").filter({ hasText: title });

  // Name and photo: the checklist's Add opens Design at the profile; the photo is cropped, uploaded, saved.
  await row("Add your name and photo").getByRole("link", { name: "Add" }).click();
  await page.waitForURL("**/app/design#profile");
  await page
    .locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]')
    .first()
    .setInputFiles({
      name: "aria.png",
      mimeType: "image/png",
      buffer: png(256, 256, [255, 196, 208]),
    });
  await page.getByRole("button", { name: "Use this photo" }).click();
  await expect(page.getByRole("button", { name: "Change profile photo" }).locator("img")).toBeVisible({
    timeout: 30_000,
  });
  // Customise the design: pick a curated theme, then Save.
  await page.getByRole("radiogroup", { name: "Curated themes" }).getByRole("radio").nth(2).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Design saved. Publish when you are ready.")).toBeVisible();

  // Back on My page: the spare-key sheet is a real PDF, saved on this device.
  await page.getByRole("link", { name: "Blocks" }).filter({ visible: true }).first().click();
  await page.waitForURL("**/app");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    row("Create your spare-key sheet").getByRole("button", { name: "Save sheet" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("mizuhiki-spare-key-mzk-e2e-checklist.pdf");
  const sheet = await readFile((await download.path()) ?? "");
  expect(sheet.subarray(0, 5).toString()).toBe("%PDF-");
  // Share copies the page link.
  await row("Share your page").getByRole("button", { name: "Share" }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/@mzk-e2e-checklist$/);
  // Add a block from the checklist.
  await row("Add a block").getByRole("button", { name: "Add" }).click();
  const add = page.getByRole("dialog", { name: "Add" });
  await add.getByLabel("Paste a link or search").fill("example.org/studio");
  await add.getByRole("button", { name: /Add a link to example\.org/ }).click();

  // Five of six done; the sixth is the first sealed item, which only a visitor can bring.
  for (const t of [
    "Add your name and photo",
    "Create your spare-key sheet",
    "Add a block",
    "Customise your design",
    "Share your page",
  ])
    await expect(row(t).getByRole("button", { name: "Skip" })).toHaveCount(0);
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published to/)).toBeVisible({ timeout: 60_000 });
  // Source of truth: the published page carries the photo and the chosen theme.
  const res = (await (await fetch(`${API}/pages/mzk-e2e-checklist`)).json()) as { record: Signed<Manifest> };
  expect(res.record.body.avatar?.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(res.record.body.theme.preset).not.toBe("washi");
  await page.screenshot({ path: info.outputPath("checklist.png"), fullPage: true });
  await ctx.close();
});

test("editor on a phone: layout, preview sheet, no sideways scroll", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone");
  const owner = await ensureOwner("e2e-editor", NAME);
  await restoreInBrowser(page, owner.phrase);
  await expect(page.getByRole("heading", { name: "My page" })).toBeVisible();
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: info.outputPath("editor-phone.png"), fullPage: true });
  await page.getByRole("button", { name: "Preview" }).click();
  await expect(page.getByRole("dialog", { name: "Preview" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("preview-phone.png") });
  await page.getByRole("button", { name: "Close" }).click();
  // phones reach Design through More
  await page.getByRole("navigation", { name: "Owner sections" }).last().getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "Everything" }).getByRole("link", { name: "Design" }).click();
  await expect(page.getByRole("heading", { name: "Design", exact: true })).toBeVisible();
  const [dw, diw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(dw).toBeLessThanOrEqual(diw);
  await page.screenshot({ path: info.outputPath("design-phone.png"), fullPage: true });
});
