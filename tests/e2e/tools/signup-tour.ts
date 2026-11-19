/** Screenshots of every sign-up screen before the chain steps, desktop and phone. */
import { chromium, devices } from "@playwright/test";
const out = process.argv[2] ?? "shots";
const browser = await chromium.launch();
for (const [label, opts] of [
  ["desktop", { viewport: { width: 1440, height: 900 } }],
  ["phone", { ...devices["Pixel 7"], viewport: { width: 390, height: 844 } }],
] as const) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
  const shot = async (n: string) => {
    await page.waitForTimeout(450);
    await page.screenshot({ path: `${out}/su-${label}-${n}.png`, fullPage: label === "phone" });
  };
  await page.goto(`http://localhost:3000/signup?name=tour${Date.now().toString(36)}`);
  await page.getByText("It's available").waitFor();
  await shot("1-name");
  await page.getByLabel("Page name").fill("mzk-api-owner");
  await page.getByText("That's taken.").waitFor();
  await shot("1b-taken");
  await page.getByLabel("Page name").fill(`tour${Date.now().toString(36)}`);
  await page.getByText("It's available").waitFor();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Creator/ }).click();
  await shot("2-goal");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("radio", { name: /Washi/ }).click();
  await shot("3-template");
  await page.getByRole("button", { name: "Continue" }).click();
  await shot("4-blocks");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByLabel("Display name").fill("Aria Kapoor");
  await page
    .getByLabel("Bio")
    .fill("Brand designer in Pune. Contracts, invoices and client files come through here, sealed.");
  await shot("5-profile");
  await page.getByRole("button", { name: "Continue" }).click();
  await shot("6-phrase");
  await page.getByLabel("I saved my 24 words somewhere safe").check();
  await page.getByRole("button", { name: "I saved it" }).click();
  await page.getByRole("button", { name: "Check" }).click();
  await shot("7-check-errors");
  await ctx.close();
  console.log(label, errs.length ? errs : "no errors");
}
await browser.close();
