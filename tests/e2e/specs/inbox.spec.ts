/**
 * 5.8 the inbox, with two real accounts in separate browser contexts.
 * A signed visitor sends a message with a picture; the owner sees it sealed,
 * opens it on their device, sees the sender verified against QoreChain,
 * previews and saves the picture, replies sealed; the visitor opens the reply.
 * Also: anonymous items, archive and back, live arrival without reloading,
 * an item not sealed to the owner's key, and the phone list/detail flow.
 * Source of truth: envelopes fetched from the API and opened with each
 * party's own keys, and the inbox index read through the API.
 */
import { deflateSync, crc32 } from "node:zlib";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readAnchor } from "@mizuhiki/chain";
import { test, expect } from "./fixtures";
import { Purpose, fromUtf8, openItem, sealItem, solvePow, toBase64Url, utf8 } from "@mizuhiki/core";
import { generateSealKeys, recipientOf } from "@qorechain/qoreseal";
import { API, apiToken, ensureOwner, gotoUnlocked, restoreInBrowser } from "./owner";

const OWNER = "mzk-e2e-editor";
const VISITOR = "mzk-e2e-visitor";

/** A real 64x64 PNG (sakura pink with a darker band), built without any image library. */
function makePng(): Buffer {
  const w = 64;
  const h = 64;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const band = y > 24 && y < 40;
      raw[o] = band ? 0xe2 : 0xff;
      raw[o + 1] = band ? 0x48 : 0xc4;
      raw[o + 2] = band ? 0x3d : 0xd0;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function call<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`);
  return (await r.json()) as T;
}
async function bytes(path: string): Promise<Uint8Array> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

/** Drop an anonymous envelope straight to the API, the way any client could. */
async function dropRaw(to: string, readers: ReturnType<typeof recipientOf>[], text: string): Promise<string> {
  const payload = { v: 1, kind: "message", text, contact: "", files: [], sentAt: new Date().toISOString() };
  const sealed = sealItem({
    purpose: Purpose.message,
    readers,
    plaintext: utf8(JSON.stringify(payload)),
    anonymous: true,
  });
  const cfg = await call<{ powBits: number }>("/drop/config");
  const pow = solvePow(to, sealed.hash, cfg.powBits);
  const r = await call<{ hash: string }>(`/drop/${to}`, {
    method: "POST",
    body: { envelope: toBase64Url(sealed.envelope), kind: "message", chunks: [], pow },
  });
  return r.hash;
}

test("inbox: signed message with a picture, verified sender, preview, save, sealed reply both ways", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "two-party flow runs once, on desktop");
  test.setTimeout(420_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  const visitor = await ensureOwner("e2e-visitor", VISITOR);
  const png = makePng();
  const text = `Here is the signed photo. ${Date.now()}`;

  // ---- visitor, signed in with their own Mizuhiki account, sends signed
  const vctx = await browser.newContext();
  const v = await vctx.newPage();
  await restoreInBrowser(v, visitor.phrase);
  await v.goto(`/@${OWNER}/message`);
  const sheet = v.getByRole("dialog", { name: "Send Kinari something private" });
  await sheet.getByLabel("Message").fill(text);
  await sheet.locator('input[type="file"]').setInputFiles({ name: "photo.png", mimeType: "image/png", buffer: png });
  await sheet.getByRole("button", { name: "Next" }).click();
  // The page load locked the visitor's account: they unlock right in the sheet to sign.
  await sheet.getByRole("radio", { name: /Show it's from me \(unlock first\)/ }).click();
  await sheet.getByLabel("Device passphrase").fill("wrong passphrase here");
  await sheet.getByRole("button", { name: "Unlock to sign" }).click();
  await expect(sheet.getByRole("alert").or(sheet.locator("[aria-invalid=true]")).first()).toBeVisible();
  await sheet.getByLabel("Device passphrase").fill("lantern river maple tea");
  await sheet.getByRole("button", { name: "Unlock to sign" }).click();
  await expect(sheet.getByRole("radio", { name: /^Show it's from me/ })).toHaveAttribute("aria-checked", "true");
  await expect(sheet.getByLabel("Device passphrase")).toHaveCount(0);
  await sheet.getByRole("button", { name: "Seal and send" }).click();
  const done = v.getByRole("dialog", { name: "Sealed for Kinari" });
  await expect(done.getByText("Signed with your key")).toBeVisible({ timeout: 120_000 });
  const sentHash = ((await done.innerText()).match(/([0-9a-f]{8} ?){8}/)?.[0] ?? "").replace(/ /g, "");
  expect(sentHash).toMatch(/^[0-9a-f]{64}$/);

  // Source of truth: the index has it, signed by the visitor, unread.
  const otoken = await apiToken(owner);
  const idx = await call<{ rows: { id: string; read: boolean; sender: { address: string } | null }[] }>(
    "/owner/inbox",
    { token: otoken },
  );
  const row = idx.rows.find((r) => r.id === sentHash);
  expect(row?.sender?.address).toBe(visitor.address);
  expect(row?.read).toBe(false);

  // ---- owner opens it on their device
  const octx = await browser.newContext({ acceptDownloads: true });
  const o = await octx.newPage();
  await restoreInBrowser(o, owner.phrase);
  await o.getByRole("link", { name: /Inbox/ }).first().click();
  await o.waitForURL("**/app/inbox");
  const list = o.getByRole("region", { name: "Inbox list" });
  const item = list.getByRole("button", { name: new RegExp(`@${VISITOR}.*Sealed · tap to open`) }).first();
  await expect(item).toBeVisible();
  await o.screenshot({ path: info.outputPath("inbox-list.png") });
  await item.click();
  const detail = o.getByRole("region", { name: "Opened item" });
  await expect(detail.getByText(text)).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByText(`Verified: @${VISITOR}`)).toBeVisible({ timeout: 30_000 });
  await detail.getByRole("button", { name: "Preview" }).click();
  await expect(detail.getByRole("img", { name: "Preview of photo.png" })).toBeVisible();
  const [dl] = await Promise.all([o.waitForEvent("download"), detail.getByRole("button", { name: "Save" }).click()]);
  expect(dl.suggestedFilename()).toBe("photo.png");
  expect(Buffer.from(await readFile(await dl.path())).equals(png)).toBe(true);
  await o.screenshot({ path: info.outputPath("inbox-open.png") });

  // "Prove it existed" on a received file: the fingerprint is the picture's SHA-256; anchoring it
  // is fresh on the first run and "already" afterwards (the picture is the same bytes every run).
  await detail.getByRole("button", { name: "Prove it existed" }).click();
  const prove = o.getByRole("dialog", { name: "Prove it existed" });
  await expect(prove.getByText(createHash("sha256").update(png).digest("hex"))).toBeVisible();
  await prove.getByRole("button", { name: "Anchor on QoreChain" }).click();
  await expect(prove.getByText(/Anchored\. It is on QoreChain now\.|You anchored this already\./)).toBeVisible({
    timeout: 240_000,
  });
  expect(await readAnchor(createHash("sha256").update(png).digest("hex"))).not.toBeNull();
  await prove.getByRole("button", { name: "Done" }).click();
  // read state reached the index
  await expect
    .poll(
      async () =>
        (await call<{ rows: { id: string; read: boolean }[] }>("/owner/inbox", { token: otoken })).rows.find(
          (r) => r.id === sentHash,
        )?.read,
    )
    .toBe(true);

  // ---- owner replies sealed
  const replyText = `Got it, thank you. ${Date.now()}`;
  await detail.getByRole("button", { name: "Reply sealed" }).click();
  const rs = o.getByRole("dialog", { name: `Reply to @${VISITOR}` });
  await rs.getByLabel("Your reply").fill(replyText);
  await rs.getByRole("button", { name: "Seal and reply" }).click();
  await expect(o.getByRole("dialog", { name: "Sealed and sent" })).toBeVisible({ timeout: 120_000 });
  await o.getByRole("dialog", { name: "Sealed and sent" }).getByRole("button", { name: "Done" }).click();
  await expect(detail.getByText(replyText)).toBeVisible({ timeout: 30_000 });
  await expect(detail.getByText(/You replied/)).toBeVisible();

  // Source of truth: the visitor's index has the reply; the visitor's keys open it and it points at the original.
  const vtoken = await apiToken(visitor);
  const vidx = await call<{ rows: { id: string; kind: string; ref: string | null; envelope: string | null }[] }>(
    "/owner/inbox",
    { token: vtoken },
  );
  const reply = vidx.rows.find((r) => r.kind === "reply" && r.ref === `re:${sentHash}`);
  expect(reply?.envelope).toMatch(/^[0-9a-f]{64}$/);
  const opened = JSON.parse(
    fromUtf8(
      openItem({
        purpose: Purpose.message,
        envelope: await bytes(`/blobs/${reply?.envelope ?? ""}`),
        keys: visitor.seal,
      }),
    ),
  ) as {
    text: string;
    inReplyTo: string;
    from: string;
  };
  expect(opened.text).toBe(replyText);
  expect(opened.inReplyTo).toBe(sentHash);
  expect(opened.from).toBe(owner.address);

  // ---- visitor opens the reply in their own inbox
  await gotoUnlocked(v, "/app/inbox");
  await v
    .getByRole("region", { name: "Inbox list" })
    .getByRole("button", { name: new RegExp(`Reply.*@${OWNER}`) })
    .first()
    .click();
  const vd = v.getByRole("region", { name: "Opened item" });
  await expect(vd.getByText(replyText)).toBeVisible({ timeout: 30_000 });
  await expect(vd.getByText(`Verified: @${OWNER}`)).toBeVisible({ timeout: 30_000 });
  await expect(vd.getByText(text.slice(0, 20))).toBeVisible(); // the quoted original
  await v.screenshot({ path: info.outputPath("visitor-reply.png") });

  // ---- archive and back
  await o
    .getByRole("region", { name: "Inbox list" })
    .getByRole("button", { name: new RegExp(`@${VISITOR}`) })
    .first()
    .click();
  await detail.getByRole("button", { name: "Archive" }).click();
  await expect(o.getByText("Archived", { exact: true }).last()).toBeVisible();
  await expect(list.getByRole("button", { name: new RegExp(text.slice(0, 20)) })).toHaveCount(0);
  await o.getByRole("tab", { name: "Archived" }).click();
  await list
    .getByRole("button", { name: new RegExp(`@${VISITOR}`) })
    .first()
    .click();
  await detail.getByRole("button", { name: "Move to inbox" }).click();
  await o.getByRole("tab", { name: "Inbox" }).click();
  await expect(list.getByRole("button", { name: new RegExp(text.slice(0, 20)) }).first()).toBeVisible();

  // ---- live arrival: an anonymous drop shows up without reloading
  await expect(o.getByText("Live", { exact: true })).toBeVisible();
  const liveText = `Live drop ${Date.now()}`;
  const liveHash = await dropRaw(owner.address, [recipientOf(owner.seal)], liveText);
  const sealedRows = list.getByRole("button", { name: /Anonymous.*Sealed · tap to open/ });
  await expect(sealedRows.first()).toBeVisible({ timeout: 15_000 });
  // Other suites drop anonymously into this inbox at the same time, so open sealed rows until this one shows.
  await expect(async () => {
    for (let i = 0; i < (await sealedRows.count()); i++) {
      await sealedRows.nth(i).click();
      const opened = await detail
        .getByText(liveText)
        .waitFor({ state: "visible", timeout: 8_000 })
        .then(
          () => true,
          () => false,
        );
      if (opened) return;
    }
    throw new Error("the live drop is not among the sealed rows yet");
  }).toPass({ timeout: 60_000 });
  await expect(detail.getByText(liveText)).toBeVisible();
  await expect(detail.locator("b", { hasText: /^Anonymous$/ })).toBeVisible();
  await expect(detail.getByText(/Anonymous: there is no way to reply/)).toBeVisible();
  expect(liveHash).toMatch(/^[0-9a-f]{64}$/);

  // ---- an item not sealed to the owner's key says so and opens nothing
  await dropRaw(owner.address, [recipientOf(generateSealKeys())], "not for you");
  const wrong = list.getByRole("button", { name: /Anonymous.*Sealed · tap to open/ }).first();
  await expect(wrong).toBeVisible({ timeout: 15_000 });
  await wrong.click();
  await expect(detail.getByText("This was not sealed to your key, so it cannot be opened here.")).toBeVisible({
    timeout: 30_000,
  });

  // ---- local search reads opened items only
  await list.getByLabel("Search").fill(liveText.slice(0, 14));
  await expect(list.getByRole("button", { name: /Anonymous/ })).toHaveCount(1);
  await list.getByLabel("Search").fill("");

  await vctx.close();
  await octx.close();
});

test("inbox on a phone: list, open, back", async ({ page }, info) => {
  test.skip(info.project.name !== "phone", "phone");
  test.setTimeout(180_000);
  const owner = await ensureOwner("e2e-editor", OWNER);
  await dropRaw(owner.address, [recipientOf(owner.seal)], `Phone check ${Date.now()}`);
  await restoreInBrowser(page, owner.phrase);
  await page.getByRole("navigation", { name: "Owner sections" }).last().getByRole("link", { name: "Inbox" }).click();
  await page.waitForURL("**/app/inbox");
  const list = page.getByRole("region", { name: "Inbox list" });
  await expect(list.getByRole("button").filter({ hasText: "Anonymous" }).first()).toBeVisible();
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw);
  await page.screenshot({ path: info.outputPath("inbox-phone.png") });
  await list.getByRole("button").filter({ hasText: "Anonymous" }).first().click();
  await expect(
    page
      .getByRole("region", { name: "Opened item" })
      .getByText(/Phone check|not sealed to your key|Opening on this device/)
      .first(),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("inbox-phone-open.png") });
  await page.getByRole("button", { name: "Back to the list" }).click();
  await expect(list).toBeVisible();
});
