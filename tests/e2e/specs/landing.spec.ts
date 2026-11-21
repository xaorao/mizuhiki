/**
 * 5.1 Landing: every section present in order, the claim box in every state
 * against the live registry (available, taken with three suggestions, too
 * short, characters names cannot hold, bad edges, reserved), the typed name
 * pre-filling sign-up, "Try it" sealing with the real QoreSeal library and
 * opening only with the right key, the app tour by mouse and keyboard, the
 * proof cards confirmed by QoreChain, FAQ, the brand 404, icons and the
 * social card, and the phone layout. Zero console errors (fixtures).
 */
import { chainRest } from "@mizuhiki/chain";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

const SECTIONS = [
  "One link for everything private.",
  "Twelve blocks. One lock on all of them.",
  "Build your private page in minutes.",
  "How sealing works.",
  "Share it wherever clients find you.",
  "Your private desk, behind the page.",
  "See what came in. We only see that something did.",
  "Why lock it for the quantum age now.",
  "Built on QoreChain. Checked on the live test network.",
  "A private page for every kind of work.",
  "We tell you what stays public first.",
  "Questions? Answered.",
  "Claim your private page today.",
];

test("landing: sections, claim box states, sign-up pre-fill", async ({ page }, info) => {
  await page.goto("/");
  const heads = await page.locator("h1, h2").allInnerTexts();
  const order = SECTIONS.map((t) => heads.findIndex((h) => h.replace(/\s+/g, " ").trim() === t));
  expect(order.every((i) => i >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  await expect(page.getByRole("list").filter({ hasText: "Pay me" }).getByRole("listitem")).toHaveCount(12);

  const box = page.getByLabel("Your page name").first();
  const status = page.getByRole("status").first();
  await box.fill("ab");
  await box.blur();
  await expect(status).toHaveText("Usernames must be 3 characters or longer");
  await box.fill("Ana Lee!");
  await expect(box).toHaveValue("analee");
  await box.fill("-abc");
  await expect(status).toContainText(/letter or number|start and end/i);
  await box.fill("admin");
  await expect(status).not.toHaveText("It's available!");
  // Taken on the registry: three suggestions, each one usable.
  await box.fill("aria");
  await expect(status).toContainText("That's taken.", { timeout: 20_000 });
  const tries = status.getByRole("button");
  await expect(tries).toHaveCount(3);
  const pick = ((await tries.first().innerText()) || "").replace(/^@/, "");
  await tries.first().click();
  await expect(box).toHaveValue(pick);
  await expect(status).toHaveText("It's available!", { timeout: 20_000 });
  // Free: claim goes to sign-up with the name filled in.
  const free = `mzk-land-${Date.now().toString(36)}`;
  await box.fill(free);
  await expect(status).toHaveText("It's available!", { timeout: 20_000 });
  await page.screenshot({ path: info.outputPath("claim-available.png") });
  await page.getByRole("button", { name: "Claim your page" }).first().click();
  await page.waitForURL(`**/signup?name=${free}`);
  await expect(page.getByLabel("Page name")).toHaveValue(free);
});

test("landing: Try it seals with QoreSeal and opens only with the owner's key", async ({ page }) => {
  await page.goto("/#how");
  const text = page.getByLabel("Your message");
  await text.fill("");
  await page.getByRole("button", { name: "Seal it in this browser" }).click();
  await expect(page.getByText(/Write something first/)).toContainText(
    "Write something first. Nothing has left your browser.",
  );
  const secret = `Lab result for Hana, ${Date.now()}`;
  await text.fill(secret);
  await page.getByRole("button", { name: "Seal it in this browser" }).click();
  const size = page.locator("dt", { hasText: "Size" }).locator("xpath=following-sibling::dd");
  await expect(size).toContainText("bytes", { timeout: 20_000 });
  // An ML-KEM-1024 envelope: the 1568-byte KEM ciphertext alone is larger than the note.
  expect(Number((await size.innerText()).replace(/\D/g, ""))).toBeGreaterThan(1568);
  // The stored copy shows none of the words.
  expect(await page.locator('[aria-live="polite"]').allInnerTexts()).not.toContain(secret);
  expect((await page.locator('[aria-live="polite"]').allInnerTexts()).join(" ")).not.toContain("Lab result");
  await page.getByRole("button", { name: "Try a different key" }).click();
  await expect(page.getByText("That key cannot open it.")).toBeVisible();
  await page.getByRole("button", { name: "Open with the owner’s key" }).click();
  await expect(page.getByText(`Opened: “${secret}”`)).toBeVisible();
});

test("landing: app tour by mouse and keyboard, proof read from QoreChain, FAQ", async ({ page }) => {
  await page.goto("/");
  const tabs = page.getByRole("tablist", { name: "Owner app tour" });
  await tabs.getByRole("tab", { name: /Rooms/ }).click();
  await expect(page.getByRole("tabpanel").getByRole("img")).toHaveAttribute("alt", /Spring launch/);
  await page.keyboard.press("ArrowDown");
  await expect(tabs.getByRole("tab", { name: /Capsules/ })).toHaveAttribute("aria-selected", "true");
  await expect(tabs.getByRole("tab", { name: /Capsules/ })).toBeFocused();
  await expect(page.getByRole("tabpanel").getByRole("img")).toHaveAttribute("alt", /armed capsule/);

  // Each proof card says "Confirmed in block N"; the chain agrees.
  const cards = page.locator('a[href*="/tx/"]');
  await expect(cards).toHaveCount(4);
  for (const card of await cards.all()) {
    await expect(card).toContainText(/Confirmed in block [\d,]+/, { timeout: 30_000 });
    const hash = (await card.getAttribute("href"))?.split("/tx/")[1] ?? "";
    const block = (await card.innerText()).match(/block ([\d,]+)/)?.[1]?.replace(/,/g, "");
    const tx = (await (await fetch(`${chainRest()}/cosmos/tx/v1beta1/txs/${hash}`)).json()) as {
      tx_response: { height: string; code: number };
    };
    expect(tx.tx_response.code).toBe(0);
    expect(tx.tx_response.height).toBe(block);
  }

  const q = page.getByText("What if I lose my phone?");
  await q.click();
  await expect(page.getByText(/enough of them together rebuild it after a 48-hour wait/)).toBeVisible();
});

test("landing: links, brand 404, icons and the social card", async ({ page, request }, info) => {
  await page.goto("/");
  if (info.project.name === "phone") {
    // Narrow screens: the section links and Log in live in the menu.
    await page.getByRole("button", { name: "Open menu" }).click();
    const menu = page.getByRole("navigation", { name: "Menu" });
    await expect(menu).toBeVisible();
    expect(await menu.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 253, 251)");
    await page.waitForTimeout(400);
    await page.screenshot({ path: info.outputPath("menu-open.png") });
    await menu.getByRole("link", { name: "Questions" }).click();
    await expect(page).toHaveURL(/#faq$/);
    await expect(menu).toHaveCount(0);
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Menu" })).toHaveCount(0);
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("navigation", { name: "Menu" }).getByRole("link", { name: "Log in" }).click();
  } else {
    await page.getByRole("navigation", { name: "Product" }).getByRole("link", { name: "Questions" }).click();
    await expect(page).toHaveURL(/#faq$/);
    await page.getByRole("link", { name: "Log in", exact: true }).click();
  }
  await page.waitForURL("**/login");
  for (const path of ["/icon.svg", "/apple-icon.png", "/opengraph-image"]) {
    const r = await request.get(path);
    expect(r.status(), path).toBe(200);
  }
  const og = await request.get("/opengraph-image");
  expect(og.headers()["content-type"]).toContain("image/png");
  await page.goto("/");
  expect(await page.locator('meta[property="og:image"]').getAttribute("content")).toContain("opengraph-image");
  // The demo pages the gallery links to are live.
  for (const n of ["aria", "rohan.law", "sunrise.clinic", "maya.studio", "kapoor.family"]) {
    expect((await request.get(`/@${n}`)).status(), n).toBe(200);
  }
});

test("landing: brand 404", async ({ page, problems }) => {
  const r = await page.goto("/no-such-place-here");
  expect(r?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Nothing lives at this address." })).toBeVisible();
  await page.getByRole("link", { name: "Go to Mizuhiki" }).click();
  await page.waitForURL((u) => u.pathname === "/");
  // The 404 document itself is the expected outcome here.
  problems.splice(0, problems.length, ...problems.filter((p) => !p.includes("404")));
});

test("landing: accessibility and the phone layout", async ({ page }, info) => {
  await page.goto("/");
  const h = await page.evaluate(() => document.body.scrollHeight);
  for (let y = 0; y < h; y += 600) await page.evaluate((v) => window.scrollTo(0, v), y);
  await page.evaluate(() => window.scrollTo(0, 0));
  // Let the sections finish rising in before measuring colours.
  await page.waitForTimeout(1200);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
  ).toBeLessThanOrEqual(0);
  const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await page.screenshot({ path: info.outputPath(`landing-${info.project.name}.png`) });
});
