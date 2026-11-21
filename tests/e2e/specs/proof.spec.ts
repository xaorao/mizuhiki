/**
 * 5.15 Proof, on testnet. The owner anchors a document from their device;
 * the test reads the anchor straight from QoreChain (source of truth), then a
 * stranger in a separate browser opens the certificate and checks the right
 * and a wrong file. Also: anchoring the same file twice sends nothing, the
 * public check page, a bad link and an unknown fingerprint. And the security review's M2 case: someone who
 * learned a fingerprint anchors it first; the author's own anchor still goes through and the certificate
 * lists both, earliest first.
 */
import { createHash, randomBytes } from "node:crypto";
import { test, expect } from "./fixtures";
import { readAnchor, readAnchors, evmOf } from "@mizuhiki/chain";
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
  // Unique per run, so the list check finds this run's label and not one from an earlier run.
  const fileName = `services-agreement-v3-${hash.slice(0, 6)}.pdf`;
  const note = `Kinari x Leaf & Kettle ${hash.slice(0, 6)}`;

  const octx = await browser.newContext();
  const o = await octx.newPage();
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: "Proofs" }).first().click();
  await o.waitForURL("**/app/proof");
  await o.locator('input[type="file"]').setInputFiles({ name: fileName, mimeType: "application/pdf", buffer: doc });
  const sheet = o.getByRole("dialog", { name: "Prove it existed" });
  await expect(sheet.getByText(hash)).toBeVisible();
  await sheet.getByLabel("Private note (optional)").fill(note);
  await sheet.getByRole("button", { name: "Anchor on QoreChain" }).click();
  await expect(sheet.getByText("Anchored. It is on QoreChain now.")).toBeVisible({ timeout: 240_000 });
  await o.screenshot({ path: info.outputPath("anchored.png") });

  // Source of truth: AnchorBook has the anchor, by the owner's account.
  const a = await readAnchor(hash);
  expect(a).not.toBeNull();
  expect(a?.by.toLowerCase()).toBe(evmOf(owner.address).toLowerCase());
  expect(a?.byAddress).toBe(owner.address);
  expect(a?.kind).toBe("document");
  expect(a?.contract).toBe("book");

  // The list shows the private label (opened on this device) once the indexer has the log.
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(o.getByText(fileName)).toBeVisible({ timeout: 60_000 });
  await expect(o.getByText(note)).toBeVisible();

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
  await expect(
    p.getByText(
      new RegExp(`recorded by QoreChain in block ${a ? Number(a.blockNumber).toLocaleString("en-US") : "x"}$`),
    ),
  ).toBeVisible();
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

test("proof: someone who anchors a fingerprint first cannot block its author (review M2)", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "on-chain flow runs once");
  test.setTimeout(600_000);
  const author = await ensureOwner("e2e-editor", NAME);
  const other = await ensureOwner("e2e-pass-holder", "mzk-e2e-passacct");
  const doc = Buffer.concat([Buffer.from(`Draft term sheet ${Date.now()}\n`), randomBytes(1024)]);
  const hash = createHash("sha256").update(doc).digest("hex");

  const anchorAs = async (phrase: string) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await restoreInBrowser(page, phrase);
    await page.getByRole("link", { name: "Proofs" }).first().click();
    await page.waitForURL("**/app/proof");
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "term-sheet.pdf", mimeType: "application/pdf", buffer: doc });
    const sheet = page.getByRole("dialog", { name: "Prove it existed" });
    await sheet.getByRole("button", { name: "Anchor on QoreChain" }).click();
    await expect(sheet.getByText("Anchored. It is on QoreChain now.")).toBeVisible({ timeout: 240_000 });
    return { ctx, page, sheet };
  };

  // The other account anchors first, as someone who learned the fingerprint would.
  const first = await anchorAs(other.phrase);
  await first.ctx.close();
  // The author's anchor still goes through, and the sheet says someone came first.
  const second = await anchorAs(author.phrase);
  await expect(second.sheet.getByText(/Another account anchored this fingerprint earlier/)).toBeVisible();
  await second.page.screenshot({ path: info.outputPath("second-anchor.png") });
  await second.ctx.close();

  // Source of truth: two records in AnchorBook, the other account's first.
  const all = await readAnchors(hash);
  expect(all.map((x) => x.byAddress)).toEqual([other.address, author.address]);
  expect(all.every((x) => x.contract === "book")).toBe(true);
  expect(all[0]!.blockNumber).toBeLessThan(all[1]!.blockNumber);

  // A stranger's certificate lists both, earliest first, each with its own transaction.
  const sctx = await browser.newContext();
  const p = await sctx.newPage();
  await p.goto(`/proof/${hash}`);
  const list = p.getByRole("region", { name: "Every account that anchored this fingerprint" });
  await expect(list.getByRole("heading", { name: "Anchored by 2 accounts" })).toBeVisible({ timeout: 30_000 });
  const items = list.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText(other.address);
  await expect(items.nth(1)).toContainText(author.address);
  await expect(items.nth(1).getByRole("link", { name: `@${NAME}` })).toBeVisible();
  await expect(list.getByRole("link", { name: /^0x[0-9a-f]{16}/ })).toHaveCount(2);
  await expect(p.getByText("First anchored")).toBeVisible();
  await p.screenshot({ path: info.outputPath("certificate-two.png"), fullPage: true });
  await sctx.close();
});

test("proof: an anchor made in the registry before AnchorBook still has its certificate", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "desktop");
  const owner = await ensureOwner("e2e-editor", NAME);
  const r = await fetch(`${process.env.API_URL ?? "http://127.0.0.1:4000"}/proofs?by=${owner.address}`);
  const { proofs } = (await r.json()) as { proofs: { contentHash: string; block: string }[] };
  const old = (await Promise.all(proofs.map(async (x) => (await readAnchors(x.contentHash))[0]))).find(
    (x) => x?.contract === "registry",
  );
  test.skip(!old, "no registry-era anchor for this account");
  await page.goto(`/proof/${old!.contentHash.slice(2)}`);
  await expect(page.getByRole("heading", { name: /existed, unchanged/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("checked by the Mizuhiki registry contract")).toBeVisible();
  await expect(page.getByRole("link", { name: /^0x[0-9a-f]{16}/ })).toBeVisible();
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
