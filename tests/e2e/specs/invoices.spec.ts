/**
 * 5.6 Invoices on testnet, owner and payer in separate browser contexts.
 * Source of truth: the sealed invoice fetched from the API and opened with the
 * link key and with the payer's own key (and refused by others), the owner's
 * signature checked against the chain, the payment transaction read from
 * chain, and the PDF read back as text.
 */
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { test, expect } from "./fixtures";
import { DENOMS, getTx, pqKeyViaEvm } from "@mizuhiki/chain";
import {
  Purpose,
  fromBase64Url,
  fromUtf8,
  linkKeys,
  openItem,
  parseMemo,
  verifyRecord,
  isMizuhikiError,
  type Signed,
} from "@mizuhiki/core";
import { generateSealKeys } from "@qorechain/qoreseal";
import { topUp } from "@mizuhiki/testnet";
import { API, ensureOwner, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-editor";
const VISITOR = "mzk-e2e-visitor";

async function bytes(path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(`${API}${path}`)).arrayBuffer());
}

test("invoices: create, send to @name, payer opens by link and pays, owner sees Paid from chain; PDF, prove, cancel", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "two-party on-chain flow runs once");
  test.setTimeout(600_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  const visitor = await ensureOwner("e2e-visitor", VISITOR);
  await topUp(visitor.address, DENOMS.fUSD.denom, 10_000_000n, "e2e-visitor-fusd");

  // ---- owner writes and sends
  const octx = await browser.newContext({ acceptDownloads: true });
  const o = await octx.newPage();
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: "Invoices" }).first().click();
  await o.waitForURL("**/app/invoices");
  await o.getByRole("link", { name: "New invoice" }).first().click();
  await expect(o.getByRole("heading", { name: /^Invoice #\d{4}$/ })).toBeVisible();
  // Send with nothing filled in is refused with reasons
  await o.getByRole("button", { name: "Send", exact: true }).click();
  await expect(o.getByText("Item 1 needs a name.")).toBeVisible();
  await o.getByRole("button", { name: "A Mizuhiki @name" }).click();
  await o.getByLabel("Their @name").fill(VISITOR);
  await o.getByLabel("Their business name (optional)").click();
  await expect(o.getByText(`@${VISITOR} is on Mizuhiki. The invoice is sealed to their key too.`)).toBeVisible();
  await o.getByLabel("Their business name (optional)").fill("Leaf & Kettle Tea");
  await o.getByLabel("Item 1 name").fill("Logo design");
  await o.getByLabel("Price (fUSD)").first().fill("2");
  await o.getByRole("button", { name: "Add item" }).click();
  await o.getByLabel("Item 2 name").fill("Revisions");
  await o.getByLabel("Qty").nth(1).fill("2");
  await o.getByLabel("Price (fUSD)").nth(1).fill("0.25");
  await o.getByLabel("Description (optional)").nth(1).fill("Two rounds after the first draft.");
  await o.getByLabel("Discount").fill("0.1");
  await expect(o.locator("aside").getByText("2.4 fUSD")).toBeVisible();
  await o.getByLabel("Message to customer").fill("Thank you for the spring launch work.");
  await o.getByLabel("Memo to self").fill("Client prefers fUSD. Private.");
  await o
    .locator('input[type="file"]')
    .setInputFiles({ name: "brief.pdf", mimeType: "application/pdf", buffer: randomBytes(4096) });
  await expect(o.getByText("brief.pdf")).toBeVisible({ timeout: 30_000 });
  await expect(o.getByText("Draft saved, sealed")).toBeVisible({ timeout: 30_000 });
  await o.getByRole("button", { name: "Preview" }).click();
  await expect(o.getByRole("article", { name: /Invoice #\d{4}/ }).getByText("Leaf & Kettle Tea")).toBeVisible();
  await o.screenshot({ path: info.outputPath("preview.png") });
  await o.getByRole("button", { name: "Edit" }).click();
  await o.screenshot({ path: info.outputPath("editor.png"), fullPage: true });
  await o.getByRole("button", { name: "Send", exact: true }).click();
  const share = o.getByRole("dialog", { name: /Invoice #\d{4} is ready/ });
  await expect(share.getByText("Anyone with this link can read this invoice.", { exact: false })).toBeVisible({
    timeout: 60_000,
  });
  const link = (await share.innerText()).match(/http:\/\/[^\s]+\/i\/[a-z0-9]+#k=[A-Za-z0-9_-]+&n=\d+/)?.[0] ?? "";
  expect(link).not.toBe("");
  await share.getByRole("button", { name: `Send to @${VISITOR}` }).click();
  await expect(share.getByRole("button", { name: "Sent" })).toBeVisible({ timeout: 120_000 });
  await o.screenshot({ path: info.outputPath("share.png") });
  const id = new URL(link).pathname.split("/").pop() ?? "";
  const frag = new URLSearchParams(new URL(link).hash.slice(1));
  const seed = fromBase64Url(frag.get("k") ?? "");
  const number = frag.get("n") ?? "";

  // Source of truth: signature checks against the chain; the link key and the payer's key open it; others cannot; no memo inside.
  const served = (await (await fetch(`${API}/invoices/${id}`)).json()) as {
    owner: string;
    envelope: string;
    sig: Signed<{ id: string; envelope: string }>;
  };
  const pq = await pqKeyViaEvm(owner.address);
  expect(
    verifyRecord(served.sig, { kind: "invoice", signer: owner.address, pqPublicKey: pq.publicKey ?? new Uint8Array() }),
  ).toEqual({ id, envelope: served.envelope });
  const env = await bytes(`/blobs/${served.envelope}`);
  for (const keys of [linkKeys(seed), visitor.seal, owner.seal]) {
    const doc = JSON.parse(
      fromUtf8(openItem({ purpose: Purpose.invoice(id), envelope: env, keys, context: number })),
    ) as { items: unknown[]; message: string };
    expect(doc.items).toHaveLength(2);
    expect(doc.message).toBe("Thank you for the spring launch work.");
  }
  expect(Buffer.from(env).includes(Buffer.from("Client prefers"))).toBe(false);
  try {
    openItem({ purpose: Purpose.invoice(id), envelope: env, keys: generateSealKeys(), context: number });
    throw new Error("outsider opened it");
  } catch (e) {
    expect(isMizuhikiError(e, "NOT_A_READER")).toBe(true);
  }

  // ---- the payer: inbox item from the owner, then the link, then pays with the Mizuhiki wallet
  const vctx = await browser.newContext();
  const v = await vctx.newPage();
  await restoreInBrowser(v, visitor.phrase);
  await v.getByRole("link", { name: /Inbox/ }).first().click();
  await v
    .getByRole("region", { name: "Inbox list" })
    .getByRole("button", { name: new RegExp(`Invoice.*@${OWNER}`) })
    .first()
    .click();
  const vd = v.getByRole("region", { name: "Opened item" });
  await expect(vd.getByText(/Invoice #\d{4} from Kinari Studio: 2\.4 fUSD/)).toBeVisible({ timeout: 30_000 });
  await expect(vd.getByText(`Verified: @${OWNER}`)).toBeVisible({ timeout: 30_000 });
  await expect(vd.getByRole("link", { name: "Open the invoice" })).toHaveAttribute("href", link);
  await v.goto(link);
  await expect(v.getByText(`Signed by @${OWNER}'s post-quantum key, checked on QoreChain just now`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(v.getByText("Anyone with this link can read this invoice.", { exact: false })).toBeVisible();
  await expect(v.getByRole("article").getByText("2.4 fUSD").last()).toBeVisible();
  await v.screenshot({ path: info.outputPath("payer.png"), fullPage: true });
  await v.getByRole("button", { name: /^Pay #\d{4}$/ }).click();
  const sheet = v.getByRole("dialog", { name: /Pay invoice #\d{4}/ });
  await sheet.getByLabel("Device passphrase").fill("lantern river maple tea");
  await sheet.getByRole("button", { name: "Unlock my wallet" }).click();
  await sheet.getByRole("radio", { name: /Pay with my Mizuhiki wallet/ }).click();
  await v.getByRole("dialog", { name: "Review" }).getByRole("button", { name: "Pay 2.4 fUSD" }).click();
  const paid = v.getByRole("dialog", { name: "Paid Kinari" });
  await expect(paid.getByText("Paid Kinari 2.4 fUSD.")).toBeVisible({ timeout: 180_000 });
  const txHash = ((await paid.innerText()).match(/([0-9A-F]{8} ?){8}/i)?.[0] ?? "").replace(/ /g, "");
  const tx = await getTx(txHash);
  const body = (
    tx as unknown as {
      tx: { body: { memo: string; messages: { to_address: string; amount: { denom: string; amount: string }[] }[] } };
    }
  ).tx.body;
  expect(parseMemo(body.memo)).toEqual({ kind: "inv", ref: id });
  expect(body.messages[0]).toMatchObject({
    to_address: owner.address,
    amount: [{ denom: DENOMS.fUSD.denom, amount: "2400000" }],
  });
  await paid.getByRole("button", { name: "Done" }).click();
  await expect(v.getByText("Paid on QoreChain")).toBeVisible();
  await vctx.close();

  // ---- owner: Paid from the chain (the list refreshes itself), viewed, PDF, prove
  await share.getByRole("button", { name: "Done" }).click();
  await o.waitForURL("**/app/invoices");
  const o2 = o;
  await expect(
    o2
      .getByRole("row", { name: /Leaf & Kettle Tea/ })
      .first()
      .getByText("Paid", { exact: true }),
  ).toBeVisible({ timeout: 150_000 });
  await expect(
    o2
      .getByRole("row", { name: /Leaf & Kettle Tea/ })
      .first()
      .getByText("Viewed (reported by their browser)"),
  ).toBeVisible();
  await o2.screenshot({ path: info.outputPath("list.png") });
  await o2
    .getByRole("row", { name: /Leaf & Kettle Tea/ })
    .first()
    .getByRole("button", { name: "Leaf & Kettle Tea" })
    .click();
  const det = o2.getByRole("dialog", { name: /Invoice #\d{4}/ });
  await expect(det.getByText("Memo to self: Client prefers fUSD. Private.")).toBeVisible();
  await expect(det.getByText(/Paid on chain/)).toBeVisible();
  const [dl] = await Promise.all([
    o2.waitForEvent("download"),
    det.getByRole("button", { name: "Download PDF" }).click(),
  ]);
  const pdfPath = await dl.path();
  const text = execFileSync("pdftotext", [pdfPath, "-"]).toString();
  expect(text).toContain("Leaf & Kettle Tea");
  expect(text).toContain("Logo design");
  expect(text).toContain("2.4 fUSD");
  expect(text).not.toContain("Client prefers");
  expect((await readFile(pdfPath)).subarray(0, 4).toString()).toBe("%PDF");
  // The text layer can be right while the drawn glyphs are missing (a broken font subset),
  // so render the page and read it back with OCR.
  execFileSync("pdftoppm", ["-r", "150", "-png", "-f", "1", "-l", "1", pdfPath, `${pdfPath}-page`]);
  const ocr = execFileSync("tesseract", [`${pdfPath}-page-1.png`, "-", "--psm", "4"]).toString();
  for (const want of ["Leaf", "Kettle", "Logo design", "Revisions", "2.4 fUSD"]) expect(ocr).toContain(want);
  await det.getByRole("button", { name: "Prove it existed" }).click();
  const prove = o2.getByRole("dialog", { name: "Prove it existed" });
  await prove.getByRole("button", { name: "Anchor on QoreChain" }).click();
  await expect(prove.getByText(/Anchored\. It is on QoreChain now\.|You anchored this already\./)).toBeVisible({
    timeout: 240_000,
  });
  await octx.close();
});

test("invoices: bad links, cancel, record payment (unverified)", async ({ browser }, info) => {
  test.skip(info.project.name !== "desktop", "runs once");
  test.setTimeout(300_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await restoreInBrowser(p, owner.phrase);
  await p.getByRole("link", { name: "Invoices" }).first().click();
  await p.getByRole("link", { name: "New invoice" }).first().click();
  await p.getByLabel("Who it is for (optional, shown on the invoice)").fill("Walk-in client");
  await p.getByLabel("Item 1 name").fill("Consultation");
  await p.getByLabel("Price (fUSD)").first().fill("1");
  await p.getByRole("button", { name: "Send", exact: true }).click();
  const share = p.getByRole("dialog", { name: /Invoice #\d{4} is ready/ });
  const link = (await share.innerText()).match(/http:\/\/[^\s]+\/i\/[a-z0-9]+#k=[A-Za-z0-9_-]+&n=\d+/)?.[0] ?? "";
  expect(link).not.toBe("");
  await share.getByRole("button", { name: "Done" }).click();

  const stranger = await (await browser.newContext()).newPage();
  // no key in the link
  await stranger.goto(link.split("#")[0] ?? "");
  await expect(stranger.getByRole("heading", { name: "This link is missing its key" })).toBeVisible({
    timeout: 30_000,
  });
  // wrong key
  await stranger.goto(
    `${link.split("#")[0] ?? ""}#k=${Buffer.alloc(32, 7).toString("base64url")}&n=${new URLSearchParams(link.split("#")[1]).get("n") ?? ""}`,
  );
  await stranger.reload();
  await expect(stranger.getByRole("heading", { name: "This invoice could not be opened" })).toBeVisible({
    timeout: 30_000,
  });
  // unknown id
  await stranger.goto(`/i/zzzzzzzzzzzzzz#k=${Buffer.alloc(32, 1).toString("base64url")}&n=1`);
  await expect(stranger.getByRole("heading", { name: "There is no invoice at this link" })).toBeVisible({
    timeout: 30_000,
  });

  // record payment, then cancel; the payer's link says cancelled
  await p.getByRole("button", { name: "Walk-in client" }).first().click();
  const det = p.getByRole("dialog", { name: /Invoice #\d{4}/ });
  await det.getByRole("button", { name: "Record payment (unverified)" }).click();
  await expect(
    p
      .getByRole("row", { name: /Walk-in client/ })
      .first()
      .getByText("Paid (recorded, unverified)"),
  ).toBeVisible({ timeout: 30_000 });
  await p.getByRole("button", { name: "Walk-in client" }).first().click();
  await p
    .getByRole("dialog", { name: /Invoice #\d{4}/ })
    .getByRole("button", { name: "Cancel invoice" })
    .click();
  await expect(
    p
      .getByRole("row", { name: /Walk-in client/ })
      .first()
      .getByText("Cancelled"),
  ).toBeVisible({ timeout: 30_000 });
  await stranger.goto(link);
  await stranger.reload();
  await expect(stranger.getByText("This invoice was cancelled")).toBeVisible({ timeout: 30_000 });
  await expect(stranger.getByRole("button", { name: /^Pay #/ })).toHaveCount(0);
  await ctx.close();
});

test("invoices on a phone: list and payer page fit", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone");
  const owner = await ensureOwner("e2e-editor", OWNER);
  await restoreInBrowser(page, owner.phrase);
  // phones reach Invoices through More (the tab bar holds My page, Inbox, Rooms, Forms)
  await page.getByRole("navigation", { name: "Owner sections" }).last().getByRole("button", { name: "More" }).click();
  await page.getByRole("dialog", { name: "Everything" }).getByRole("link", { name: "Invoices" }).click();
  await expect(page.getByRole("heading", { name: "Invoices" })).toBeVisible();
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: info.outputPath("list-phone.png"), fullPage: true });
});
