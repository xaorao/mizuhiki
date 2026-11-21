/**
 * Every screen for the polish pass, on desktop (1440) and phone (390): visitor pages, then the owner app signed in
 * as the e2e owner (one detail page per list, the first row), with the problems the QA guide counts (console
 * errors, page errors, failed requests, sideways scroll) written beside the screenshots.
 * Usage: tsx tools/polish-shots.ts <outDir>
 */
import { chromium, devices, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { personaPhrase } from "@mizuhiki/testnet";
import { API, apiToken, ensureOwner, restoreInBrowser } from "../specs/owner";

const out = process.argv[2] ?? "polish";
mkdirSync(out, { recursive: true });
const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const OWNER = "mzk-e2e-editor";
// The owner app is shot as the demo account, which has real activity in most areas.
const OWNER_LABEL = process.env.OWNER_LABEL ?? "demo-aria";
const OWNER_NAME = process.env.OWNER_NAME ?? "aria";

const VISITOR = [
  ["landing", "/"],
  ["signup", "/signup"],
  ["login", "/login"],
  ["recover", "/recover"],
  ["recover-offline", "/recover/offline"],
  ["proof-check", "/proof"],
  ["onchain", "/onchain"],
  ["library", "/library"],
  ["legal-privacy", "/legal/privacy"],
  ["legal-terms", "/legal/terms"],
  ["legal-report", "/legal/report"],
  ["public-page", `/@${OWNER}`],
  ["public-message", `/@${OWNER}/message`],
  ["public-pay", `/@${OWNER}/pay`],
  ["public-shop", "/@mzk-shop-e2e?tab=shop"],
  ["public-missing", "/@zz-nobody-here"],
  ["not-found", "/no-such-page"],
] as const;

const OWNER_LISTS = [
  ["owner-blocks", "/app", null],
  ["owner-design", "/app/design", null],
  ["owner-insights", "/app/insights", null],
  ["owner-inbox", "/app/inbox", null],
  ["owner-forms", "/app/forms", "/owner/forms"],
  ["owner-requests", "/app/requests", "/owner/file-requests"],
  ["owner-shop", "/app/shop", "/owner/products"],
  ["owner-rooms", "/app/rooms", "/rooms"],
  ["owner-invoices", "/app/invoices", "/owner/invoices"],
  ["owner-proofs", "/app/proof", null],
  ["owner-passes", "/app/passes", "/owner/passes"],
  ["owner-capsules", "/app/capsules", "/owner/capsules"],
  ["owner-spare-key", "/app/spare-key", null],
  ["owner-settings", "/app/settings", null],
  ["owner-invoice-new", "/app/invoices/new", null],
  ["owner-room-new", "/app/rooms/new", null],
  ["owner-capsule-new", "/app/capsules/new", null],
  ["owner-product-new", "/app/shop/new", null],
] as const;

const problems: string[] = [];
const seen = new Map<string, string>();
// The first item of each list, from the API (lists open items with buttons, not links).
const owner = await ensureOwner(OWNER_LABEL, OWNER_NAME);
const token = await apiToken(owner);
async function firstId(endpoint: string): Promise<string | null> {
  const j = (await (
    await fetch(`${API}${endpoint}`, { headers: { authorization: `Bearer ${token}` } })
  ).json()) as Record<string, unknown>;
  const list = Object.values(j).find((v): v is { id?: string; roomId?: string }[] => Array.isArray(v) && v.length > 0);
  const first = list?.[0] as Record<string, unknown> | undefined;
  const id = first?.id ?? (first?.def as { id?: string } | undefined)?.id ?? first?.roomId;
  return typeof id === "string" ? id : null;
}
async function shoot(page: Page, label: string, name: string) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(800);
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > iw) problems.push(`[${label}] ${name}: sideways scroll ${sw} > ${iw}`);
  const png = await page.screenshot({ path: `${out}/${name}-${label}.png`, fullPage: true, animations: "disabled" });
  const hash = createHash("sha256").update(png).digest("hex");
  const twin = seen.get(hash);
  if (twin) problems.push(`[${label}] ${name}: same image as ${twin}`);
  seen.set(hash, name);
}

/**
 * A reload locks the key: wait until either the owner navigation or the lock screen shows, unlock if locked, and
 * report whether the owner app is really on screen (a lock-screen shot must never pass as an owner screen).
 */
async function ready(page: Page): Promise<boolean> {
  const nav = page.getByRole("navigation", { name: "Owner sections" }).first();
  const unlock = page.getByLabel("Device passphrase");
  await nav
    .or(unlock)
    .first()
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  if (await unlock.isVisible()) {
    await unlock.fill("lantern river maple tea");
    await page.getByRole("button", { name: "Unlock" }).click();
  }
  return nav.waitFor({ timeout: 30_000 }).then(
    () => true,
    () => false,
  );
}

const browser = await chromium.launch();
for (const [label, opts] of [
  ["desktop", { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
  ["phone", { ...devices["iPhone 14"], viewport: { width: 390, height: 844 } }],
] as const) {
  const ctx = await browser.newContext({ ...opts, baseURL: BASE, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  let at = "";
  page.on(
    "console",
    (m) => m.type() === "error" && problems.push(`[${label}] ${at}: console ${m.text().slice(0, 160)}`),
  );
  page.on("pageerror", (e) => problems.push(`[${label}] ${at}: pageerror ${e.message.slice(0, 160)}`));
  page.on("requestfailed", (r) => {
    if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? "")) problems.push(`[${label}] ${at}: requestfailed ${r.url()}`);
  });
  for (const [name, path] of VISITOR) {
    at = name;
    await page.goto(path);
    await shoot(page, label, name);
  }
  at = "restore";
  await restoreInBrowser(page, personaPhrase(OWNER_LABEL));
  for (const [name, path, detail] of OWNER_LISTS) {
    at = name;
    await page.goto(path);
    // A reload locks the key: unlock again with the device passphrase.
    if (!(await ready(page))) {
      problems.push(`[${label}] ${name}: the owner app did not open`);
      continue;
    }
    await shoot(page, label, name);
    if (detail) {
      const id = await firstId(detail);
      if (id) {
        at = `${name}-detail`;
        await page.goto(`${path}/${id}`);
        if (await ready(page)) await shoot(page, label, `${name}-detail`);
        else problems.push(`[${label}] ${name}-detail: the owner app did not open`);
      } else problems.push(`[${label}] ${name}: no item to open`);
    }
  }
  await ctx.close();
}
await browser.close();
writeFileSync(`${out}/problems.txt`, problems.join("\n") || "none");
console.log(problems.length ? problems.join("\n") : "no console errors, failed requests or sideways scroll");
