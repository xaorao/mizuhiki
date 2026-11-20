/**
 * High-contrast mode (spec 4.8). A visitor whose device asks for more contrast gets it before the first paint,
 * with no flash and no CSP error; an owner can turn it on or off in Settings, the choice survives a reload, and
 * "Follow this device" goes back to the device setting. Source of truth: the root element's data-theme and the
 * computed colours (white ground, black ink).
 */
import { test, expect } from "./fixtures";
import { ensureOwner, gotoUnlocked, restoreInBrowser } from "./owner";

const NAME = "mzk-e2e-editor";
const theme = (p: import("@playwright/test").Page) => p.evaluate(() => document.documentElement.dataset.theme ?? null);
const colours = (p: import("@playwright/test").Page) =>
  p.evaluate(() => {
    const cs = getComputedStyle(document.body);
    return { bg: cs.backgroundColor, ink: cs.color };
  });

test("high contrast follows the device before the first paint, on public pages", async ({ browser }, info) => {
  const ctx = await browser.newContext({ ...(info.project.use as object), contrast: "more" });
  const p = await ctx.newPage();
  const errors: string[] = [];
  p.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  p.on("pageerror", (e) => errors.push(e.message));
  // Read the attribute as soon as the HTML is parsed: before React or any stylesheet-driven paint.
  await p.goto("/", { waitUntil: "commit" });
  await p.waitForFunction(() => document.readyState !== "loading" || !!document.body);
  await expect.poll(() => theme(p)).toBe("contrast");
  await p.waitForLoadState("networkidle");
  expect(await theme(p)).toBe("contrast");
  expect(await colours(p)).toEqual({ bg: "rgb(255, 255, 255)", ink: "rgb(0, 0, 0)" });
  await p.screenshot({ path: info.outputPath("landing-contrast.png") });
  for (const path of [`/@${NAME}`, "/proof", "/login"]) {
    await p.goto(path, { waitUntil: "networkidle" });
    expect(await theme(p), path).toBe("contrast");
    await p.screenshot({
      path: info.outputPath(`${path.replace(/[^a-z@-]/g, "") || "root"}-contrast.png`),
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
  await ctx.close();

  // A device that does not ask for it gets the normal theme.
  const plain = await browser.newContext({ ...(info.project.use as object), contrast: "no-preference" });
  const q = await plain.newPage();
  await q.goto("/", { waitUntil: "networkidle" });
  expect(await theme(q)).toBeNull();
  await plain.close();
});

test("high contrast in Settings: on, kept after a reload, off, and back to the device", async ({ browser }, info) => {
  test.setTimeout(240_000);
  const owner = await ensureOwner("e2e-editor", NAME);
  const ctx = await browser.newContext({ ...(info.project.use as object), contrast: "more" });
  const p = await ctx.newPage();
  await restoreInBrowser(p, owner.phrase);
  await gotoUnlocked(p, "/app/settings");
  const control = p.getByRole("group", { name: "High contrast" });
  await expect(control).toBeVisible();
  // Follows the device by default, and the device asks for more contrast.
  await expect(control.getByRole("button", { name: "Follow this device" })).toHaveAttribute("aria-pressed", "true");
  expect(await theme(p)).toBe("contrast");

  await control.getByRole("button", { name: "Off" }).click();
  expect(await theme(p)).toBeNull();
  await p.screenshot({ path: info.outputPath("settings-off.png") });
  await gotoUnlocked(p, "/app/settings");
  expect(await theme(p)).toBeNull();
  await expect(p.getByRole("button", { name: "Off" })).toHaveAttribute("aria-pressed", "true");

  await p.getByRole("button", { name: "On" }).click();
  expect(await theme(p)).toBe("contrast");
  await p.locator("#display").scrollIntoViewIfNeeded();
  await p.screenshot({ path: info.outputPath("settings-on.png") });
  await gotoUnlocked(p, "/app/inbox");
  expect(await theme(p)).toBe("contrast");
  await p.screenshot({ path: info.outputPath("inbox-contrast.png"), fullPage: true });

  // Back to the device: still on, because this device asks for more contrast.
  await gotoUnlocked(p, "/app/settings");
  await p.getByRole("button", { name: "Follow this device" }).click();
  expect(await theme(p)).toBe("contrast");
  await p.emulateMedia({ contrast: "no-preference" });
  await expect.poll(() => theme(p)).toBeNull();
  await ctx.close();
});
