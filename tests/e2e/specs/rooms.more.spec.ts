/**
 * 5.10 Rooms, the rest of the life of a room, on testnet with three people in
 * separate contexts: a Family room with a photo and approval off; its invite
 * button on the owner's public page; a visitor taps it and joins, and the
 * owner's device lets them in on its own with past messages shared; approval
 * turned on; a request shows in the owner's Inbox and is declined; make admin,
 * verify keys, transfer ownership (checked on QoreChain), the old owner leaves
 * and the new owner's device changes the key; the room is deleted after an Undo.
 */
import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { readRoom, roleOnChain, ROOM_ROLE } from "@mizuhiki/chain";
import { roomIdBytes32 } from "@mizuhiki/core";
import { parseAddress } from "@qorechain/qoresign";
import { personaPhrase } from "@mizuhiki/testnet";
import { ensureOwner, restoreInBrowser } from "./owner";

// A real 8x8 PNG (sakura pink), so the photo renders as an image after unsealing.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4//8/AwMDAwMDAwAkzwX+8u7AqwAAAABJRU5ErkJggg==",
  "base64",
);

async function party(browser: Browser, problems: string[], tag: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
const nav = (page: Page, label: string) => page.getByRole("link", { name: label }).filter({ visible: true }).first().click();
const sheet = (page: Page) => page.locator("dialog[open]").last();

async function unlockIfAsked(page: Page, ready: RegExp) {
  const unlock = page.getByLabel("Device passphrase");
  await expect(unlock.or(page.getByRole("button", { name: ready }))).toBeVisible({ timeout: 60_000 });
  if (await unlock.isVisible()) {
    await unlock.fill("lantern river maple tea");
    await page.getByRole("button", { name: "Unlock" }).click();
  }
}

test("a family room: page button, automatic admission with history, inbox request, roles, transfer, leave, delete", async ({ browser, problems }, info) => {
  test.skip(info.project.name !== "desktop", "a multi-party run; phone layouts are covered in rooms.spec.ts");
  test.setTimeout(1_200_000);
  await ensureOwner("room-ana", "mzk-room-ana");
  const ben = await ensureOwner("room-ben", "mzk-room-ben");
  await ensureOwner("room-cai", "mzk-room-cai");
  const roomName = `Kapoor family ${Date.now().toString(36)}`;

  // ---- Ana makes a Family room with a photo; approval is off for this kind
  const A = await party(browser, problems, "ana");
  await restoreInBrowser(A.page, personaPhrase("room-ana"));
  await nav(A.page, "Rooms");
  await A.page.getByRole("link", { name: "New room" }).first().click();
  await A.page.getByRole("radio", { name: /Family/ }).click();
  await A.page.getByRole("button", { name: "Next", exact: true }).click();
  await A.page.getByRole("button", { name: "Skip for now" }).click();
  await expect(A.page.getByRole("switch", { name: /Approve new members/ })).not.toBeChecked();
  await A.page.locator("input[type=file][accept^='image/']").setInputFiles({ name: "family.png", mimeType: "image/png", buffer: PNG });
  await A.page.getByLabel("Room name").fill(roomName);
  await A.page.getByRole("button", { name: "Seal and create room" }).click();
  await A.page.waitForURL(/\/app\/rooms\/[0-9a-f]{20}/, { timeout: 180_000 });
  const roomId = /rooms\/([0-9a-f]{20})/.exec(A.page.url())?.[1] ?? "";
  const rid = roomIdBytes32(roomId);
  await expect(A.page.locator("header img").first()).toBeVisible({ timeout: 60_000 }); // the photo, unsealed here
  const box = A.page.getByRole("textbox", { name: "Message" });
  await box.fill("Grandma's recipes are in Files");
  await box.press("Enter");
  await A.page.locator("input[type=file]").last().setInputFiles({ name: "recipes.png", mimeType: "image/png", buffer: PNG });
  await box.press("Enter");
  await expect(A.page.getByRole("article").filter({ has: A.page.getByRole("img", { name: "recipes.png" }) })).toBeVisible({ timeout: 90_000 });

  // ---- The room's invite goes on Ana's public page
  await A.page.getByRole("button", { name: "More" }).click();
  await A.page.getByRole("button", { name: "Invite link" }).click();
  await expect(sheet(A.page).locator("code").filter({ hasText: "/join/" })).toBeVisible({ timeout: 60_000 });
  const inviteUrl = (await sheet(A.page).locator("code").filter({ hasText: "/join/" }).textContent()) ?? "";
  await sheet(A.page).getByRole("button", { name: "Add to my page" }).click();
  await expect(sheet(A.page).getByText(/is on your page and live/)).toBeVisible({ timeout: 120_000 });
  await A.page.keyboard.press("Escape");

  // ---- Ben finds it on Ana's page, taps it, and joins; Ana's open room lets him in with past messages
  const B = await party(browser, problems, "ben");
  await restoreInBrowser(B.page, personaPhrase("room-ben"));
  await B.page.goto(`/@mzk-room-ana`);
  await B.page.getByRole("button", { name: `Join ${roomName}` }).click();
  await expect(sheet(B.page).locator("b").filter({ hasText: roomName })).toBeVisible({ timeout: 60_000 });
  await sheet(B.page).getByRole("button", { name: "Join", exact: true }).click();
  await B.page.waitForURL(/\/join\//);
  await unlockIfAsked(B.page, /^Join$/);
  await B.page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(B.page.getByRole("heading", { name: "You’re in" })).toBeVisible({ timeout: 240_000 });
  await expect(A.page.getByText(/Room key updated\. @mzk-room-ben joined, history shared\./)).toBeVisible({ timeout: 60_000 });
  expect((await readRoom(rid)).epoch).toBe(2n);
  await B.page.getByRole("link", { name: /Open the room/ }).or(B.page.getByRole("button", { name: /Open the room/ })).first().click();
  await expect(B.page.getByRole("article").filter({ hasText: "Grandma's recipes are in Files" })).toBeVisible({ timeout: 90_000 });
  await expect(B.page.getByRole("img", { name: "recipes.png" })).toBeVisible({ timeout: 60_000 });
  await B.page.screenshot({ path: info.outputPath("1-ben-history-shared.png"), animations: "disabled" });

  // ---- Ana turns approval on; Cai's request shows in her Inbox and she declines it
  await A.page.getByRole("button", { name: "Room info" }).first().click();
  const panelA = A.page.locator("aside[aria-label='Room info']");
  await panelA.getByRole("switch", { name: /Approve new members/ }).click();
  await panelA.getByRole("button", { name: "Save settings" }).click();
  await expect(A.page.getByText("Settings saved. The room was told.")).toBeVisible({ timeout: 60_000 });

  const C = await party(browser, problems, "cai");
  await restoreInBrowser(C.page, personaPhrase("room-cai"));
  await C.page.goto(new URL(inviteUrl).pathname + new URL(inviteUrl).hash);
  await unlockIfAsked(C.page, /Ask to join/);
  await C.page.getByRole("button", { name: "Ask to join" }).click();
  await expect(C.page.getByRole("heading", { name: "Waiting for an admin to let you in" })).toBeVisible({ timeout: 60_000 });

  await nav(A.page, "Inbox");
  await A.page.getByText("Asked to join one of your rooms · tap to review").first().click();
  await expect(A.page.getByText(new RegExp(`asked to join .${roomName}.`))).toBeVisible({ timeout: 30_000 });
  await A.page.screenshot({ path: info.outputPath("2-ana-inbox-request.png"), animations: "disabled" });
  await A.page.getByRole("link", { name: "Review in the room" }).click();
  await A.page.waitForURL(`**/app/rooms/${roomId}`);
  await A.page.getByRole("button", { name: /1 person asked to join/ }).click();
  await A.page.locator("aside[aria-label='Room info']").getByRole("button", { name: "Decline" }).click();
  await expect(A.page.getByText(/Declined\. @mzk-room-cai was not let in and got no key\./)).toBeVisible({ timeout: 60_000 });
  await expect(C.page.getByText(/declined/i).first()).toBeVisible({ timeout: 90_000 });
  expect((await readRoom(rid)).epoch).toBe(2n); // nothing was sealed to Cai

  // ---- Ana makes Ben an admin, checks his safety words, and hands him the room
  const panel = A.page.locator("aside[aria-label='Room info']");
  await panel.getByRole("button", { name: /mzk-room-ben/ }).first().click();
  await sheet(A.page).getByRole("button", { name: /Verify keys/ }).click();
  await sheet(A.page).getByRole("button", { name: "Mark as verified" }).click();
  await expect(sheet(A.page).getByText("Marked as verified on this device.")).toBeVisible({ timeout: 30_000 });
  await A.page.keyboard.press("Escape");
  await expect(panel.getByText(/Verified/).first()).toBeVisible({ timeout: 30_000 });
  await panel.getByRole("button", { name: /mzk-room-ben/ }).first().click();
  await sheet(A.page).getByRole("button", { name: /Make admin/ }).click();
  await sheet(A.page).getByRole("button", { name: "Make admin" }).click();
  await expect(panel.getByText("Admin", { exact: true }).first()).toBeVisible({ timeout: 180_000 });
  expect(await roleOnChain(rid, parseAddress(ben.address).hex as `0x${string}`)).toBe(ROOM_ROLE.admin);

  await panel.getByRole("button", { name: "Transfer ownership" }).click();
  await sheet(A.page).getByRole("radio", { name: /mzk-room-ben/ }).click();
  await sheet(A.page).getByLabel("Type the room name to confirm").fill(roomName);
  await sheet(A.page).getByRole("button", { name: "Transfer ownership" }).click();
  await expect(A.page.getByText(/made @mzk-room-ben the owner/)).toBeVisible({ timeout: 180_000 });
  expect((await readRoom(rid)).owner?.toLowerCase()).toBe(parseAddress(ben.address).hex.toLowerCase());

  // ---- Ana leaves; Ben's device (the owner now) changes the key so she cannot read anything new
  await panel.getByRole("button", { name: "Leave room" }).click();
  await sheet(A.page).getByRole("button", { name: "Leave room" }).click();
  await A.page.waitForURL("**/app/rooms", { timeout: 60_000 });
  await expect(B.page.getByText(/Room key updated\. @mzk-room-ana left and cannot read new messages\./)).toBeVisible({ timeout: 240_000 });
  expect((await readRoom(rid)).epoch).toBe(3n);

  // ---- Ben deletes the room: Undo keeps it, then it is closed on QoreChain and leaves everyone's list
  await B.page.getByRole("button", { name: "Room info" }).first().click();
  const panelB = B.page.locator("aside[aria-label='Room info']");
  await panelB.getByRole("tab", { name: /Files/ }).click();
  const thumb = panelB.getByRole("button", { name: "Open photo recipes.png" }).locator("img");
  await expect(thumb).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => thumb.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBeGreaterThan(0); // unsealed and decoded
  await B.page.screenshot({ path: info.outputPath("3-ben-files.png"), animations: "disabled" });
  await panelB.getByRole("button", { name: "Delete room" }).click();
  await sheet(B.page).getByRole("checkbox", { name: "Delete the room for all members" }).check();
  await sheet(B.page).getByRole("button", { name: "Delete room" }).click();
  await B.page.getByRole("button", { name: "Undo" }).first().click();
  await expect(B.page.getByText("Not deleted. Nothing was sent.")).toBeVisible();
  expect((await readRoom(rid)).closed).toBe(false);
  await panelB.getByRole("button", { name: "Delete room" }).click();
  await sheet(B.page).getByRole("checkbox", { name: "Delete the room for all members" }).check();
  await sheet(B.page).getByRole("button", { name: "Delete room" }).click();
  await B.page.waitForURL("**/app/rooms", { timeout: 180_000 });
  expect((await readRoom(rid)).closed).toBe(true);
  await expect(B.page.getByRole("link", { name: new RegExp(roomName) })).toHaveCount(0);

  for (const x of [A, B, C]) await x.ctx.close();
});
