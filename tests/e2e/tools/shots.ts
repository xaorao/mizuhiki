/**
 * Screenshots of a page at desktop 1440 and phone 390, with console, page-error
 * and failed-request listeners attached at context creation (QA guide Part 9).
 * Usage: tsx tools/shots.ts <url> <outDir> [name]
 */
import { chromium, devices } from "@playwright/test";
import { mkdirSync } from "node:fs";

const [url, out = "shots", name = "page"] = process.argv.slice(2);
if (!url) throw new Error("usage: shots <url> <outDir> [name]");
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const problems: string[] = [];
for (const [label, opts] of [
  ["desktop", { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ["phone", { ...devices["iPhone 14"], viewport: { width: 390, height: 844 } }],
] as const) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") problems.push(`[${label}] console.${m.type()}: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`[${label}] pageerror: ${e.message}`));
  page.on("requestfailed", (r) =>
    problems.push(`[${label}] requestfailed: ${r.url()} ${r.failure()?.errorText ?? ""}`),
  );
  await page.goto(url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  const [scrollW, innerW] = await page.evaluate(
    () => [document.documentElement.scrollWidth, window.innerWidth] as const,
  );
  if (scrollW > innerW) problems.push(`[${label}] sideways scroll: ${scrollW} > ${innerW}`);
  await page.screenshot({ path: `${out}/${name}-${label}.png`, fullPage: true });
  await ctx.close();
}
await browser.close();
console.log(problems.length ? problems.join("\n") : "no console errors, no failed requests, no sideways scroll");
