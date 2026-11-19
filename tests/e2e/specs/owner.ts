/**
 * A testnet persona with keys, a name on MizuhikiRegistry, a verified card and
 * a published page on the local API, plus a browser session restored from its
 * 24 words through the real /login screen.
 */
import type { Page } from "@playwright/test";
import { signSiwq } from "@qorechain/qoresign";
import { DEFAULT_THEME, newId, signRecord, type Manifest } from "@mizuhiki/core";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import { expect } from "./fixtures";

export const API = process.env.API_URL ?? "http://127.0.0.1:4000";

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const j = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${path}: ${j.error?.message ?? res.status}`);
  return j;
}

export async function apiToken(p: ReadyPersona): Promise<string> {
  const ch = await call<{ message: string; nonce: string }>("/auth/challenge", {
    method: "POST",
    body: { address: p.address },
  });
  const signature = signSiwq({ message: ch.message, classicalKey: p.classical, pqKey: p.pq });
  return (await call<{ token: string }>("/auth/verify", { method: "POST", body: { nonce: ch.nonce, signature } }))
    .token;
}

/** A persona with a published page (version bumps on each call so the page is fresh). */
export async function ensureOwner(label: string, name: string): Promise<ReadyPersona & { name: string }> {
  const p = await ensurePersona(label, { name });
  const token = await apiToken(p);
  await call("/cards", { method: "PUT", body: { card: p.card }, token });
  const own = await call<{ page: { version: number } | null }>("/owner/page", { token });
  const m: Manifest = {
    v: 1,
    name,
    address: p.address,
    displayName: "Kinari Studio",
    bio: "Contracts and client files come through here, sealed.",
    socials: [],
    goal: "business",
    theme: DEFAULT_THEME,
    blocks: [
      {
        id: newId(),
        type: "pay",
        on: true,
        archived: false,
        title: "Pay Kinari",
        subtitle: "Any amount, with a sealed note",
        tokens: ["fUSD", "QOR"],
        presets: [],
        tip: false,
        thanks: "",
      },
      {
        id: newId(),
        type: "message",
        on: true,
        archived: false,
        title: "Send me something private",
        subtitle: "Sealed on your device before it leaves",
        greeting: "Hi, send me anything private here.",
        allowFiles: true,
        maxFileMB: 500,
      },
    ],
    periodKeys: [],
    version: (own.page?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  await call("/pages", {
    method: "PUT",
    body: { record: signRecord({ kind: "manifest", body: m, signer: p.address, classical: p.classical, pq: p.pq }) },
    token,
  });
  // Start each run from the published page, not an older draft.
  await call("/drafts", { method: "DELETE", token });
  return { ...p, name };
}

/** Restore the persona in this browser from its 24 words, through the real login screen. */
export async function restoreInBrowser(
  page: Page,
  phrase: string,
  passphrase = "lantern river maple tea",
): Promise<void> {
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Use your recovery phrase" })).toBeVisible();
  await page.getByLabel("Recovery phrase").fill(phrase);
  await expect(page.getByText("Valid phrase")).toBeVisible();
  await page.getByLabel("New passphrase for this device").fill(passphrase);
  await page.getByRole("button", { name: "Restore on this device" }).click();
  await page.waitForURL("**/app");
}

/**
 * Open an owner page with a full load. Keys live only in memory, so a load
 * locks the account and the app asks for the device passphrase first.
 */
export async function gotoUnlocked(page: Page, path: string, passphrase = "lantern river maple tea"): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await page.getByLabel("Device passphrase").fill(passphrase);
  await page.getByRole("button", { name: "Unlock" }).click();
  await page.waitForURL(`**${path}`);
}
