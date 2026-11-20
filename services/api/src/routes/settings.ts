/**
 * Settings and account (spec 5.17, ARCHITECTURE 8f): the account's names,
 * Web Push subscriptions and per-kind toggles, and deleting the page with
 * everything stored for it (chain data stays).
 */
import type { FastifyPluginCallback } from "fastify";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  blobHolds,
  capsules,
  drafts,
  envelopes,
  fileRequests,
  forms,
  invoices,
  names,
  notifyPrefs,
  pages,
  passItems,
  passes,
  products,
  pushSubscriptions,
  recoveryContacts,
  recoveryOfflineItems,
  recoverySettings,
} from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { fail } from "../lib/http";
import { PUSH_TYPES, pushEnabled, type PushType } from "../lib/push";
import { releaseAll } from "../lib/holds";

const b64u = z
  .string()
  .regex(/^[A-Za-z0-9_-]+={0,2}$/)
  .max(200);

/**
 * The push services browsers use (Chrome and Edge via FCM, Firefox via Mozilla, Safari via Apple, legacy Edge
 * via Windows Push). Subscriptions to anything else are refused.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /\.notify\.windows\.com$/,
];
function isPushService(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && !u.port && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

/** Hold purposes (lib/holds.ts) that belong to the page and its owner's own items. */
const DELETED_WITH_PAGE = [
  "drop:",
  "draft",
  "media",
  "snapshot:",
  "form:",
  "invoice:",
  "product:",
  "pass:",
  "recovery:owner",
  "capsule-draft:",
];

export const settingsRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    app.get("/owner/names", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const rows = await db.select().from(names).where(eq(names.address, me)).orderBy(desc(names.primary), names.name);
      const [page] = await db.select({ name: pages.name }).from(pages).where(eq(pages.address, me));
      return {
        names: rows.map((n) => ({ name: n.name, primary: n.primary, claimedTx: n.claimedTx })),
        pageName: page?.name ?? null,
      };
    });

    // ---- Web Push ----------------------------------------------------------------------------------

    app.get("/push/key", (_req, reply) => {
      if (!pushEnabled(ctx.cfg)) return fail(reply, 503, "PUSH_OFF", "Notifications are not set up on this server.");
      return { publicKey: ctx.cfg.VAPID_PUBLIC_KEY };
    });

    app.get("/owner/notifications", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const [p] = await db.select({ prefs: notifyPrefs.prefs }).from(notifyPrefs).where(eq(notifyPrefs.address, me));
      const saved = (p?.prefs ?? {}) as Partial<Record<PushType, boolean>>;
      const subs = await db
        .select({ endpoint: pushSubscriptions.endpoint, createdAt: pushSubscriptions.createdAt })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.address, me));
      return {
        enabled: pushEnabled(ctx.cfg),
        prefs: Object.fromEntries(PUSH_TYPES.map((t) => [t, saved[t] !== false])),
        browsers: subs.map((s) => ({ endpoint: s.endpoint, createdAt: s.createdAt })),
      };
    });

    app.put("/owner/notifications", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      // Any subset of the kinds; zod 4 records over an enum would demand every key.
      const b = z.object({ prefs: z.partialRecord(z.enum(PUSH_TYPES), z.boolean()) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing changed.");
      await db
        .insert(notifyPrefs)
        .values({ address: me, prefs: b.data.prefs })
        .onConflictDoUpdate({ target: notifyPrefs.address, set: { prefs: b.data.prefs } });
      return { ok: true };
    });

    /**
     * This browser's push subscription (from PushManager.subscribe). Only the browsers' own push services are
     * accepted, so the server never posts to an address of a caller's choosing (security review L1), and a
     * subscription stays with the account that registered it.
     */
    app.put("/owner/push", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      if (!pushEnabled(ctx.cfg)) return fail(reply, 503, "PUSH_OFF", "Notifications are not set up on this server.");
      const b = z
        .object({ endpoint: z.url({ protocol: /^https$/ }).max(1000), keys: z.object({ p256dh: b64u, auth: b64u }) })
        .safeParse(req.body);
      if (!b.success || !isPushService(b.data.endpoint))
        return fail(reply, 400, "BAD_REQUEST", "This browser's subscription is not valid. Nothing changed.");
      const [taken] = await db
        .select({ address: pushSubscriptions.address })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, b.data.endpoint));
      if (taken && taken.address !== me)
        return fail(reply, 409, "TAKEN", "This browser is subscribed for another account. Turn it off there first.");
      await db
        .insert(pushSubscriptions)
        .values({ endpoint: b.data.endpoint, address: me, keys: b.data.keys })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { keys: b.data.keys } });
      return { ok: true };
    });

    app.delete("/owner/push", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const b = z.object({ endpoint: z.string().max(1000) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request.");
      await db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.endpoint, b.data.endpoint), eq(pushSubscriptions.address, me)));
      return { ok: true };
    });

    /** A test notification to this account's browsers, so the person sees it work. */
    app.post("/owner/push/test", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const n = await ctx.push.send(me, "items");
      return { delivered: n };
    });

    // ---- delete my page ----------------------------------------------------------------------------

    /**
     * Hide the page and remove everything stored for this account: sealed items, invoices, forms, products,
     * drafts, file requests, passes, recovery pieces and capsule working copies. Their blobs are swept. Rooms are shared with
     * other people and stay; QoreChain records (names, keys, anchors, payments) stay.
     */
    app.delete("/owner/page", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was deleted.", "nothing-changed");
      const b = z.object({ confirm: z.literal("delete my page") }).safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "CONFIRM", "Type the confirmation to delete. Nothing was deleted.", "nothing-changed");
      // Only this account's own holds are released, by purpose; anything someone else keeps stays theirs.
      const myPasses = await db.select({ id: passes.id }).from(passes).where(eq(passes.owner, me));
      const passIds = myPasses.map((p) => p.id);
      const [{ held } = { held: 0 }] = await db
        .select({ held: sql<number>`count(distinct ${blobHolds.hash})::int` })
        .from(blobHolds)
        .where(eq(blobHolds.holder, me));
      await db.transaction(async (tx) => {
        await tx.update(pages).set({ unpublished: true }).where(eq(pages.address, me));
        await tx.delete(envelopes).where(eq(envelopes.owner, me));
        await tx.delete(invoices).where(eq(invoices.owner, me));
        await tx.delete(forms).where(eq(forms.owner, me));
        await tx.delete(fileRequests).where(eq(fileRequests.owner, me));
        await tx.delete(products).where(eq(products.owner, me));
        await tx.delete(drafts).where(eq(drafts.address, me));
        await tx.delete(capsules).where(and(eq(capsules.owner, me), eq(capsules.state, "draft")));
        if (passIds.length) await tx.delete(passItems).where(inArray(passItems.passId, passIds));
        await tx
          .update(passes)
          .set({ status: "revoked", revokedAt: new Date() })
          .where(
            and(
              eq(passes.owner, me),
              or(eq(passes.status, "invited"), eq(passes.status, "accepted"), eq(passes.status, "active")),
            ),
          );
        await tx
          .update(recoveryContacts)
          .set({ status: "removed", piece: null, pieceVersion: null })
          .where(eq(recoveryContacts.owner, me));
        await tx.delete(recoveryOfflineItems).where(eq(recoveryOfflineItems.owner, me));
        await tx.update(recoverySettings).set({ offlineKey: null, version: 0 }).where(eq(recoverySettings.owner, me));
        await tx.delete(pushSubscriptions).where(eq(pushSubscriptions.address, me));
        // Rooms are shared and stay; capsules already armed stay (others are named in them); guardian and
        // recovery-contact holds for other people's capsules and recoveries stay too.
        for (const prefix of DELETED_WITH_PAGE) await releaseAll(tx, me, prefix);
      });
      await db.execute(sql`select pg_notify('mzk_events', ${`page:${me}`})`);
      return { ok: true, released: held };
    });

    done();
  };
