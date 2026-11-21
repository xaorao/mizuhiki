/**
 * 5.10 Rooms on testnet, three people in separate browser contexts (QA guide
 * Part 5.13): the owner creates a Deal room with a member through the UI,
 * both chat (mention, reply, reaction, pin, a sealed file), a third person
 * asks to join with the invite link and is approved with "Only new messages",
 * then the member is removed. Source of truth after every step: the room
 * record on QoreChain (epoch, membership hash), the relay's per-person views,
 * and the keys each person can open.
 */
import { test, expect } from "./fixtures";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { readRoom } from "@mizuhiki/chain";
import { membershipHash, roomIdBytes32 } from "@mizuhiki/core";
import { personaPhrase } from "@mizuhiki/testnet";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

type Person = Awaited<ReturnType<typeof ensureOwner>>;
/** API requests made by the browsers in this test, by route: the budget a real session spends. */
const traffic = new Map<string, number>();
test.afterAll(() => {
  const rows = [...traffic.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`API requests from the browsers: ${rows.reduce((n, r) => n + r[1], 0)}`);
  for (const [k, n] of rows.slice(0, 25)) console.log(`${String(n).padStart(5)}  ${k}`);
});

async function party(
  browser: Browser,
  problems: string[],
  tag: string,
  phone = false,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(
    phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }
      : { viewport: { width: 1440, height: 900 } },
  );
  const page = await ctx.newPage();
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.port !== "4000") return;
    const key = `${r.method()} ${u.pathname.replace(/[0-9a-f]{20,64}/g, ":id").replace(/qor1[0-9a-z]{38}/g, ":addr")}`;
    traffic.set(key, (traffic.get(key) ?? 0) + 1);
  });
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

// One API session per person: signing in again for every check would trip the per-account sign-in limit.
const tokens = new Map<string, Promise<string>>();
const tokenFor = (p: Person) => {
  let t = tokens.get(p.address);
  if (!t) {
    t = apiToken(p);
    tokens.set(p.address, t);
  }
  return t;
};
async function asApi<T>(p: Person, path: string): Promise<T> {
  const r = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${await tokenFor(p)}` } });
  if (!r.ok) throw new Error(`${path} answered ${r.status}: ${await r.text()}`);
  return (await r.json()) as T;
}

/** Client-side navigation keeps the account unlocked (keys live in memory). */
async function nav(page: Page, label: string) {
  await page.getByRole("link", { name: label }).filter({ visible: true }).first().click();
}

test("a deal room: create, chat, invite with approval, remove, all checked against QoreChain", async ({
  browser,
  problems,
}, info) => {
  test.skip(info.project.name !== "desktop", "one run covers every party; the phone layout is checked inside it");
  test.setTimeout(900_000);
  const ana: Person = await ensureOwner("room-ana", "mzk-room-ana");
  const ben: Person = await ensureOwner("room-ben", "mzk-room-ben");
  const cai: Person = await ensureOwner("room-cai", "mzk-room-cai");
  const roomName = `Northwind deal ${Date.now().toString(36)}`;

  // ---- Ana creates a Deal room with Ben
  const A = await party(browser, problems, "ana");
  await restoreInBrowser(A.page, personaPhrase("room-ana"));
  await nav(A.page, "Rooms");
  await A.page.waitForURL("**/app/rooms");
  await A.page.getByRole("link", { name: "New room" }).first().click();
  await A.page.getByRole("radio", { name: /Deal/ }).click();
  await A.page.getByRole("button", { name: "Next", exact: true }).click();
  await A.page.getByLabel("Add people").fill("@mzk-room-ben");
  await A.page.getByRole("button", { name: /@mzk-room-ben/ }).click();
  await expect(A.page.getByRole("list", { name: "Chosen people" })).toContainText("@mzk-room-ben");
  await A.page.getByRole("button", { name: /Next · 2 people/ }).click();
  await expect(A.page.getByRole("switch", { name: /Approve new members/ })).toBeChecked();
  await A.page.getByLabel("Room name").fill(roomName);
  await A.page.getByRole("button", { name: "Seal and create room" }).click();
  await A.page.waitForURL(/\/app\/rooms\/[0-9a-f]{20}\?new=1/, { timeout: 180_000 });
  const roomId = /rooms\/([0-9a-f]{20})/.exec(A.page.url())?.[1] ?? "";
  await expect(A.page.getByText("You created this room")).toBeVisible({ timeout: 60_000 });
  await expect(
    A.page.getByText("Messages and files are sealed to the people in this room.", { exact: false }),
  ).toBeVisible();
  await expect(A.page.getByText("Key 1")).toBeVisible();
  await A.page.screenshot({ path: info.outputPath("1-created.png"), animations: "disabled" });

  // Source of truth: QoreChain has the room, epoch 1, both members hashed.
  const rid = roomIdBytes32(roomId);
  let chain = await readRoom(rid);
  expect(chain.epoch).toBe(1n);
  expect(chain.membershipHash).toBe(membershipHash(roomId, 1n, [{ address: ana.address }, { address: ben.address }]));

  // ---- Ana writes; Ben reads, replies with a mention, reacts
  const box = A.page.getByRole("textbox", { name: "Message" });
  await box.fill("Term sheet v4 is in. Changes are on page 2.");
  await box.press("Enter");
  await expect(A.page.getByRole("article").filter({ hasText: "Term sheet v4 is in" })).toBeVisible({ timeout: 60_000 });

  const B = await party(browser, problems, "ben");
  await restoreInBrowser(B.page, personaPhrase("room-ben"));
  await nav(B.page, "Rooms");
  const row = B.page.getByRole("link", { name: new RegExp(roomName) });
  await expect(row).toBeVisible({ timeout: 60_000 });
  await expect(row).toContainText("Term sheet v4");
  await row.click();
  const anaLine = B.page.getByRole("article", { name: /^@mzk-room-ana,/ }).filter({ hasText: "Term sheet v4 is in" });
  await expect(anaLine).toBeVisible({ timeout: 60_000 });
  await expect(anaLine).toContainText("@mzk-room-ana");
  await anaLine.click({ button: "right" });
  await B.page.getByRole("button", { name: "👍" }).click();
  await expect(B.page.getByRole("button", { name: /👍 1/ })).toBeVisible({ timeout: 60_000 });
  await anaLine.click({ button: "right" });
  await B.page.getByRole("button", { name: "Reply" }).click();
  await expect(B.page.getByText("Replying to @mzk-room-ana")).toBeVisible();
  const bBox = B.page.getByRole("textbox", { name: "Message" });
  await bBox.fill("Looks good @mzk-room-a");
  await B.page.getByRole("option", { name: /mzk-room-ana/ }).click();
  await bBox.pressSequentially("signing tonight.");
  await bBox.press("Enter");
  const benLine = A.page.getByRole("article").filter({ hasText: "signing tonight" });
  await expect(benLine).toBeVisible({ timeout: 60_000 });
  await expect(benLine).toContainText("Term sheet v4"); // the reply quote
  await expect(benLine.locator("[data-me]")).toHaveText("@mzk-room-ana"); // mention of Ana, highlighted for her
  await expect(A.page.getByRole("button", { name: /👍 1/ })).toBeVisible();

  // A sealed file from Ana opens for Ben with the same bytes.
  await A.page
    .locator("input[type=file]")
    .last()
    .setInputFiles({
      name: "cap-table.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("holder,shares\nana,600\nben,400\n"),
    });
  await box.fill("Cap table attached");
  await box.press("Enter");
  const fileLine = B.page.getByRole("article").filter({ hasText: "cap-table.csv" });
  await expect(fileLine).toBeVisible({ timeout: 90_000 });
  const dl = B.page.waitForEvent("download");
  await fileLine.getByRole("button", { name: /cap-table.csv/ }).click();
  const file = await dl;
  const bytes = await (await file.createReadStream()).toArray();
  expect(Buffer.concat(bytes).toString()).toBe("holder,shares\nana,600\nben,400\n");

  // Ana pins her message; Ben sees the pinned bar.
  await A.page
    .getByRole("article", { name: /^You,/ })
    .filter({ hasText: "Term sheet v4 is in" })
    .click({ button: "right" });
  await A.page.getByRole("button", { name: "Pin for everyone" }).click();
  await expect(B.page.getByRole("button", { name: /Pinned.*Term sheet v4/ })).toBeVisible({ timeout: 60_000 });
  await B.page.screenshot({ path: info.outputPath("2-ben-chat.png"), animations: "disabled" });

  // ---- Cai asks to join with the main invite link; Ana approves with "Only new messages"
  await A.page.getByRole("button", { name: "More" }).click();
  await A.page.getByRole("button", { name: "Invite link" }).click();
  const code = A.page.locator("code").filter({ hasText: "/join/" }).first();
  await expect(code).toBeVisible({ timeout: 60_000 });
  const inviteUrl = (await code.textContent()) ?? "";
  expect(inviteUrl).toMatch(/\/join\/[0-9a-f]{20}#k=[A-Za-z0-9_-]{43}$/);
  await A.page.screenshot({ path: info.outputPath("3-invite.png"), animations: "disabled" });
  await A.page.keyboard.press("Escape");

  const C = await party(browser, problems, "cai");
  await restoreInBrowser(C.page, personaPhrase("room-cai"));
  await C.page.goto(new URL(inviteUrl).pathname + new URL(inviteUrl).hash);
  // A full page load locks the account, so the join page asks to unlock first (or is ready to join).
  const unlock = C.page.getByLabel("Device passphrase");
  await expect(unlock.or(C.page.getByRole("button", { name: "Ask to join" }))).toBeVisible({ timeout: 60_000 });
  if (await unlock.isVisible()) {
    await unlock.fill("lantern river maple tea");
    await C.page.getByRole("button", { name: "Unlock" }).click();
  }
  await expect(C.page.getByRole("heading", { name: roomName })).toBeVisible({ timeout: 60_000 });
  await C.page.getByRole("button", { name: "Ask to join" }).click();
  await expect(C.page.getByRole("heading", { name: "Waiting for an admin to let you in" })).toBeVisible({
    timeout: 60_000,
  });
  await C.page.screenshot({ path: info.outputPath("4-cai-waiting.png"), animations: "disabled" });

  // Nothing is shared before approval: Cai has no key and sees no messages.
  const caiEarly = await fetch(`${API}/rooms/${roomId}/keys`, {
    headers: { authorization: `Bearer ${await tokenFor(cai)}` },
  });
  expect(caiEarly.status).toBe(404);

  await expect(A.page.getByRole("button", { name: /1 person asked to join/ })).toBeVisible({ timeout: 60_000 });
  await A.page.getByRole("button", { name: /1 person asked to join/ }).click();
  await A.page.getByRole("button", { name: "Approve" }).first().click();
  const approve = A.page.locator("dialog[open]").last();
  await approve.getByRole("radio", { name: /Only new messages/ }).click();
  await approve.getByRole("button", { name: "Approve" }).click();
  await expect(A.page.getByText(/Room key updated\. @mzk-room-cai joined, history not shared\./)).toBeVisible({
    timeout: 240_000,
  });
  chain = await readRoom(rid);
  expect(chain.epoch).toBe(2n);

  await expect(C.page.getByRole("heading", { name: "You’re in" })).toBeVisible({ timeout: 120_000 });
  await C.page
    .getByRole("link", { name: /Open the room/ })
    .or(C.page.getByRole("button", { name: /Open the room/ }))
    .first()
    .click();
  await C.page.waitForURL(`**/app/rooms/${roomId}`);
  await expect(C.page.getByText(/Room key updated\. You joined, history not shared\./)).toBeVisible({
    timeout: 90_000,
  });
  // History hidden: the messages from before Cai joined are not served or readable.
  await expect(C.page.getByText("Term sheet v4 is in")).toHaveCount(0);
  const caiKeys = await asApi<{ epochs: { epoch: number }[]; history: unknown[] }>(cai, `/rooms/${roomId}/keys`);
  expect(caiKeys.epochs.map((e) => e.epoch)).toEqual([2]);
  expect(caiKeys.history).toEqual([]);

  // ---- Ana removes Ben; Ben cannot read anything new
  await A.page
    .getByRole("tab", { name: "Members" })
    .click()
    .catch(() => undefined);
  await A.page
    .locator("aside[aria-label='Room info']")
    .getByRole("button", { name: /mzk-room-ben/ })
    .first()
    .click();
  await A.page.getByRole("button", { name: /^Remove from room/ }).click();
  await expect(
    A.page.getByText(/loses access to new messages now\. The room key changes\. They keep what they already saw\./),
  ).toBeVisible();
  await A.page.getByRole("button", { name: /Remove @mzk-room-ben/ }).click();
  await expect(
    A.page.getByText(/Room key updated\. @mzk-room-ben was removed and cannot read new messages\./),
  ).toBeVisible({ timeout: 240_000 });
  chain = await readRoom(rid);
  expect(chain.epoch).toBe(3n);
  expect(chain.membershipHash).toBe(membershipHash(roomId, 3n, [{ address: ana.address }, { address: cai.address }]));

  // Ana's device checked the member list against QoreChain after the change.
  const panel = A.page.locator("aside[aria-label='Room info']");
  await panel.getByRole("button", { name: /Sealing/ }).click();
  await expect(panel.getByText("Checked on this device against the record on QoreChain. It matches.")).toBeVisible({
    timeout: 60_000,
  });
  await A.page
    .getByRole("button", { name: "Close" })
    .first()
    .click()
    .catch(() => undefined);
  await box.fill("Final numbers after Ben left");
  await box.press("Enter");
  await expect(C.page.getByRole("article").filter({ hasText: "Final numbers after Ben left" })).toBeVisible({
    timeout: 90_000,
  });

  await expect(B.page.getByText(/You were removed from this room\. You keep what you already saw/)).toBeVisible({
    timeout: 90_000,
  });
  await expect(B.page.getByRole("link", { name: new RegExp(roomName) })).toContainText(
    "You were removed from this room",
  );
  await expect(B.page.getByText("Final numbers after Ben left")).toHaveCount(0);
  await expect(
    B.page.getByRole("article", { name: /^@mzk-room-ana,/ }).filter({ hasText: "Term sheet v4 is in" }),
  ).toBeVisible(); // keeps what he saw
  const benKeys = await asApi<{ epochs: { epoch: number }[] }>(ben, `/rooms/${roomId}/keys`);
  expect(benKeys.epochs.map((e) => e.epoch)).toEqual([1, 2]);
  const benFeed = await asApi<{ batches: { epoch: number }[] }>(ben, `/rooms/${roomId}/batches`);
  expect(benFeed.batches.every((b) => b.epoch <= 2)).toBe(true);
  await B.page.screenshot({ path: info.outputPath("5-ben-removed.png"), animations: "disabled" });
  await A.page.screenshot({ path: info.outputPath("6-ana-after.png"), animations: "disabled" });

  // ---- The same room on a phone (Cai)
  const P = await party(browser, problems, "cai-phone", true);
  await restoreInBrowser(P.page, personaPhrase("room-cai"));
  await nav(P.page, "Rooms");
  await P.page.screenshot({ path: info.outputPath("7-phone-list.png"), animations: "disabled" });
  await P.page.getByRole("link", { name: new RegExp(roomName) }).click();
  await expect(P.page.getByRole("article").filter({ hasText: "Final numbers after Ben left" })).toBeVisible({
    timeout: 90_000,
  });
  await P.page.screenshot({ path: info.outputPath("8-phone-chat.png"), animations: "disabled" });

  for (const x of [A, B, C, P]) await x.ctx.close();
});
