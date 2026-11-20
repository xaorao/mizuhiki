/**
 * 5.17 Notifications, end to end in a real browser: this browser subscribes
 * with Mozilla's push service, the server stores it, a test push is sent with
 * the server's VAPID key, goes through the push service, and arrives at the
 * service worker (which tells the page). Headless Chromium builds have no push
 * service, so this one runs in Firefox.
 */
import { test, expect } from "./fixtures";
import { API, apiToken, ensureOwner, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-settings";
interface Reply<T> {
  status: number;
  body: T;
}
async function call<T>(path: string, token?: string): Promise<Reply<T>> {
  const r = await fetch(`${API}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as T };
}
// Firefox talks to Mozilla's push service; headless Chromium builds have no push service at all.
test.use({
  browserName: "firefox",
  launchOptions: {
    firefoxUserPrefs: {
      "dom.push.enabled": true,
      "dom.push.connection.enabled": true,
      "dom.push.serverURL": "wss://push.services.mozilla.com/",
      "dom.serviceWorkers.enabled": true,
      "permissions.default.desktop-notification": 1,
    },
  },
});
test("settings: turn on notifications, a test push goes through the push service to this browser", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop", "once");
  test.setTimeout(300_000);
  const owner = await ensureOwner("e2e-settings-owner", OWNER);
  const token = await apiToken(owner);
  await restoreInBrowser(page, owner.phrase);
  await page.getByRole("link", { name: "Settings" }).filter({ visible: true }).first().click();
  await page.waitForURL("**/app/settings");
  const notif = page.locator("#notifications");
  // Collect what the service worker says it received.
  await page.evaluate(() => {
    (window as unknown as { pushes: string[] }).pushes = [];
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent<{ source?: string; type?: string }>) => {
      if (e.data.source === "mizuhiki-push") (window as unknown as { pushes: string[] }).pushes.push(e.data.type ?? "");
    });
  });
  const off = notif.getByRole("button", { name: "Turn off here" });
  if (await off.isVisible()) await off.click();
  await notif.getByRole("button", { name: "Turn on" }).click();
  await expect(page.getByText("Notifications are on for this browser.")).toBeVisible({ timeout: 60_000 });
  const browsers = (await call<{ browsers: { endpoint: string }[] }>("/owner/notifications", token)).body.browsers;
  expect(browsers.some((b) => b.endpoint.startsWith("https://updates.push.services.mozilla.com/"))).toBe(true);
  await notif.getByRole("button", { name: "Send a test" }).click();
  await expect(page.getByText("Test sent. It should appear in a moment.")).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { pushes: string[] }).pushes), { timeout: 60_000 })
    .toContain("items");
  await page.screenshot({ path: info.outputPath("03-push-on.png"), fullPage: true });
  await notif.getByRole("button", { name: "Turn off here" }).click();
  await expect
    .poll(async () => (await call<{ browsers: unknown[] }>("/owner/notifications", token)).body.browsers.length)
    .toBe(browsers.length - 1);
});
