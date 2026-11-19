/**
 * 5.4 the public page and 5.7 the visitor's sealed message and file drop, as a
 * visitor with no account, in their own browser context. Source of truth: the
 * stored envelope is fetched from the API and opened with the OWNER's keys
 * (and is refused for anyone else), and the file pieces decrypt back to the
 * exact bytes that were picked.
 */
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { test, expect } from "./fixtures";
import { Purpose, decryptFile, fromUtf8, openItem, sha256Hex, isMizuhikiError } from "@mizuhiki/core";
import { generateSealKeys } from "@qorechain/qoreseal";
import { API, apiToken, ensureOwner } from "./owner";

const NAME = "mzk-e2e-editor";

async function bytes(path: string): Promise<Uint8Array> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

test("visitor: page verifies, info and share sheets, report, missing and unknown pages", async ({ page }) => {
  await ensureOwner("e2e-editor", NAME);
  await page.goto(`/@${NAME}`);
  await expect(page.getByRole("heading", { name: "Kinari Studio" })).toBeVisible();
  await expect(page.getByText(/Signed by @mzk-e2e-editor's post-quantum key, checked on QoreChain/)).toBeVisible();
  await page.getByRole("button", { name: /Anything you send is sealed to Kinari/ }).click();
  await expect(page.getByRole("dialog", { name: "What sealed means here" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Share or show QR code" }).click();
  await expect(page.getByRole("img", { name: /QR code for/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Report this page" }).click();
  await page.getByRole("radio", { name: "A scam or fraud" }).click();
  await page.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Thank you. We will look at this page.")).toBeVisible();

  await page.goto("/@nobody-here-zz");
  await expect(page.getByRole("heading", { name: "This page isn't available." })).toBeVisible();
  await page.goto(`/@${NAME}/nothing/here`);
  await expect(page.getByText("That link has nothing behind it")).toBeVisible();
});

test("visitor: sends a sealed message with a file; only the owner can open it", async ({ page }, info) => {
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const text = `Signed contract attached. ${Date.now()}`;
  const file = { name: "contract_v3.pdf", mimeType: "application/pdf", buffer: randomBytes(5 * 1024 * 1024 + 123) };

  await page.goto(`/@${NAME}/message`);
  const sheet = page.getByRole("dialog", { name: "Send Kinari something private" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Hi, send me anything private here.")).toBeVisible();
  // empty send is refused, nothing leaves
  await sheet.getByRole("button", { name: "Next" }).click();
  await expect(sheet.getByText(/Write a note or add a file. Nothing has left your device./)).toBeVisible();
  await sheet.getByLabel("Message").fill(text);
  await sheet.locator('input[type="file"]').setInputFiles(file);
  await expect(sheet.getByText(/contract_v3.pdf · 5.0 MB/)).toBeVisible();
  // the same file twice is refused
  await sheet.locator('input[type="file"]').setInputFiles(file);
  await expect(sheet.getByText(/is already added/)).toBeVisible();
  await sheet.getByRole("button", { name: "Next" }).click();
  await expect(sheet.getByText("How should Kinari see you?")).toBeVisible();
  await expect(sheet.getByRole("radio", { name: /Anonymous/ })).toHaveAttribute("aria-checked", "true");
  await sheet.getByLabel("Your name or how to reach you (optional)").fill("Rohan, rohan@example.com");
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  const done = page.getByRole("dialog", { name: "Sealed for Kinari" });
  await expect(done.getByText("Stored for Kinari, sealed.")).toBeVisible({ timeout: 120_000 });
  const receipt = await done.innerText();
  const hash = (receipt.match(/([0-9a-f]{8} ?){8}/)?.[0] ?? "").replace(/ /g, "");
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await page.screenshot({ path: info.outputPath("receipt.png") });

  // Source of truth: fetch the stored envelope; the owner opens it, an outsider cannot.
  const env = await bytes(`/blobs/${hash}`);
  expect(sha256Hex(env)).toBe(hash);
  const payload = JSON.parse(fromUtf8(openItem({ purpose: Purpose.message, envelope: env, keys: owner.seal }))) as {
    text: string;
    contact: string;
    files: Parameters<typeof decryptFile>[0]["facts"][];
  };
  expect(payload.text).toBe(text);
  expect(payload.contact).toBe("Rohan, rohan@example.com");
  expect(payload.files).toHaveLength(1);
  const parts = await decryptFile({ facts: payload.files[0]!, fetchChunk: (h) => bytes(`/blobs/${h}`) });
  expect(Buffer.concat(parts).equals(file.buffer)).toBe(true);
  try {
    openItem({ purpose: Purpose.message, envelope: env, keys: generateSealKeys() });
    throw new Error("an outsider opened it");
  } catch (e) {
    expect(isMizuhikiError(e, "NOT_A_READER")).toBe(true);
  }
  // The server never had the plaintext: the stored bytes contain neither the text nor the contact.
  expect(Buffer.from(env).includes(Buffer.from("Signed contract"))).toBe(false);
});

test("visitor on a phone: page fits, message sheet opens from the top bar", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone");
  await page.goto(`/@${NAME}`);
  await expect(page.getByText(/checked on QoreChain/)).toBeVisible();
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: info.outputPath("public-phone.png"), fullPage: true });
  await page.getByRole("button", { name: "Message", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Send Kinari something private" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("message-phone.png") });
  await page.goBack();
  await expect(page.getByRole("dialog", { name: "Send Kinari something private" })).toBeHidden();
});

const PSQL = "/opt/homebrew/opt/postgresql@17/bin/psql";
const DEV_DB = process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki";

test("visitor: a manifest changed on the server is refused; unpublished pages vanish; views and taps are counted", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "server-state test runs once");
  test.setTimeout(180_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const token = await apiToken(owner);
  const stats = async () =>
    (await (await fetch(`${API}/owner/stats`, { headers: { authorization: `Bearer ${token}` } })).json()) as {
      views: { week: number };
      taps: Record<string, number>;
    };

  // views and taps: one view per tab session, one tap per click
  const before = await stats();
  await page.goto(`/@${NAME}`);
  await expect(page.getByText(/checked on QoreChain/)).toBeVisible();
  await page.getByRole("button", { name: /Send me something private/ }).click();
  await expect(page.getByRole("dialog", { name: "Send Kinari something private" })).toBeVisible();
  await expect.poll(async () => (await stats()).views.week).toBe(before.views.week + 1);
  await expect
    .poll(async () => Object.values((await stats()).taps).reduce((a, b) => a + b, 0))
    .toBe(Object.values(before.taps).reduce((a, b) => a + b, 0) + 1);

  // The server (here: someone with database access) edits the published page: the browser refuses it.
  execFileSync(PSQL, [
    DEV_DB,
    "-q",
    "-c",
    `update pages set record = jsonb_set(record, '{body,displayName}', '"Not Kinari"') where name = '${NAME}'`,
  ]);
  await page.goto(`/@${NAME}`);
  await expect(page.getByRole("heading", { name: "This page could not be verified" })).toBeVisible();
  await expect(page.getByText("Nothing has left your device.")).toBeVisible();
  await expect(page.getByRole("button", { name: /Send me something private/ })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("tampered.png") });

  // unpublished: gone for visitors, back after publishing again
  await ensureOwner("e2e-editor", NAME);
  await fetch(`${API}/pages/unpublish`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  await page.goto(`/@${NAME}`);
  await expect(page.getByRole("heading", { name: "This page isn't available." })).toBeVisible();
  await ensureOwner("e2e-editor", NAME);
  await page.goto(`/@${NAME}`);
  await expect(page.getByText(/checked on QoreChain/)).toBeVisible();
});
