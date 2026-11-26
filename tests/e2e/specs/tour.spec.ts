/**
 * The product tour, as a visitor who cannot watch the video: reached from the landing page, every chapter is listed
 * and each screen has loaded, the payments link to their transactions, nothing scrolls sideways, and the page passes
 * an accessibility scan. On a phone the screens stack in one column.
 */
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

test("tour: every chapter, every screen loaded, payments linked to the chain", async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.goto("/");
  await page.getByRole("link", { name: /Or every feature, screen by screen/ }).click();
  await page.waitForURL("**/tour");
  await expect(page.getByRole("heading", { level: 1, name: "Every feature, screen by screen" })).toBeVisible();

  const chapters = page.getByRole("navigation", { name: "Chapters" }).getByRole("link");
  await expect(chapters).toHaveCount(10);
  const figures = page.locator("main figure");
  const count = await figures.count();
  expect(count).toBeGreaterThanOrEqual(40);
  await expect(page.getByText(`${count} screens of Mizuhiki doing real work`, { exact: false })).toBeVisible();

  // Every screen really loaded (lazy images are scrolled into view first).
  for (let i = 0; i < count; i++) await figures.nth(i).scrollIntoViewIfNeeded();
  const broken = await page
    .locator("main figure img")
    .evaluateAll(
      (imgs) =>
        imgs.filter((i) => !(i as HTMLImageElement).complete || (i as HTMLImageElement).naturalWidth === 0).length,
    );
  expect(broken).toBe(0);

  // The settled payments point at their transactions on the explorer.
  const proofs = page.locator("main figcaption a[href*='/tx/']");
  expect(await proofs.count()).toBeGreaterThanOrEqual(4);
  for (const href of await proofs.evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)))
    expect(href).toMatch(/\/tx\/[0-9A-F]{64}$/);

  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  if (info.project.name === "desktop") {
    const a11y = await new AxeBuilder({ page }).analyze();
    expect(a11y.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: info.outputPath("tour.png") });
});
