/**
 * Real activity on the demo account @aria, made through the product's own
 * screens on testnet, so the landing's app tour shows real screens (spec 5.1
 * section 9): visitors' sealed messages (one with a PDF, one signed by
 * @mila.cpa), a Deal room with @maya.studio, an active pass for @mila.cpa, and
 * an armed "if I go quiet" capsule for @kapoor.family guarded by @rohan.law.
 * Each step runs once; its result is kept in var/demo-content.json.
 * Run: pnpm --filter @mizuhiki/e2e demo:content (after tools/demo-seed.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Browser, Page } from "@playwright/test";
import { ensurePersona, personaPhrase } from "@mizuhiki/testnet";
import { test, expect } from "../specs/fixtures";
import { API, apiToken, restoreInBrowser } from "../specs/owner";

const STATE = resolve(import.meta.dirname, "../../../var/demo-content.json");
type State = { messages?: boolean; room?: string; pass?: string; capsule?: string; capsuleDraft?: string };
const load = (): State => (existsSync(STATE) ? (JSON.parse(readFileSync(STATE, "utf8")) as State) : {});
const save = (s: State) => writeFileSync(STATE, JSON.stringify(s, null, 2));
const PASS = "lantern river maple tea";

/** A small, valid one-page PDF. */
function pdf(title: string): Buffer {
  const text = `BT /F1 18 Tf 72 720 Td (${title}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function as(browser: Browser, label: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await restoreInBrowser(page, personaPhrase(label));
  return page;
}
const nav = (page: Page, label: string) =>
  page.getByRole("link", { name: label }).filter({ visible: true }).first().click();
async function unlock(page: Page) {
  // A full load locks the account: wait for the lock screen, then unlock.
  const box = page.getByLabel("Device passphrase");
  await expect(box).toBeVisible({ timeout: 60_000 });
  await box.fill(PASS);
  await page.getByRole("button", { name: "Unlock" }).click();
}
async function words(page: Page, list: string): Promise<string> {
  const l = page.getByRole("list", { name: list }).getByRole("listitem");
  await expect(l).toHaveCount(6, { timeout: 60_000 });
  return (await l.allInnerTexts()).join(" ");
}

test.use({ actionTimeout: 120_000 });

test("demo content on @aria", async ({ browser }) => {
  test.setTimeout(1_800_000);
  const s = load();

  if (!s.messages) {
    // Two visitors with no account, from a normal browser.
    for (const m of [
      {
        text: "Here's the brief for the spring packaging and our signed contract. Deposit to follow this week.",
        contact: "Leaf & Kettle Tea · hello@leafkettle.co",
        file: {
          name: "contract_v3.pdf",
          mimeType: "application/pdf",
          buffer: pdf("Leaf & Kettle Tea - design contract v3"),
        },
      },
      { text: "Loved the deck. Two small notes on page 3, nothing urgent.", contact: "Jun, Northwind", file: null },
    ]) {
      const ctx = await browser.newContext();
      const v = await ctx.newPage();
      await v.goto("/@aria/message");
      const sheet = v.getByRole("dialog", { name: "Send Aria something private" });
      await sheet.getByLabel("Message").fill(m.text);
      if (m.file) await sheet.locator('input[type="file"]').setInputFiles(m.file);
      await sheet.getByRole("button", { name: "Next" }).click();
      await sheet.getByLabel("Your name or how to reach you (optional)").fill(m.contact);
      await sheet.getByRole("button", { name: "Seal and send" }).click();
      await expect(v.getByRole("dialog", { name: "Sealed for Aria" })).toBeVisible({ timeout: 180_000 });
      await ctx.close();
    }
    // @mila.cpa, signed with her own key.
    const mila = await as(browser, "demo-mila");
    await mila.goto("/@aria/message");
    const sheet = mila.getByRole("dialog", { name: "Send Aria something private" });
    await sheet.getByLabel("Message").fill("Q4 receipts checklist attached. Send the rest when you can.");
    await sheet
      .locator('input[type="file"]')
      .setInputFiles({ name: "q4-checklist.pdf", mimeType: "application/pdf", buffer: pdf("Q4 receipts checklist") });
    await sheet.getByRole("button", { name: "Next" }).click();
    await sheet.getByRole("radio", { name: /Signed as you \(unlock first\)/ }).click();
    await sheet.getByLabel("Device passphrase").fill(PASS);
    await sheet.getByRole("button", { name: "Unlock to sign" }).click();
    await expect(sheet.getByRole("radio", { name: /^Signed as you/ })).toHaveAttribute("aria-checked", "true");
    await sheet.getByRole("button", { name: "Seal and send" }).click();
    await expect(mila.getByRole("dialog", { name: "Sealed for Aria" })).toBeVisible({ timeout: 180_000 });
    await mila.context().close();
    s.messages = true;
    save(s);
  }

  const aria = await as(browser, "demo-aria");

  if (!s.room) {
    await nav(aria, "Rooms");
    await aria.waitForURL("**/app/rooms");
    await aria.getByRole("link", { name: "New room" }).first().click();
    await aria.getByRole("radio", { name: /Deal/ }).click();
    await aria.getByRole("button", { name: "Next", exact: true }).click();
    await aria.getByLabel("Add people").fill("@maya.studio");
    await aria.getByRole("button", { name: /@maya\.studio/ }).click();
    await aria.getByRole("button", { name: /Next · 2 people/ }).click();
    await aria.getByLabel("Room name").fill("Spring launch");
    await aria.getByRole("button", { name: "Seal and create room" }).click();
    await aria.waitForURL(/\/app\/rooms\/[0-9a-f]{20}\?new=1/, { timeout: 240_000 });
    s.room = /rooms\/([0-9a-f]{20})/.exec(aria.url())?.[1] ?? "";
    save(s);
    const box = aria.getByRole("textbox", { name: "Message" });
    await box.fill("Packaging v4 is in. Changes are on page 2.");
    await box.press("Enter");
    await expect(aria.getByRole("article").filter({ hasText: "Packaging v4 is in" })).toBeVisible({ timeout: 60_000 });
    const maya = await as(browser, "demo-maya");
    await nav(maya, "Rooms");
    await maya.getByRole("link", { name: /Spring launch/ }).click();
    const mbox = maya.getByRole("textbox", { name: "Message" });
    await mbox.fill("Looks great. Photos for the shoot are in Files now.");
    await mbox.press("Enter");
    await expect(maya.getByRole("article").filter({ hasText: "Photos for the shoot" })).toBeVisible({
      timeout: 60_000,
    });
    await maya.context().close();
  }

  if (!s.pass) {
    await nav(aria, "Passes");
    await aria.waitForURL("**/app/passes");
    await aria.getByRole("button", { name: "New pass" }).first().click();
    const sheet = aria.getByRole("dialog", { name: "New pass" });
    await sheet.getByLabel("Their @name or address").fill("@mila.cpa");
    await sheet.getByLabel("Note for them (optional)").click();
    await expect(sheet.getByText("@mila.cpa", { exact: true })).toBeVisible({ timeout: 30_000 });
    const now = new Date();
    await sheet
      .getByRole("radio", { name: `Q${Math.floor(now.getUTCMonth() / 3) + 1} ${now.getUTCFullYear()}` })
      .click();
    await sheet.getByRole("button", { name: "Messages and files" }).click();
    await sheet.getByRole("radio", { name: "Until the period ends" }).click();
    await sheet.getByLabel("Note for them (optional)").fill("Here is this quarter for the VAT return.");
    await sheet.getByRole("button", { name: "Send invite" }).click();
    await aria.waitForURL(/\/app\/passes\/pass_/);
    s.pass = aria.url().split("/").pop() ?? "";
    save(s);
    const mila = await as(browser, "demo-mila");
    await nav(mila, "Passes");
    await mila.getByRole("tab", { name: /Shared with me/ }).click();
    await mila.locator(`a[href="/app/passes/${s.pass}"]`).click();
    await mila.getByRole("button", { name: "Accept" }).click();
    const mw = await words(mila, "Your safety words");
    expect(await words(aria, "Safety words")).toBe(mw);
    await aria.getByRole("button", { name: "They match, confirm" }).click();
    await expect(aria.getByText("The pass is active. @mila.cpa can read what it covers.")).toBeVisible({
      timeout: 240_000,
    });
    await mila.context().close();
  }

  if (!s.capsule && s.capsuleDraft) {
    // A run stopped half way: remove its unarmed draft and start the capsule again.
    const token = await apiToken(await ensurePersona("demo-aria"));
    await fetch(`${API}/owner/capsules/${s.capsuleDraft}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    delete s.capsuleDraft;
    save(s);
  }
  if (!s.capsule) {
    await nav(aria, "Capsules");
    await aria.waitForURL("**/app/capsules");
    await aria.getByRole("link", { name: "New capsule" }).first().click();
    await aria.getByLabel("Name of the capsule").fill("For the family");
    await aria.waitForURL(/\/app\/capsules\/[0-9a-f]{64}$/, { timeout: 30_000 });
    s.capsuleDraft = aria.url().split("/").pop() ?? "";
    save(s);
    await aria.locator('input[type="file"]').setInputFiles({
      name: "where-everything-is.pdf",
      mimeType: "application/pdf",
      buffer: pdf("Where everything is"),
    });
    await expect(aria.getByText("where-everything-is.pdf").first()).toBeVisible({ timeout: 60_000 });
    await aria.getByLabel("Their @name or address").fill("@kapoor.family");
    await aria.getByRole("button", { name: "Add", exact: true }).click();
    await expect(aria.getByText("@kapoor.family", { exact: true })).toBeVisible({ timeout: 30_000 });
    await aria
      .getByLabel("A message for @kapoor.family (optional)")
      .fill("The passwords sheet is in the blue folder. Love you all.");
    await aria.getByRole("button", { name: "Next", exact: true }).click();
    await aria.getByRole("button", { name: "If I go quiet" }).click();
    await aria.getByRole("button", { name: "Next", exact: true }).click();
    await aria.getByLabel("Guardian's @name or address").fill("@rohan.law");
    await aria.getByRole("button", { name: "Invite" }).click();
    await expect(aria.getByText("Invited @rohan.law.", { exact: false })).toBeVisible({ timeout: 60_000 });
    const rohan = await as(browser, "demo-rohan");
    await rohan.goto("/app/capsules?tab=guard");
    await unlock(rohan);
    await rohan
      .getByRole("listitem")
      .filter({ hasText: "For the family" })
      .getByRole("button", { name: "Accept" })
      .click();
    const rw = await words(rohan, "Your safety words");
    await aria.getByRole("button", { name: "Check words" }).click();
    expect(await words(aria, "Safety words")).toBe(rw);
    await aria.getByRole("button", { name: "They match, confirm" }).click();
    await expect(aria.getByText("@rohan.law is confirmed.")).toBeVisible({ timeout: 30_000 });
    await aria.getByRole("button", { name: /Confirm your plan/ }).click();
    await aria.getByRole("button", { name: "Confirm and arm" }).click();
    await expect(aria.getByText("Armed on QoreChain.")).toBeVisible({ timeout: 240_000 });
    s.capsule = s.capsuleDraft;
    delete s.capsuleDraft;
    save(s);
    await rohan.context().close();
  }
  await aria.context().close();
});
