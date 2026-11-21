/**
 * 5.9 Forms, the respondent's side, on testnet. The form is published the way
 * the builder publishes (signed by the owner, sealed draft). A respondent with
 * no account answers in their own context: welcome, recall, letter keys, the
 * required error, the choices hint, logic jumps, a sealed file and a drawn
 * signature, then "Sent, sealed". Source of truth: the envelope opened with the
 * owner's key (answers, file bytes, signature PNG), the counters, and the
 * closed and forged states.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { test, expect } from "./fixtures";
import { PSQL } from "./pg";
import {
  Purpose,
  decryptFile,
  fromUtf8,
  openItem,
  sealItem,
  publicRecipient,
  signRecord,
  utf8,
  type FileFacts,
  type FormDef,
} from "@mizuhiki/core";
import { API, apiToken, ensureOwner } from "./owner";

const NAME = "mzk-e2e-editor";
const DEV_DB = process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki";

type Owner = Awaited<ReturnType<typeof ensureOwner>>;

export async function publishForm(
  owner: Owner,
  def: Omit<FormDef, "version" | "updatedAt" | "owner" | "name">,
): Promise<FormDef> {
  const token = await apiToken(owner);
  const list = (await (
    await fetch(`${API}/owner/forms`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as { forms: { id: string; published: { version: number } | null }[] };
  const version = (list.forms.find((f) => f.id === def.id)?.published?.version ?? 0) + 1;
  const full: FormDef = {
    ...def,
    owner: owner.address,
    name: owner.name,
    version,
    updatedAt: new Date().toISOString(),
  };
  const draft = sealItem({
    purpose: Purpose.form(def.id),
    readers: [publicRecipient(owner.seal)],
    plaintext: utf8(JSON.stringify(full)),
    context: "draft",
    anonymous: true,
  });
  await fetch(`${API}/blobs`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.from(draft.envelope),
  });
  const r = await fetch(`${API}/forms`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      id: def.id,
      slug: def.slug,
      draftEnvelope: draft.hash,
      publish: signRecord({
        kind: "form",
        body: full,
        signer: owner.address,
        classical: owner.classical,
        pq: owner.pq,
      }),
    }),
  });
  if (!r.ok) throw new Error(`publish ${r.status} ${await r.text()}`);
  return full;
}

const base = (id: string, slug: string): Omit<FormDef, "version" | "updatedAt" | "owner" | "name"> => ({
  v: 1,
  id,
  slug,
  title: "Kinari client intake",
  description: "Tell us about your project. About two minutes.",
  welcome: { enabled: true, button: "Let's go", showTime: true },
  blocks: [
    {
      id: "name",
      kind: "short",
      title: "What's your name?",
      description: "",
      required: true,
      hidden: false,
      half: false,
      placeholder: "",
    },
    {
      id: "budget",
      kind: "choice",
      title: "Thanks {{name}}. What's your budget?",
      description: "",
      required: true,
      hidden: false,
      half: false,
      choices: [
        { id: "small", label: "Under 500 fUSD" },
        { id: "big", label: "500 fUSD or more" },
      ],
      other: false,
      randomize: false,
    },
    {
      id: "why",
      kind: "long",
      title: "Tell us a little more",
      description: "",
      required: false,
      hidden: false,
      half: false,
      placeholder: "",
    },
    {
      id: "services",
      kind: "checkboxes",
      title: "Which services?",
      description: "",
      required: true,
      hidden: false,
      half: false,
      choices: [
        { id: "logo", label: "Logo" },
        { id: "site", label: "Website" },
        { id: "print", label: "Print" },
      ],
      other: false,
      none: false,
      randomize: false,
      minPick: 1,
      maxPick: 2,
    },
    { id: "email", kind: "email", title: "Your email", description: "", required: true, hidden: false, half: false },
    {
      id: "brief",
      kind: "file",
      title: "Upload your brief",
      description: "",
      required: true,
      hidden: false,
      half: false,
      maxFiles: 1,
      maxMB: 5,
    },
    {
      id: "sign",
      kind: "signature",
      title: "Sign to confirm",
      description: "",
      required: true,
      hidden: false,
      half: false,
    },
  ],
  endings: [
    { id: "end-big", title: "Thanks {{name}}! We'll call you this week.", body: "" },
    { id: "end-small", title: "Thanks {{name}}! Our starter pack fits you.", body: "" },
  ],
  // small budgets skip "why"; big budgets see it
  logic: [
    { after: "budget", rules: [{ when: [{ q: "budget", op: "is", value: "small" }], to: "services" }], otherwise: "" },
    {
      after: "sign",
      rules: [{ when: [{ q: "budget", op: "is", value: "small" }], to: "end-small" }],
      otherwise: "end-big",
    },
  ],
  settings: { progress: true, numbers: true, closed: false, notify: true, language: "en" },
  readers: [],
  hideReaders: false,
  design: {},
  preview: { title: "", description: "" },
});

test("a respondent fills a form: recall, keys, errors, logic, sealed file and signature; only the owner can open it", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "runs once on desktop; phone below");
  test.setTimeout(300_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const slug = `intake-${Date.now().toString(36)}`;
  const def = await publishForm(owner, base(`frm${Date.now().toString(36)}`, slug));
  const brief = randomBytes(30_000);

  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  await p.goto(`/@${NAME}/f/${slug}`);
  await expect(p.getByRole("heading", { name: "Kinari client intake" })).toBeVisible({ timeout: 30_000 });
  await expect(p.getByText(/Takes \d+ min/)).toBeVisible();
  await expect(p.getByText(`Your answers are sealed on this device. Only @${NAME} can read them.`)).toBeVisible();
  await p.getByRole("button", { name: "Let's go" }).click();
  // required error stays on the question
  await p.keyboard.press("Enter");
  await expect(p.getByRole("alert").getByText("Please fill this in")).toBeVisible();
  await p.getByRole("textbox", { name: "What's your name?" }).fill("Rohan");
  await p.keyboard.press("Enter");
  // recall, then a letter key picks a choice
  await expect(p.getByRole("heading", { name: /Thanks Rohan\. What's your budget\?/ })).toBeVisible();
  await p
    .getByRole("radiogroup")
    .click({ position: { x: 1, y: 1 } })
    .catch(() => undefined);
  await p.locator("body").press("a");
  await expect(p.getByRole("radio", { name: /Under 500 fUSD/ })).toHaveAttribute("aria-checked", "true");
  await p.getByRole("button", { name: "OK" }).click();
  // logic: small budget skipped "why"
  await expect(p.getByRole("heading", { name: /Which services\?/ })).toBeVisible();
  await expect(p.getByText("Make between 1 and 2 choices")).toBeVisible();
  for (const c of ["Logo", "Website", "Print"]) await p.getByRole("checkbox", { name: new RegExp(c) }).click();
  await p.getByRole("button", { name: "OK" }).click();
  await expect(p.getByRole("alert").getByText("Make between 1 and 2 choices")).toBeVisible();
  await p.getByRole("checkbox", { name: /Print/ }).click();
  await p.getByRole("button", { name: "OK" }).click();
  await p.getByRole("textbox", { name: "Your email" }).fill("rohan@");
  await p.keyboard.press("Enter");
  await expect(p.getByText("Hmm, that email doesn't look right")).toBeVisible();
  await p.getByRole("textbox", { name: "Your email" }).fill("rohan@leafkettle.example");
  await p.keyboard.press("Enter");
  await p
    .locator('input[type="file"]')
    .setInputFiles({ name: "brief.pdf", mimeType: "application/pdf", buffer: brief });
  await expect(p.getByText(/brief\.pdf/)).toBeVisible();
  await p.getByRole("button", { name: "OK" }).click();
  const pad = p.getByRole("img", { name: /Signature area/ });
  const box = await pad.boundingBox();
  if (!box) throw new Error("no signature pad");
  await p.mouse.move(box.x + 30, box.y + 120);
  await p.mouse.down();
  for (let i = 1; i <= 12; i++) await p.mouse.move(box.x + 30 + i * 22, box.y + 120 - Math.sin(i / 2) * 50);
  await p.mouse.up();
  await expect(p.getByText("Signed. It is sealed with your answers.")).toBeVisible();
  await p.screenshot({ path: info.outputPath("signature.png") });
  await p.getByRole("button", { name: "Submit" }).click();
  await expect(p.getByText("Sent, sealed.")).toBeVisible({ timeout: 120_000 });
  await expect(p.getByRole("heading", { name: "Thanks Rohan! Our starter pack fits you." })).toBeVisible();
  await p.screenshot({ path: info.outputPath("ending.png") });

  // Source of truth: the owner's stats list one response; its envelope opens with the owner's key.
  const token = await apiToken(owner);
  const st = (await (
    await fetch(`${API}/owner/forms/${def.id}/stats`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as {
    views: number;
    starts: number;
    submissions: number;
    reach: Record<string, number>;
    responses: { hash: string }[];
  };
  expect(st).toMatchObject({ views: 1, starts: 1, submissions: 1 });
  expect(st.reach.why).toBeUndefined();
  expect(st.reach.services).toBe(1);
  expect(st.responses).toHaveLength(1);
  const env = new Uint8Array(await (await fetch(`${API}/blobs/${st.responses[0]?.hash ?? ""}`)).arrayBuffer());
  const got = JSON.parse(fromUtf8(openItem({ purpose: Purpose.form(def.id), envelope: env, keys: owner.seal }))) as {
    answers: Record<string, unknown>;
    files: Record<string, FileFacts[]>;
    ending: string;
  };
  expect(got.answers).toMatchObject({
    name: "Rohan",
    budget: "small",
    services: ["logo", "site"],
    email: "rohan@leafkettle.example",
  });
  expect(got.answers.why).toBeUndefined();
  expect(got.ending).toBe("end-small");
  const fetchChunk = async (h: string) => new Uint8Array(await (await fetch(`${API}/blobs/${h}`)).arrayBuffer());
  const briefBack = await decryptFile({ facts: got.files.brief?.[0] as FileFacts, fetchChunk });
  expect(Buffer.concat(briefBack).equals(brief)).toBe(true);
  const sig = Buffer.concat(await decryptFile({ facts: got.files.sign?.[0] as FileFacts, fetchChunk }));
  expect(sig.subarray(1, 4).toString()).toBe("PNG");
  expect(Buffer.from(env).includes(Buffer.from("Rohan"))).toBe(false);
  await ctx.close();
});

test("closed and forged forms are refused", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "runs once");
  test.setTimeout(180_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const slug = `closed-${Date.now().toString(36)}`;
  const id = `frm${Date.now().toString(36)}c`;
  await publishForm(owner, {
    ...base(id, slug),
    settings: { progress: true, numbers: true, closed: true, notify: true, language: "en" },
  });
  await page.goto(`/@${NAME}/f/${slug}`);
  await expect(page.getByText("This form is closed.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Let's go" })).toHaveCount(0);
  // someone with database access edits a published form: the browser refuses it
  const slug2 = `forged-${Date.now().toString(36)}`;
  await publishForm(owner, base(`frm${Date.now().toString(36)}f`, slug2));
  execFileSync(PSQL, [
    DEV_DB,
    "-q",
    "-c",
    `update forms set record = jsonb_set(record, '{body,title}', '"Send us your password"') where slug = '${slug2}'`,
  ]);
  await page.goto(`/@${NAME}/f/${slug2}`);
  await expect(page.getByRole("heading", { name: "This form could not be verified" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Send us your password")).toHaveCount(0);
  // Not in the tab title or the link preview either: the server verifies before using a record's words.
  await expect(page).toHaveTitle("This form could not be verified · Mizuhiki");
  for (const sel of ['meta[property="og:title"]', 'meta[name="twitter:title"]', 'meta[name="description"]'])
    for (const c of await page.locator(sel).evaluateAll((els) => els.map((e) => e.getAttribute("content") ?? "")))
      expect(c, sel).not.toContain("Send us your password");
  await page.goto(`/@${NAME}/f/no-such-form`);
  await expect(page.getByRole("heading", { name: "This form isn't available." })).toBeVisible();
});

test("a form on a phone fits and moves with the keyboard buttons", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone");
  test.setTimeout(120_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const slug = `phone-${Date.now().toString(36)}`;
  await publishForm(owner, base(`frm${Date.now().toString(36)}p`, slug));
  await page.goto(`/@${NAME}/f/${slug}`);
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.getByRole("textbox", { name: "What's your name?" }).fill("Mila");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(page.getByRole("heading", { name: /Thanks Mila/ })).toBeVisible();
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: info.outputPath("form-phone.png") });
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByRole("textbox", { name: "What's your name?" })).toHaveValue("Mila");
});
