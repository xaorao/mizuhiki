/**
 * 5.7 File requests (Dropbox's file requests) on testnet, as the owner and two
 * visitors without accounts, each in their own browser:
 * the owner makes a request (deadline, "uploader – file" names) and lands on the
 * share step (link copied, QR, added to the page); visitors open the link, see
 * the request checked against the owner's key on chain, upload; the owner's list
 * updates live, the uploads open on the owner's device with the files byte-exact
 * and renamed by the rule, and the inbox files them under the request. Then the
 * states: late uploads marked late, a passed deadline refusing, closed refusing,
 * reopened taking uploads again, delete only once closed. A request id under
 * another page's name is refused. Zero console errors (fixtures).
 * Source of truth: the API's stored records and counts, and the sealed bytes.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Browser, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-requests";
test.use({ actionTimeout: 60_000 });

const sha = (b: Buffer | Uint8Array) => createHash("sha256").update(b).digest("hex");
interface Reply<T> {
  status: number;
  body: T;
}
async function call<T>(path: string, token?: string): Promise<Reply<T>> {
  const r = await fetch(`${API}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
}

/** A visitor with no account uploads files to the request link. */
async function visit(
  browser: Browser,
  link: string,
  name: string,
  files: { name: string; buffer: Buffer }[],
): Promise<Page> {
  const ctx = await browser.newContext();
  const v = await ctx.newPage();
  await v.goto(link);
  await expect(v.getByText(/checked against their key on QoreChain/)).toBeVisible({ timeout: 60_000 });
  await v.getByLabel("Choose files to upload").setInputFiles(files.map((f) => ({ ...f, mimeType: "application/pdf" })));
  const sheet = v.getByRole("dialog", { name: /Upload files for/ });
  await expect(sheet.getByText(files[0]?.name ?? "")).toBeVisible();
  await sheet.getByRole("button", { name: "Next" }).click();
  // The naming rule needs the uploader's name: sealing waits for it.
  await expect(sheet.getByRole("button", { name: "Seal and send" })).toBeDisabled();
  await sheet.getByLabel("Your name").fill(name);
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  await expect(v.getByRole("dialog", { name: /Sealed for/ })).toBeVisible({ timeout: 180_000 });
  return v;
}

test("file requests: make, share, upload as strangers, open byte-exact, late, ended, closed, reopened, deleted", async ({
  browser,
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "multi-party flow runs once, on desktop");
  test.setTimeout(1_200_000);
  const owner = await ensureOwner("e2e-requests-owner", OWNER);
  const token = await apiToken(owner);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await restoreInBrowser(page, owner.phrase);
  await page.getByRole("link", { name: "File requests" }).filter({ visible: true }).first().click();
  await page.waitForURL("**/app/requests");
  await expect(page.getByRole("heading", { name: "File requests", level: 1 })).toBeVisible();

  // ---- the owner makes a request; wrong input first
  await page.getByRole("button", { name: "New request" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New request" });
  await sheet.getByRole("button", { name: "Create request" }).click();
  await expect(sheet.getByText("Give the request a title, so uploaders know what it is for.")).toBeVisible();
  const title = `Q4 documents ${Date.now().toString(36)}`;
  await sheet.getByLabel("Title").fill(title);
  await sheet.getByLabel("Description (optional)").fill("Your W-2 and any 1099s, please.");
  await sheet.getByRole("switch", { name: /Set a deadline/ }).click();
  await sheet.getByRole("button", { name: "Create request" }).click();
  await expect(sheet.getByText("Pick the deadline's day, or switch the deadline off.")).toBeVisible();
  const soon = new Date(Date.now() + 7 * 86400_000);
  await sheet.getByLabel("Day", { exact: true }).fill(soon.toISOString().slice(0, 10));
  await sheet.getByLabel("Time", { exact: true }).fill("17:00");
  await sheet.getByRole("radio", { name: /Uploader's name – file name/ }).click();
  await page.screenshot({ path: info.outputPath("01-new-request.png") });
  await sheet.getByRole("button", { name: "Create request" }).click();

  // ---- share step at once (Dropbox): copy link, QR, add to my page
  const share = page.getByRole("dialog", { name: "Your request is ready" });
  await expect(share.getByRole("img", { name: "QR code for the request link" })).toBeVisible({ timeout: 60_000 });
  const link = (await share.getByLabel("Request link").innerText()).trim();
  expect(link).toMatch(new RegExp(`/@${OWNER}/r/freq_[A-Za-z0-9]+$`));
  await share.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await share.getByRole("button", { name: "Add to my page" }).click();
  await expect(page.getByText("Added to your page and published")).toBeVisible({ timeout: 120_000 });
  await page.screenshot({ path: info.outputPath("02-share.png") });
  await share.getByRole("button", { name: "Done" }).click();
  const id = link.split("/r/")[1] ?? "";
  await page.waitForURL(`**/app/requests/${id}`);
  await expect(page.getByText("No uploads yet")).toBeVisible();

  // Source of truth: the stored record is signed, open, with the deadline.
  const stored = await call<{ record: { signer: string; body: { status: string; naming: string; deadline: string } } }>(
    `/file-requests/${id}`,
  );
  expect(stored.body.record.signer).toBe(owner.address);
  expect(stored.body.record.body).toMatchObject({ status: "open", naming: "uploader" });
  // The page button opens the request.
  const pageRec = await call<{ record: { body: { blocks: { type: string; requestId?: string }[] } } }>(
    `/pages/${OWNER}`,
  );
  expect(pageRec.body.record.body.blocks.some((b) => b.type === "fileRequest" && b.requestId === id)).toBe(true);

  // ---- two visitors with no account upload; the owner's screen updates live
  const w2 = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(300_000)]);
  const n1099 = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(5000)]);
  const v1 = await visit(browser, link, "Hana Mori", [
    { name: "w2.pdf", buffer: w2 },
    { name: "1099.pdf", buffer: n1099 },
  ]);
  await v1.screenshot({ path: info.outputPath("03-visitor-done.png") });
  await v1.context().close();
  const ken = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(2000)]);
  const v2 = await visit(browser, link, "Ken Ito", [{ name: "receipts.pdf", buffer: ken }]);
  await v2.context().close();
  await expect(page.locator("ul[aria-label='Files'] li")).toHaveCount(3, { timeout: 60_000 });
  await expect(page.getByText("Hana Mori", { exact: true })).toBeVisible();
  await expect(page.getByText("Hana Mori – w2.pdf", { exact: true })).toBeVisible();
  await expect(page.getByText("Ken Ito – receipts.pdf", { exact: true })).toBeVisible();
  const [dl] = await Promise.all([
    page.waitForEvent("download"),
    page
      .locator("ul[aria-label='Files'] > li")
      .filter({ hasText: "Hana Mori – w2.pdf" })
      .getByRole("button", { name: "Save" })
      .click(),
  ]);
  expect(dl.suggestedFilename()).toBe("Hana Mori – w2.pdf");
  expect(sha(await readFile(await dl.path()))).toBe(sha(w2));
  await page.screenshot({ path: info.outputPath("04-uploads.png"), fullPage: true });

  // The list counts what the server can see; the stored bytes hold no file name.
  const list = await call<{ requests: { record: { body: { id: string } }; uploads: number; late: number }[] }>(
    "/owner/file-requests",
    token,
  );
  expect(list.body.requests.find((r) => r.record.body.id === id)).toMatchObject({ uploads: 2, late: 0 });
  const ups = await call<{ uploads: { hash: string }[] }>(`/owner/file-requests/${id}`, token);
  for (const u of ups.body.uploads) {
    const raw = Buffer.from(await (await fetch(`${API}/blobs/${u.hash}`)).arrayBuffer());
    expect(raw.includes(Buffer.from("Hana"))).toBe(false);
    expect(raw.includes(Buffer.from("w2.pdf"))).toBe(false);
  }

  // The inbox files it under the request.
  await page
    .getByRole("link", { name: /Open in the inbox/ })
    .first()
    .click();
  await page.waitForURL("**/app/inbox?item=*");
  await expect(page.getByRole("region", { name: "Opened item" }).getByRole("link", { name: `“${title}”` })).toBeVisible(
    { timeout: 60_000 },
  );
  await page
    .getByRole("region", { name: "Opened item" })
    .getByRole("link", { name: `“${title}”` })
    .click();
  await page.waitForURL(`**/app/requests/${id}`);

  // ---- deadline passed, late uploads allowed: taken and marked late
  await page.getByRole("button", { name: "Edit" }).click();
  const edit = page.getByRole("dialog", { name: "Edit request" });
  const past = new Date(Date.now() - 2 * 86400_000);
  await edit
    .getByLabel("Day", { exact: true })
    .fill(
      `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`,
    );
  await edit.getByRole("switch", { name: /Allow late uploads/ }).click();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Taking late uploads").first()).toBeVisible();
  const lateBytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), randomBytes(1000)]);
  const v3 = await visit(browser, link, "Late Larry", [{ name: "late.pdf", buffer: lateBytes }]);
  await expect(v3.getByText("After the deadline, marked late")).toBeVisible();
  await v3.context().close();
  await expect(page.locator("li").filter({ hasText: "Late Larry" }).getByText("Late", { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // ---- without late uploads: the page says the deadline passed and nothing can be sent
  await page.getByRole("button", { name: "Edit" }).click();
  await edit.getByRole("switch", { name: /Allow late uploads/ }).click();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Deadline passed").first()).toBeVisible({ timeout: 60_000 });
  const ended = await browser.newContext();
  const e = await ended.newPage();
  await e.goto(link);
  await expect(e.getByText("The deadline for this request has passed.")).toBeVisible({ timeout: 60_000 });
  await expect(e.getByLabel("Choose files to upload")).toHaveCount(0);
  await ended.close();

  // ---- closed: refused; reopened: the same link takes uploads again
  await page.getByRole("button", { name: "Edit" }).click();
  await edit.getByRole("switch", { name: /Set a deadline/ }).click();
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Open", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Close request" }).click();
  await expect(page.getByText("Request closed. The link no longer takes uploads.")).toBeVisible({ timeout: 60_000 });
  const closedCtx = await browser.newContext();
  const c = await closedCtx.newPage();
  await c.goto(link);
  await expect(c.getByText("This request is closed.")).toBeVisible({ timeout: 60_000 });
  await c.screenshot({ path: info.outputPath("05-closed.png") });
  await closedCtx.close();
  await page.getByRole("button", { name: "Reopen request" }).click();
  await expect(page.getByText("Request reopened. The same link takes uploads again.")).toBeVisible({ timeout: 60_000 });
  const again = await visit(browser, link, "Hana Mori", [
    { name: "extra.pdf", buffer: Buffer.from("%PDF-1.4\nagain") },
  ]);
  await again.context().close();
  await expect(page.locator("ul[aria-label='Files'] li")).toHaveCount(5, { timeout: 60_000 });

  // ---- delete only once closed; uploads stay in the inbox
  expect(
    (
      await fetch(`${API}/owner/file-requests/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      })
    ).status,
  ).toBe(409);
  await page.getByRole("button", { name: "Close request" }).click();
  await expect(page.getByRole("button", { name: "Delete" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Delete this request?" })
    .getByRole("button", { name: "Delete request" })
    .click();
  await page.waitForURL("**/app/requests");
  expect((await call(`/file-requests/${id}`)).status).toBe(404);
  const inbox = await call<{ rows: { ref: string | null }[] }>("/owner/inbox?box=inbox", token);
  expect(inbox.body.rows.filter((r) => r.ref === `freq:${id}`)).toHaveLength(4);
});

test("file requests: a request under another page's name is refused, an unknown one says so", async ({
  page,
  problems,
}) => {
  const owner = await ensureOwner("e2e-requests-owner", OWNER);
  const token = await apiToken(owner);
  const { requests } = (await call<{ requests: { record: { body: { id: string } } }[] }>("/owner/file-requests", token))
    .body;
  await page.goto("/@mzk-e2e-editor/r/freq_doesnotexist1");
  await expect(page.getByText(/does not exist|isn't available/)).toBeVisible();
  if (requests[0]) {
    await page.goto(`/@mzk-e2e-editor/r/${requests[0].record.body.id}`);
    await expect(page.getByText("This request does not belong to @mzk-e2e-editor.")).toBeVisible();
  }
  // Both refusals are deliberate 404 answers from the page.
  problems.splice(0, problems.length, ...problems.filter((p) => !p.includes("404")));
});

test("file requests on a phone: list, request page and sheet fit", async ({ page, browser }, info) => {
  test.skip(info.project.name !== "phone", "phone layout");
  const owner = await ensureOwner("e2e-requests-owner", OWNER);
  await restoreInBrowser(page, owner.phrase);
  await page.goto("/app/requests");
  await page.getByLabel("Device passphrase").fill("lantern river maple tea");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("heading", { name: "File requests", level: 1 })).toBeVisible();
  // A request to look at on the phone.
  await page.getByRole("button", { name: "New request" }).first().click();
  const sheet = page.getByRole("dialog", { name: "New request" });
  await sheet.getByLabel("Title").fill(`Photos from the trip ${Date.now().toString(36)}`);
  await sheet.getByRole("button", { name: "Create request" }).click();
  const share = page.getByRole("dialog", { name: "Your request is ready" });
  const link = (await share.getByLabel("Request link").innerText()).trim();
  await page.screenshot({ path: info.outputPath("phone-share.png") });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  await share.getByRole("button", { name: "Done" }).click();
  // Back to the list in the app (a full load would lock the account).
  await page.getByRole("link", { name: "All requests" }).click();
  await page.waitForURL("**/app/requests");
  await expect(page.getByRole("table", { name: "File requests" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("phone-list.png"), fullPage: true });
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const v = await ctx.newPage();
  await v.goto(link);
  await expect(v.getByText(/checked against their key on QoreChain/)).toBeVisible({ timeout: 60_000 });
  expect(
    await v.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  await v.screenshot({ path: info.outputPath("phone-request-page.png"), fullPage: true });
  await ctx.close();
});
