import { test, expect } from "./fixtures";

test("design system: real seal, receipt, failure, sheet and toast", async ({ page }) => {
  await page.goto("/design");
  await expect(page.getByRole("heading", { name: "Musubi and the knot" })).toBeVisible();
  await page.getByRole("button", { name: "Seal a test message" }).click();
  await expect(page.getByText("Stored for Aria, sealed.")).toBeVisible();
  await expect(page.locator("#seal")).toContainText(/[0-9a-f]{8} [0-9a-f]{8}/);
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Show a failure" }).click();
  await expect(page.getByText("Not sent. Nothing left your device.")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Open a sheet" }).click();
  const dialog = page.getByRole("dialog", { name: "Send Aria something private" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.getByRole("button", { name: "Undo toast" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Archived" })).toBeVisible();
});

test("design system: name field explains its rule", async ({ page }) => {
  await page.goto("/design#fields");
  const field = page.getByLabel("Your page name");
  await field.fill("ab");
  await expect(page.getByText("Usernames must be 3 characters or longer")).toBeVisible();
  await field.fill("aria.studio");
  await expect(page.getByText("It's available")).toBeVisible();
});
