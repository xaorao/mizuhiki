/**
 * 5.15 Proof, on testnet. The owner anchors a document from their device;
 * the test reads the anchor straight from QoreChain (source of truth), then a
 * stranger in a separate browser opens the certificate and checks the right
 * and a wrong file. Also: anchoring the same file twice sends nothing, the
 * public check page, a bad link and an unknown fingerprint.
 */
import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "./fixtures";
import { readAnchor, evmOf } from "@mizuhiki/chain";
import { ensureOwner, restoreInBrowser } from "./owner";

const NAME = "mzk-e2e-editor";

test("proof: anchor a document, certificate from chain, match and no match, anchor twice", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "on-chain flow runs once; phone checks the certificate below");
  test.setTimeout(420_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const doc = Buffer.concat([Buffer.from(`Signed services agreement, version 3. ${Date.now()}\n`), randomBytes(2048)]);
  const hash = createHash("sha256").update(doc).digest("hex");

  const octx = await browser.newContext();
  const o = await octx.newPage();
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: "Proofs" }).first().click();
  await o.waitForURL("**/app/proof");
  await o
    .locator('input[type="file"]')
    .setInputFiles({ name: "services-agreement-v3.pdf", mimeType: "application/pdf", buffer: doc });
  const sheet = o.getByRole("dialog", { name: "Prove it existed" });
  await expect(sheet.getByText(hash)).toBeVisible();
  await sheet.getByLabel("Private note (optional)").fill("Kinari x Leaf & Kettle");
  await sheet.getByRole("button", { name: "Anchor on QoreChain" }).click();
  await expect(sheet.getByText("Anchored. It is on QoreChain now.")).toBeVisible({ timeout: 240_000 });
  await o.screenshot({ path: info.outputPath("anchored.png") });

  // Source of truth: the registry contract has the anchor, by the owner's account.
  const a = await readAnchor(hash);
  expect(a).not.toBeNull();
  expect(a?.by.toLowerCase()).toBe(evmOf(owner.address).toLowerCase());
  expect(a?.byAddress).toBe(owner.address);
  expect(a?.kind).toBe("document");

  // The list shows the private label (opened on this device) once the indexer has the log.
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(o.getByText("services-agreement-v3.pdf")).toBeVisible({ timeout: 60_000 });
  await expect(o.getByText(/Kinari x Leaf & Kettle/)).toBeVisible();

  // Anchoring the same file again sends nothing and says so.
  await o.locator('input[type="file"]').setInputFiles({ name: "same.pdf", mimeType: "application/pdf", buffer: doc });
  await sheet.getByRole("button", { name: "Anchor on QoreChain" }).click();
  await expect(sheet.getByText("You anchored this already.")).toBeVisible({ timeout: 60_000 });
  expect((await readAnchor(hash))?.blockNumber).toBe(a?.blockNumber);
  await octx.close();

  // ---- a stranger, no account, opens the certificate
  const sctx = await browser.newContext();
  const p = await sctx.newPage();
  await p.goto(`/proof/${hash}`);
  await expect(p.getByRole("heading", { name: "A document existed, unchanged, by this time." })).toBeVisible({
    timeout: 30_000,
  });
  await expect(p.getByRole("link", { name: `@${NAME}` })).toBeVisible();
  await expect(p.getByText(owner.address)).toBeVisible();
  await expect(p.getByText(new RegExp(`block ${a?.blockNumber.toString() ?? "x"} · block time`))).toBeVisible();
  const tx = p.getByRole("link", { name: /^0x[0-9a-f]{16}/ });
  await expect(tx).toHaveAttribute("href", /\/tx\/0x[0-9a-f]{64}$/);
  // no content anywhere on the page
  expect(await p.content()).not.toContain("Signed services agreement");
  expect(await p.content()).not.toContain("Kinari x Leaf");
  await p
    .locator('input[type="file"]')
    .setInputFiles({ name: "from-email.pdf", mimeType: "application/pdf", buffer: doc });
  await expect(p.getByText("Match", { exact: true })).toBeVisible();
  const changed = Buffer.from(doc);
  changed[10] = changed[10] === 0x41 ? 0x42 : 0x41;
  await p
    .locator('input[type="file"]')
    .setInputFiles({ name: "edited.pdf", mimeType: "application/pdf", buffer: changed });
  await expect(p.getByText("No match", { exact: true })).toBeVisible();
  await p.screenshot({ path: info.outputPath("certificate.png"), fullPage: true });

  // ---- public check page: a file goes to its certificate; bad and unknown fingerprints explained
  await p.goto("/proof");
  await p.locator('input[type="file"]').setInputFiles({ name: "check.pdf", mimeType: "application/pdf", buffer: doc });
  await p.waitForURL(`**/proof/${hash}`);
  await expect(p.getByRole("heading", { name: /existed, unchanged/ })).toBeVisible({ timeout: 30_000 });
  await p.goto("/proof");
  await p.getByLabel("Or paste a fingerprint (SHA-256)").fill("not-a-hash");
  await p.getByRole("button", { name: "Look it up" }).click();
  await expect(p.getByText("A fingerprint is 64 letters and numbers (0-9, a-f).")).toBeVisible();
  const unknown = createHash("sha256").update(randomBytes(32)).digest("hex");
  await p.getByLabel("Or paste a fingerprint (SHA-256)").fill(unknown);
  await p.getByRole("button", { name: "Look it up" }).click();
  await expect(p.getByRole("heading", { name: "Nothing is anchored with this fingerprint" })).toBeVisible({
    timeout: 30_000,
  });
  await p.goto("/proof/xyz");
  await expect(p.getByRole("heading", { name: "That is not a document fingerprint" })).toBeVisible();
  await sctx.close();
});

test("proof on a phone: certificate fits and checks a file", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone");
  // The deterministic picture from inbox.spec, anchored there; or any anchor of this owner.
  const owner = await ensureOwner("e2e-editor", NAME);
  const r = await fetch(`${process.env.API_URL ?? "http://127.0.0.1:4000"}/proofs?by=${owner.address}`);
  const { proofs } = (await r.json()) as { proofs: { contentHash: string }[] };
  test.skip(proofs.length === 0, "no anchor yet: run the desktop project first");
  await page.goto(`/proof/${proofs[0]?.contentHash ?? ""}`);
  await expect(page.getByRole("heading", { name: /existed, unchanged/ })).toBeVisible({ timeout: 30_000 });
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: info.outputPath("certificate-phone.png"), fullPage: true });
});
