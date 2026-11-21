/**
 * 5.9 Forms, the owner's side, on testnet, as a real owner in the browser:
 * start from scratch, "/" to insert, @ mentions, choices, a second ending,
 * a logic rule, preview (nothing sent), publish (signed), share and add to
 * the page; then a respondent in their own context answers through the logic;
 * then the owner's Results tab opens the answer on the device and exports it.
 * Also: "Describe your form" with the real helper, and a template.
 */
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { test, expect } from "./fixtures";
import { Purpose, fromUtf8, openItem, verifyRecord, type FormDef, type Signed } from "@mizuhiki/core";
import { pqKeyViaEvm } from "@mizuhiki/chain";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const NAME = "mzk-e2e-editor";

test("owner builds, publishes and shares a form; a respondent answers through the logic; results open on the device", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "runs once on desktop");
  test.setTimeout(480_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const title = `Studio intake ${Date.now().toString(36)}`;

  const octx = await browser.newContext({ acceptDownloads: true });
  const o = await octx.newPage();
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: "Forms" }).first().click();
  await o.waitForURL("**/app/forms");
  await o.getByRole("button", { name: "New form" }).first().click();
  await o.getByRole("button", { name: /Start from scratch/ }).click();
  await o.waitForURL(/\/app\/forms\/f[a-z0-9]+/);
  const formId = new URL(o.url()).pathname.split("/").pop() ?? "";

  await o.getByLabel("Form title").fill(title);
  // "/" filters a list right on the line (typed fast, nothing lost); Enter inserts
  const insert = o.getByLabel("Type / to insert blocks");
  await insert.click();
  await insert.pressSequentially("/short");
  await expect(o.getByRole("option", { name: /Short answer/ })).toBeVisible();
  await insert.press("Enter");
  await o.getByLabel("Question 1 title").fill("What's your name?");
  // the + button opens the full picker with its explanation panel
  await o.getByRole("button", { name: "Insert a block here" }).last().click();
  await expect(o.getByRole("dialog", { name: "Insert anything" })).toBeVisible();
  await o.getByLabel("Search blocks").fill("multiple");
  await expect(o.getByText("Pick one. Respondents can press A, B, C on the keyboard.")).toBeVisible();
  await o.keyboard.press("Enter");
  // @ mention: typing @ offers earlier questions
  const q2 = o.getByLabel("Question 2 title");
  await q2.fill("Thanks ");
  await q2.pressSequentially("@");
  await o.getByRole("option", { name: /@Q1 What's your name\?/ }).click();
  await q2.pressSequentially("what's your budget?");
  await expect(q2).toHaveValue("Thanks @Q1 what's your budget?");
  await o.getByLabel("Choice 1", { exact: true }).fill("Small");
  await o.getByLabel("Choice 2", { exact: true }).fill("Large");
  await insert.click();
  await insert.pressSequentially("/email");
  await insert.press("Enter");
  await o.getByLabel("Question 3 title").fill("Your email");
  // a second ending for small budgets
  await o.getByRole("button", { name: "Add an ending" }).click();
  await o.getByLabel("Title").last().fill("Thanks @Q1, our starter pack fits.");
  await expect(o.getByText("Draft saved, sealed")).toBeVisible({ timeout: 30_000 });
  await o.screenshot({ path: info.outputPath("build.png"), fullPage: true });

  // Logic: after Q2, Small goes to ending 2
  await o.getByRole("tab", { name: "Logic" }).click();
  // one card per question, in order: Q2 is the second
  await o.getByRole("button", { name: "Add branching rule" }).nth(1).click();
  await o.getByLabel("Answer").first().selectOption({ label: "Small" });
  const goTo = o.getByLabel("Rule 1 goes to").first();
  const endingValue = await goTo.locator("option", { hasText: "starter pack" }).first().getAttribute("value");
  await goTo.selectOption(endingValue ?? "");
  await expect(o.getByText("Logic set").first()).toBeVisible();
  await o.screenshot({ path: info.outputPath("logic.png"), fullPage: true });

  // Preview runs the real form and sends nothing
  await o.getByRole("button", { name: "Preview" }).click();
  const pv = o.getByRole("dialog", { name: "Preview" });
  await pv.getByRole("button", { name: "Start" }).click();
  await pv.getByRole("textbox", { name: "What's your name?" }).fill("Preview Person");
  await pv.getByRole("button", { name: "OK" }).click();
  await pv.getByRole("radio", { name: /Small/ }).click();
  // logic: Small skips the email question and ends here
  await pv.getByRole("button", { name: "Submit" }).click();
  await expect(pv.getByText("Preview finished. Nothing was sent.")).toBeVisible();
  await expect(pv.getByRole("heading", { name: "Thanks Preview Person, our starter pack fits." })).toBeVisible();
  await o.keyboard.press("Escape");

  // Publish (signed), then share and add to the page
  await o.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(o.getByText("Published", { exact: true })).toBeVisible({ timeout: 60_000 });
  await o.getByRole("tab", { name: "Share" }).click();
  await expect(o.getByText("Your form is published and ready to be shared.")).toBeVisible();
  const link =
    (await o.locator("body").innerText()).match(/http:\/\/localhost:3000\/@mzk-e2e-editor\/f\/form-[a-z0-9]+/)?.[0] ??
    "";
  expect(link).not.toBe("");
  await o.getByRole("button", { name: "Add to my page" }).click();
  await expect(o.getByText(/on your page|is on your page|Added/i).first()).toBeVisible({ timeout: 60_000 });
  await o.screenshot({ path: info.outputPath("share.png"), fullPage: true });

  // Source of truth: the published definition is signed by the owner's key on chain; the page has the button.
  const slug = link.split("/").pop() ?? "";
  const served = (await (await fetch(`${API}/forms/${NAME}/${slug}`)).json()) as { record: Signed<FormDef> };
  const pq = await pqKeyViaEvm(owner.address);
  const def = verifyRecord(served.record, {
    kind: "form",
    signer: owner.address,
    pqPublicKey: pq.publicKey ?? new Uint8Array(),
  });
  expect(def.title).toBe(title);
  expect(def.logic).toHaveLength(1);
  const page = (await (await fetch(`${API}/pages/${NAME}`)).json()) as {
    record: { body: { blocks: { type: string; formId?: string }[] } };
  };
  expect(page.record.body.blocks.some((b) => b.type === "form" && b.formId === formId)).toBe(true);

  // ---- a respondent answers
  const rctx = await browser.newContext();
  const r = await rctx.newPage();
  // As a visitor would: open the public page and tap the form's button (it opens the form, Back returns).
  await r.goto(`/@${NAME}`);
  await r.getByRole("button", { name: title }).click();
  await r.waitForURL(`**/f/${slug}`);
  await r.goBack();
  await r.waitForURL(`**/@${NAME}`);
  await r.goto(link);
  await r.getByRole("button", { name: "Start" }).click();
  await r.getByRole("textbox", { name: "What's your name?" }).fill("Aiko");
  await r.keyboard.press("Enter");
  await expect(r.getByRole("heading", { name: /Thanks Aiko what's your budget\?/ })).toBeVisible();
  // Large is not covered by the rule, so they continue in order to the email question
  await r.getByRole("radio", { name: /Large/ }).click();
  await r.getByRole("button", { name: "OK" }).click();
  await r.getByRole("textbox", { name: "Your email" }).fill("aiko@example.com");
  await r.getByRole("button", { name: "Submit" }).click();
  await expect(
    r.getByRole("heading", { name: "Thank you. Your answers are sealed and stored for the form's readers." }),
  ).toBeVisible({
    timeout: 120_000,
  });
  await rctx.close();

  // Source of truth: one envelope that only the owner's key opens
  const token = await apiToken(owner);
  const st = (await (
    await fetch(`${API}/owner/forms/${formId}/stats`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { responses: { hash: string }[]; submissions: number };
  expect(st.responses).toHaveLength(1);
  // content-blind counters: one view, one start, one submission (the preview counted nothing)
  expect(st).toMatchObject({ views: 1, starts: 1, submissions: 1 });
  const env = new Uint8Array(await (await fetch(`${API}/blobs/${st.responses[0]?.hash ?? ""}`)).arrayBuffer());
  const ans = JSON.parse(fromUtf8(openItem({ purpose: Purpose.form(formId), envelope: env, keys: owner.seal }))) as {
    answers: Record<string, unknown>;
  };
  expect(Object.values(ans.answers)).toContain("Aiko");

  // ---- results open on the owner's device and export
  await o.getByRole("tab", { name: "Results" }).click();
  await expect(o.getByText("Aiko").first()).toBeVisible({ timeout: 60_000 });
  await o.screenshot({ path: info.outputPath("results.png"), fullPage: true });
  const download = async (format: "CSV file" | "XLSX file" | "PDF file") => {
    await o.getByRole("button", { name: "Download", exact: true }).first().click();
    const dlg = o.getByRole("dialog", { name: "Choose a file to download" });
    await dlg.getByRole("radio", { name: new RegExp(format) }).click();
    const [d] = await Promise.all([
      o.waitForEvent("download"),
      dlg.getByRole("button", { name: "Download", exact: true }).click(),
    ]);
    return d.path();
  };
  const csv = await readFile(await download("CSV file"), "utf8");
  expect(csv).toContain("Aiko");
  expect(csv).toContain("aiko@example.com");
  expect(csv).toContain("Large");
  const xlsx = await readFile(await download("XLSX file"));
  expect(xlsx.subarray(0, 2).toString()).toBe("PK");
  // the PDF is read back as drawn (OCR), not just its text layer
  const pdfPath = await download("PDF file");
  execFileSync("pdftoppm", ["-r", "150", "-png", "-f", "1", "-l", "1", pdfPath, `${pdfPath}-page`]);
  const ocr = execFileSync("tesseract", [`${pdfPath}-page-1.png`, "-", "--psm", "4"]).toString();
  expect(ocr).toContain(title.split(" ")[0] ?? "Studio");
  expect(ocr).toMatch(/Large/);
  await octx.close();
});

test("start a form from a description (real helper) and from a template", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "runs once");
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  await restoreInBrowser(page, owner.phrase);
  await page.getByRole("link", { name: "Forms" }).first().click();
  await page.getByRole("button", { name: "New form" }).first().click();
  await page
    .getByLabel("What should it ask?")
    .fill("A short RSVP for my tea tasting: name, will you come, how many guests, any allergies.");
  await page.getByRole("button", { name: "Draft it" }).click();
  await page.waitForURL(/\/app\/forms\/f[a-z0-9]+/, { timeout: 120_000 });
  await expect(page.getByLabel("Question 3 title")).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: info.outputPath("ai-draft.png"), fullPage: true });
  await page.getByRole("link", { name: "Forms" }).first().click();
  await page.getByRole("button", { name: "New form" }).first().click();
  await page.getByRole("button", { name: /Client intake/ }).click();
  await page.waitForURL(/\/app\/forms\/f[a-z0-9]+/);
  await expect(page.getByLabel("Question 7 title")).toHaveValue("Your email");
});

test("settings: an added reader opens answers with their own key; closing the form refuses respondents", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "runs once");
  test.setTimeout(420_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const reader = await ensureOwner("e2e-visitor", "mzk-e2e-visitor");
  const octx = await browser.newContext();
  const o = await octx.newPage();
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: "Forms" }).first().click();
  await o.getByRole("button", { name: "New form" }).first().click();
  await o.getByRole("button", { name: /Contact me/ }).click();
  await o.waitForURL(/\/app\/forms\/f[a-z0-9]+/);
  const formId = new URL(o.url()).pathname.split("/").pop() ?? "";
  await o.getByRole("tab", { name: "Settings" }).click();
  await o.getByLabel("Add a reader (e.g. an assistant)").fill("mzk-e2e-visitor");
  await o.getByRole("button", { name: "Add reader" }).click();
  await expect(o.getByText("@mzk-e2e-visitor").first()).toBeVisible({ timeout: 30_000 });
  await o.screenshot({ path: info.outputPath("settings.png"), fullPage: true });
  await o.getByRole("tab", { name: "Build" }).click();
  await o.screenshot({ path: info.outputPath("build-template.png"), fullPage: true });
  await o.getByRole("tab", { name: "Settings" }).click();
  await o.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(o.getByText("Published", { exact: true })).toBeVisible({ timeout: 60_000 });
  await o.getByRole("tab", { name: "Share" }).click();
  const link =
    (await o.locator("body").innerText()).match(/http:\/\/localhost:3000\/@mzk-e2e-editor\/f\/[a-z0-9-]+/)?.[0] ?? "";

  // a respondent sees both readers named, and answers
  const r = await (await browser.newContext()).newPage();
  await r.goto(link);
  await expect(r.getByText(`Only @${NAME} and @mzk-e2e-visitor can read them.`, { exact: false })).toBeVisible({
    timeout: 30_000,
  });
  await r.getByRole("button", { name: "Start" }).click();
  await r.getByRole("textbox", { name: "What's your name?" }).fill("Mila");
  await r.keyboard.press("Enter");
  await r.getByRole("textbox", { name: /Your email/ }).fill("mila@example.com");
  await r.keyboard.press("Enter");
  await r.getByRole("textbox", { name: /What would you like to say/ }).fill("Hello from Mila");
  await r.getByRole("button", { name: "Submit" }).click();
  await expect(r.getByText("Sent, sealed.")).toBeVisible({ timeout: 120_000 });

  // Source of truth: the envelope opens with the reader's own key too (two readers)
  const token = await apiToken(owner);
  const st = (await (
    await fetch(`${API}/owner/forms/${formId}/stats`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { responses: { hash: string; readers: number }[] };
  expect(st.responses[0]?.readers).toBe(2);
  const env = new Uint8Array(await (await fetch(`${API}/blobs/${st.responses[0]?.hash ?? ""}`)).arrayBuffer());
  for (const keys of [owner.seal, reader.seal]) {
    const a = JSON.parse(fromUtf8(openItem({ purpose: Purpose.form(formId), envelope: env, keys }))) as {
      answers: Record<string, unknown>;
    };
    expect(Object.values(a.answers)).toContain("Hello from Mila");
  }

  // close the form, publish: the respondent's link now refuses
  await o.getByRole("tab", { name: "Settings" }).click();
  await o.getByText("Close the form now").click();
  await o.getByRole("button", { name: "Publish changes" }).click();
  await expect(o.getByText("Published", { exact: true })).toBeVisible({ timeout: 60_000 });
  await r.goto(link);
  await expect(r.getByText("This form is closed.")).toBeVisible({ timeout: 30_000 });
  await octx.close();
});

test("the form editor on a phone: every tab fits", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone");
  test.setTimeout(180_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  await restoreInBrowser(page, owner.phrase);
  await page.getByRole("navigation", { name: "Owner sections" }).last().getByRole("link", { name: "Forms" }).click();
  await page.getByRole("button", { name: "New form" }).first().click();
  await page.getByRole("button", { name: /Client intake/ }).click();
  await page.waitForURL(/\/app\/forms\/f[a-z0-9]+/);
  for (const tab of ["Build", "Logic", "Settings", "Share", "Results"]) {
    await page.getByRole("tab", { name: tab }).click();
    await page.waitForTimeout(400); // let the tab's entrance animation settle for the screenshot
    const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
    expect(sw, `${tab} has no sideways scroll`).toBeLessThanOrEqual(iw);
    await page.screenshot({ path: info.outputPath(`phone-${tab.toLowerCase()}.png`), fullPage: true });
  }
  // the phone tab bar keeps four places and puts every other section under More
  const bar = page.getByRole("navigation", { name: "Owner sections" }).last();
  await expect(bar.getByRole("link")).toHaveCount(4);
  await bar.getByRole("button", { name: "More" }).click();
  const all = page.getByRole("dialog", { name: "Everything" });
  await expect(all.getByRole("button", { name: "Lock now" })).toBeVisible();
  await page.screenshot({ path: info.outputPath("phone-more.png") });
  await all.getByRole("link", { name: "Proofs" }).click();
  await page.waitForURL("**/app/proof");
  await expect(page.getByRole("heading", { name: "Proofs" })).toBeVisible();
});
