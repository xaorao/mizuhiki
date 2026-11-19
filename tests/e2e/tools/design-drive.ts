import { chromium } from "@playwright/test";
const out = process.argv[2] ?? "shots";
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const problems: string[] = [];
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
await page.goto("http://localhost:3000/design#seal", { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Seal a test message" }).click();
await page.getByText("Stored for Aria, sealed.").waitFor({ timeout: 20000 });
await page.waitForTimeout(700);
await page.locator("#seal").screenshot({ path: `${out}/seal-done.png` });
const hash = await page.locator("#seal").innerText();
console.log("receipt has hash:", /[0-9a-f]{8} [0-9a-f]{8}/.test(hash));
await page.getByRole("button", { name: "Done" }).click();
await page.getByRole("button", { name: "Show a failure" }).click();
await page.getByText("Not sent. Nothing left your device.").waitFor();
await page.locator("#seal").screenshot({ path: `${out}/seal-failed.png` });
await page.getByRole("button", { name: "Close" }).click();
await page.getByRole("button", { name: "Open a sheet" }).click();
await page.getByRole("dialog").waitFor();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/sheet.png` });
await page.keyboard.press("Escape");
await page.getByRole("dialog").waitFor({ state: "hidden" });
await page.getByRole("button", { name: "Toast with action" }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/toast.png`, clip: { x: 300, y: 700, width: 840, height: 200 } });
const phone = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
});
const p2 = await phone.newPage();
p2.on("pageerror", (e) => problems.push(`phone pageerror: ${e.message}`));
await p2.goto("http://localhost:3000/design#sheet", { waitUntil: "networkidle" });
await p2.getByRole("button", { name: "Open a sheet" }).click();
await p2.waitForTimeout(500);
await p2.screenshot({ path: `${out}/sheet-phone.png` });
await p2.goBack();
await p2.waitForTimeout(300);
console.log("phone sheet closed by back:", !(await p2.getByRole("dialog").isVisible()));
await browser.close();
console.log(problems.length ? problems.join("\n") : "no console errors");
