/**
 * The core journey in Firefox and Safari (WebKit, desktop and iPhone), QA guide 5.20: everything that runs
 * cryptography in the browser runs here too. A visitor with no account opens a page, the browser verifies the
 * owner's post-quantum signature, seals a message with a file to the owner's ML-KEM key and sends it; the owner
 * restores their account from the phrase in the same browser, opens that exact item, and saves the file. The
 * certificate page hashes a file in the browser and says Match. Source of truth: the stored envelope opened with
 * the owner's keys outside the browser, and the saved bytes compared with the picked ones.
 */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect } from "./fixtures";
import { Purpose, fromUtf8, openItem, sha256Hex } from "@mizuhiki/core";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const NAME = "mzk-e2e-editor";

test("core journey in this browser: verify, seal and send, restore, open, save, certificate", async ({
  browser,
}, info) => {
  test.setTimeout(420_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const stamp = `${info.project.name}-${Date.now()}`;
  const text = `Cross-browser check from ${stamp}`;
  const file = {
    name: `brief-${stamp}.txt`,
    mimeType: "text/plain",
    buffer: Buffer.concat([Buffer.from(text), randomBytes(64 * 1024)]),
  };

  // ---- visitor, no account
  const vctx = await browser.newContext({ ...(info.project.use as object) });
  const v = await vctx.newPage();
  const problems: string[] = [];
  v.on("console", (m) => m.type() === "error" && problems.push(`visitor console: ${m.text()}`));
  v.on("pageerror", (e) => problems.push(`visitor pageerror: ${e.message}`));
  await v.goto(`/@${NAME}`);
  await expect(v.getByText(/This page really is @mzk-e2e-editor's, checked on QoreChain/)).toBeVisible({
    timeout: 60_000,
  });
  await v.screenshot({ path: info.outputPath("public.png"), fullPage: true });
  await v.getByRole("button", { name: /Send me something private/ }).click();
  const sheet = v.getByRole("dialog", { name: "Send Kinari something private" });
  await sheet.getByLabel("Message").fill(text);
  await sheet.locator('input[type="file"]').setInputFiles(file);
  await sheet.getByRole("button", { name: "Next" }).click();
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  const done = v.getByRole("dialog", { name: "Sealed for Kinari" });
  await expect(done.getByText("Stored for Kinari, sealed.")).toBeVisible({ timeout: 180_000 });
  const hash = ((await done.innerText()).match(/([0-9a-f]{8} ?){8}/)?.[0] ?? "").replace(/ /g, "");
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await v.screenshot({ path: info.outputPath("receipt.png") });

  // Source of truth: the stored envelope opens with the owner's keys and holds what this browser sealed.
  const env = new Uint8Array(await (await fetch(`${API}/blobs/${hash}`)).arrayBuffer());
  expect(sha256Hex(env)).toBe(hash);
  const payload = JSON.parse(fromUtf8(openItem({ purpose: Purpose.message, envelope: env, keys: owner.seal }))) as {
    text: string;
  };
  expect(payload.text).toBe(text);

  // ---- certificate check: hashing in this browser
  await v.goto("/proof");
  await v.locator('input[type="file"]').setInputFiles(file);
  await v.waitForURL(`**/proof/${sha256Hex(file.buffer)}`);
  await expect(v.getByRole("heading", { name: "Nothing is anchored with this fingerprint" })).toBeVisible({
    timeout: 60_000,
  });
  expect(problems).toEqual([]);
  await vctx.close();

  // ---- owner, same browser engine, own context: restore from the phrase, open the item, save the file
  const octx = await browser.newContext({ ...(info.project.use as object), acceptDownloads: true });
  const o = await octx.newPage();
  await restoreInBrowser(o, owner.phrase);
  if (await o.getByRole("navigation", { name: "Owner sections" }).getByRole("button", { name: "More" }).isVisible())
    await o.getByRole("navigation", { name: "Owner sections" }).getByRole("link", { name: /Inbox/ }).click();
  else await o.getByRole("link", { name: /Inbox/ }).first().click();
  await o.waitForURL("**/app/inbox");
  // The inbox index has it; the item is opened in this browser with the owner's keys.
  const token = await apiToken(owner);
  await expect
    .poll(async () => {
      const r = (await (
        await fetch(`${API}/owner/inbox`, { headers: { authorization: `Bearer ${token}` } })
      ).json()) as {
        rows: { id: string }[];
      };
      return r.rows.some((x) => x.id === hash);
    })
    .toBe(true);
  await o.goto(`/app/inbox?item=${hash}`);
  await expect(o.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await o.getByLabel("Device passphrase").fill("lantern river maple tea");
  await o.getByRole("button", { name: "Unlock" }).click();
  const detail = o.getByRole("region", { name: "Opened item" });
  await expect(detail.getByText(text)).toBeVisible({ timeout: 60_000 });
  const [dl] = await Promise.all([o.waitForEvent("download"), detail.getByRole("button", { name: "Save" }).click()]);
  expect(dl.suggestedFilename()).toBe(file.name);
  expect(Buffer.from(await readFile(await dl.path())).equals(file.buffer)).toBe(true);
  await o.screenshot({ path: info.outputPath("inbox-open.png"), fullPage: true });
  await octx.close();
});
