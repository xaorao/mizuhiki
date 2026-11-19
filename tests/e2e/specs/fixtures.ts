/**
 * Every page gets console, page-error and failed-request listeners at context
 * creation (QA guide Part 9). Any error fails the test that caused it.
 */
import { test as base, expect } from "@playwright/test";

export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ context }, use) => {
      const problems: string[] = [];
      context.on("page", (p) => {
        p.on("console", (m) => {
          if (m.type() === "error") problems.push(`console.error: ${m.text()}`);
        });
        p.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
        p.on("requestfailed", (r) => {
          const f = r.failure()?.errorText ?? "";
          if (!f.includes("ERR_ABORTED")) problems.push(`requestfailed: ${r.url()} ${f}`);
        });
      });
      await use(problems);
      expect(problems, "console errors, page errors or failed requests").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
