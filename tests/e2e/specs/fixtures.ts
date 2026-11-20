/**
 * Every page gets console, page-error and failed-request listeners at context
 * creation (QA guide Part 9). Any error fails the test that caused it.
 */
import { test as base, expect } from "@playwright/test";

/**
 * `allowFailedUrls`: one pattern for the hosts a test makes fail on purpose (a dependency-down test). Only requests to those hosts,
 * and the browser's "Failed to load resource" line for them, are forgiven; page errors and every other console
 * error still fail the test.
 */
export const test = base.extend<{ problems: string[]; allowFailedUrls: RegExp | null }>({
  allowFailedUrls: [null, { option: true }],
  problems: [
    async ({ context, allowFailedUrls }, use) => {
      const problems: string[] = [];
      const allowed = (url: string) => !!allowFailedUrls && allowFailedUrls.test(url);
      context.on("page", (p) => {
        p.on("console", (m) => {
          if (m.type() !== "error") return;
          if (/^Failed to load resource/.test(m.text()) && allowed(m.location().url)) return;
          problems.push(`console.error: ${m.text()}`);
        });
        p.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
        p.on("requestfailed", (r) => {
          const f = r.failure()?.errorText ?? "";
          if (!f.includes("ERR_ABORTED") && !allowed(r.url())) problems.push(`requestfailed: ${r.url()} ${f}`);
        });
      });
      await use(problems);
      expect(problems, "console errors, page errors or failed requests").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };
