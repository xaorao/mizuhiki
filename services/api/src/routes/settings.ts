/**
 * Settings and account (spec 5.17, ARCHITECTURE 8f): the account's names,
 * Web Push subscriptions and per-kind toggles, and deleting the page with
 * everything stored for it (chain data stays).
 */
import type { FastifyPluginCallback } from "fastify";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  blobs,
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

const b64u = z
  .string()
  .regex(/^[A-Za-z0-9_-]+={0,2}$/)
  .max(200);

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

    /** This browser's push subscription (from PushManager.subscribe). */
    app.put("/owner/push", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      if (!pushEnabled(ctx.cfg)) return fail(reply, 503, "PUSH_OFF", "Notifications are not set up on this server.");
      const b = z
        .object({ endpoint: z.url({ protocol: /^https$/ }).max(1000), keys: z.object({ p256dh: b64u, auth: b64u }) })
        .safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "This browser's subscription is not valid. Nothing changed.");
      await db
        .insert(pushSubscriptions)
        .values({ endpoint: b.data.endpoint, address: me, keys: b.data.keys })
        .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { address: me, keys: b.data.keys } });
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
      const hashes = new Set<string>();
      const add = (h: unknown) => {
        if (typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) hashes.add(h);
      };
      const env = await db
        .select({ hash: envelopes.hash, chunks: envelopes.chunks })
        .from(envelopes)
        .where(eq(envelopes.owner, me));
      for (const e of env) {
        add(e.hash);
        for (const c of e.chunks) add(c);
      }
      for (const i of await db
        .select({ a: invoices.envelope, b: invoices.privateEnvelope })
        .from(invoices)
        .where(eq(invoices.owner, me))) {
        add(i.a);
        add(i.b);
      }
      for (const f of await db.select({ d: forms.draftEnvelope }).from(forms).where(eq(forms.owner, me))) add(f.d);
      for (const p of await db.select({ d: products.draftEnvelope }).from(products).where(eq(products.owner, me)))
        add(p.d);
      for (const d of await db.select({ h: drafts.blobHash }).from(drafts).where(eq(drafts.address, me))) add(d.h);
      for (const c of await db
        .select({ d: capsules.draftEnvelope })
        .from(capsules)
        .where(and(eq(capsules.owner, me), eq(capsules.state, "draft"))))
        add(c.d);
      for (const r of await db
        .select({ p: recoveryContacts.piece })
        .from(recoveryContacts)
        .where(eq(recoveryContacts.owner, me)))
        add(r.p);
      const myPasses = await db
        .select({ id: passes.id, key: passes.keyEnvelope })
        .from(passes)
        .where(eq(passes.owner, me));
      for (const p of myPasses) add(p.key);
      const passIds = myPasses.map((p) => p.id);
      if (passIds.length)
        for (const i of await db
          .select({ e: passItems.envelope })
          .from(passItems)
          .where(inArray(passItems.passId, passIds)))
          add(i.e);
      for (const o of await db
        .select({ e: recoveryOfflineItems.envelope })
        .from(recoveryOfflineItems)
        .where(eq(recoveryOfflineItems.owner, me)))
        add(o.e);
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
        if (hashes.size)
          await tx
            .update(blobs)
            .set({ expiresAt: new Date() })
            .where(and(inArray(blobs.hash, [...hashes]), isNotNull(blobs.hash)));
      });
      await db.execute(sql`select pg_notify('mzk_events', ${`page:${me}`})`);
      return { ok: true, removed: hashes.size };
    });

    done();
  };
