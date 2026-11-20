import type { FastifyPluginCallback } from "fastify";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import { verifyRecipientCard, type RecipientCard } from "@qorechain/qoreseal";
import { NETWORK } from "@mizuhiki/chain";
import {
  cardHash,
  nameProblem,
  nameSuggestions,
  newId,
  normalizeNameInput,
  parseManifest,
  verifyRecord,
  type Signed,
} from "@mizuhiki/core";
import type { Ctx } from "../server";
import { cards, counters, drafts, envelopes, pages, payments, reports } from "@mizuhiki/db";
import { sessionAddress } from "../lib/auth";
import { kemKeyOf, pqKeyOf, resolveName } from "../lib/chainreads";
import { fail, isAddress, isHash } from "../lib/http";
import { hold, release } from "../lib/holds";

const today = () => new Date().toISOString().slice(0, 10);

export const pageRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;

    /** Live availability for the claim box and sign-up (spec 5.1 step 3). Reads the registry contract. */
    app.get("/names/:name", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req) => {
      const raw = (req.params as { name: string }).name;
      const name = normalizeNameInput(raw);
      const problem = nameProblem(name);
      if (problem)
        return {
          name,
          available: false,
          problem: problem.problem,
          message: problem.message,
          suggestions: problem.problem === "reserved" ? nameSuggestions(name) : [],
        };
      const { owner } = await resolveName(name);
      if (!owner) return { name, available: true, message: "It's available" };
      const suggestions: string[] = [];
      for (const s of nameSuggestions(name)) if (!(await resolveName(s)).owner) suggestions.push(s);
      return { name, available: false, problem: "taken", message: "That's taken.", owner, suggestions };
    });

    app.put("/cards", async (req, reply) => {
      const address = await sessionAddress(db, req);
      if (!address) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing was stored.", "nothing-stored");
      const card = (req.body as { card?: RecipientCard } | undefined)?.card;
      if (!card || card.address !== address)
        return fail(reply, 400, "BAD_CARD", "This card is not for your account. Nothing was stored.", "nothing-stored");
      const [pq, kem] = await Promise.all([pqKeyOf(address), kemKeyOf(address)]);
      if (!pq.publicKey || !kem.publicKey)
        return fail(
          reply,
          409,
          "KEYS_MISSING",
          "Register both keys on chain first. Nothing was stored.",
          "nothing-stored",
        );
      try {
        verifyRecipientCard({
          card,
          chainId: NETWORK.chainId,
          address,
          pqPublicKey: pq.publicKey,
          mlkemPublicKey: kem.publicKey,
        });
      } catch {
        return fail(
          reply,
          400,
          "CARD_INVALID",
          "This card does not match your keys on chain. Nothing was stored.",
          "nothing-stored",
        );
      }
      const hash = cardHash(card);
      await db
        .insert(cards)
        .values({ address, card, cardHash: hash })
        .onConflictDoUpdate({ target: cards.address, set: { card, cardHash: hash, updatedAt: new Date() } });
      return { cardHash: hash };
    });

    app.get("/cards/:address", async (req, reply) => {
      const { address } = req.params as { address: string };
      if (!isAddress(address)) return fail(reply, 400, "BAD_ADDRESS", "That is not a QoreChain address.");
      const [row] = await db.select().from(cards).where(eq(cards.address, address));
      if (!row) return fail(reply, 404, "NO_CARD", "This account has not published a sealing card yet.");
      return { card: row.card, cardHash: row.cardHash };
    });

    /** Publish a signed manifest. Checked: schema, signer = session, signature against the chain key, name owned on the registry, version goes up. */
    app.put("/pages", async (req, reply) => {
      const address = await sessionAddress(db, req);
      if (!address)
        return fail(reply, 401, "SIGNED_OUT", "Sign in first. Your page was not published.", "nothing-stored");
      const rec = (req.body as { record?: Signed<unknown> } | undefined)?.record;
      if (rec?.kind !== "manifest" || rec.signer !== address)
        return fail(
          reply,
          400,
          "BAD_RECORD",
          "This page is not signed by your account. Nothing was published.",
          "nothing-stored",
        );
      let manifest;
      try {
        manifest = parseManifest(rec.body);
      } catch (e) {
        return fail(
          reply,
          400,
          "BAD_MANIFEST",
          `Your page has a problem: ${(e as Error).message.slice(0, 200)}. Nothing was published.`,
          "nothing-stored",
        );
      }
      if (manifest.address !== address)
        return fail(
          reply,
          400,
          "BAD_MANIFEST",
          "This page names a different account. Nothing was published.",
          "nothing-stored",
        );
      const pq = await pqKeyOf(address);
      if (!pq.publicKey)
        return fail(
          reply,
          409,
          "KEYS_MISSING",
          "Register your key on chain first. Nothing was published.",
          "nothing-stored",
        );
      try {
        verifyRecord(rec, { kind: "manifest", signer: address, pqPublicKey: pq.publicKey });
      } catch {
        return fail(
          reply,
          400,
          "SIGNATURE_INVALID",
          "The page signature does not match your key on chain. Nothing was published.",
          "nothing-stored",
        );
      }
      const owner = (await resolveName(manifest.name)).owner;
      if (owner !== address)
        return fail(
          reply,
          409,
          "NAME_NOT_YOURS",
          `@${manifest.name} is not registered to your account yet. Nothing was published.`,
          "nothing-stored",
        );
      const [prev] = await db.select({ version: pages.version }).from(pages).where(eq(pages.address, address));
      if (prev && manifest.version <= prev.version)
        return fail(
          reply,
          409,
          "STALE_VERSION",
          "A newer version of your page is already published. Reload to get it.",
          "nothing-stored",
        );
      await db
        .insert(pages)
        .values({ address, name: manifest.name, record: rec, version: manifest.version, unpublished: false })
        .onConflictDoUpdate({
          target: pages.address,
          set: {
            name: manifest.name,
            record: rec,
            version: manifest.version,
            publishedAt: new Date(),
            unpublished: false,
          },
        });
      return { ok: true, version: manifest.version };
    });

    /** Content-blind numbers for the owner home: counts only, never contents. */
    app.get("/owner/stats", async (req, reply) => {
      const address = await sessionAddress(db, req);
      if (!address) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const day = (offset: number) => new Date(Date.now() - offset * 86400_000).toISOString().slice(0, 10);
      const [views] = await db
        .select({
          week: sql<number>`coalesce(sum(case when ${counters.day} > ${day(7)} then ${counters.count} else 0 end), 0)::int`,
          prev: sql<number>`coalesce(sum(case when ${counters.day} <= ${day(7)} and ${counters.day} > ${day(14)} then ${counters.count} else 0 end), 0)::int`,
        })
        .from(counters)
        .where(sql`${counters.owner} = ${address} and ${counters.kind} = 'view'`);
      const taps = await db
        .select({ subject: counters.subject, count: sql<number>`sum(${counters.count})::int` })
        .from(counters)
        .where(sql`${counters.owner} = ${address} and ${counters.kind} = 'tap'`)
        .groupBy(counters.subject);
      const items = await db
        .select({
          kind: envelopes.kind,
          n: sql<number>`count(*)::int`,
          unread: sql<number>`count(*) filter (where ${envelopes.readAt} is null)::int`,
        })
        .from(envelopes)
        .where(sql`${envelopes.owner} = ${address} and not ${envelopes.archived} and ${envelopes.kind} <> 'proof'`)
        .groupBy(envelopes.kind);
      const paid = await db
        .select({
          denom: payments.denom,
          total: sql<string>`sum(${payments.amount}::numeric)::text`,
          n: sql<number>`count(*)::int`,
        })
        .from(payments)
        // Only payments made through the page (with a Mizuhiki reference), as Insights counts them.
        .where(and(eq(payments.toAddr, address), isNotNull(payments.kind)))
        .groupBy(payments.denom);
      return {
        views: { week: views?.week ?? 0, previousWeek: views?.prev ?? 0 },
        taps: Object.fromEntries(taps.map((t) => [t.subject, t.count])),
        items: Object.fromEntries(items.map((i) => [i.kind, { count: i.n, unread: i.unread }])),
        paid: paid.map((p) => ({ denom: p.denom, total: p.total, count: p.n })),
      };
    });

    /** The signed-in owner's own page record, or null (no public 404 while setting up). */
    app.get("/owner/page", async (req, reply) => {
      const address = await sessionAddress(db, req);
      if (!address) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const [page] = await db.select().from(pages).where(eq(pages.address, address));
      return {
        page: page
          ? {
              name: page.name,
              version: page.version,
              unpublished: page.unpublished,
              record: page.record,
              publishedAt: page.publishedAt.toISOString(),
            }
          : null,
      };
    });

    app.post("/pages/unpublish", async (req, reply) => {
      const address = await sessionAddress(db, req);
      if (!address) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      await db.update(pages).set({ unpublished: true }).where(eq(pages.address, address));
      return { ok: true };
    });

    /** A page by name. The visitor's browser re-verifies everything returned here. */
    app.get("/pages/:name", async (req, reply) => {
      const name = normalizeNameInput((req.params as { name: string }).name);
      if (nameProblem(name)) return fail(reply, 404, "NOT_FOUND", "This page isn't available.");
      const reg = await resolveName(name);
      if (!reg.owner) return fail(reply, 404, "NOT_FOUND", "This page isn't available.");
      const [page] = await db.select().from(pages).where(eq(pages.address, reg.owner));
      if (!page || page.unpublished || page.takenDown)
        return fail(reply, 404, "NOT_FOUND", "This page isn't available.");
      if (page.name !== name) return fail(reply, 410, "MOVED", `This @${name} no longer points here.`);
      const [card] = await db.select().from(cards).where(eq(cards.address, reg.owner));
      return { record: page.record, card: card?.card ?? null, registry: { owner: reg.owner, cardHash: reg.cardHash } };
    });

    app.put("/drafts", async (req, reply) => {
      const address = await sessionAddress(db, req);
      if (!address)
        return fail(reply, 401, "SIGNED_OUT", "Sign in first. Your draft is still on this device.", "nothing-stored");
      const blobHash = (req.body as { blobHash?: unknown } | undefined)?.blobHash;
      if (!isHash(blobHash) || !(await ctx.blobs.has(blobHash)))
        return fail(reply, 400, "NO_BLOB", "Upload the sealed draft first.", "nothing-stored");
      const [prev] = await db.select().from(drafts).where(eq(drafts.address, address));
      await db
        .insert(drafts)
        .values({ address, blobHash })
        .onConflictDoUpdate({ target: drafts.address, set: { blobHash, updatedAt: new Date() } });
      // This account keeps its current draft; its hold on the one it replaces goes (other holders keep theirs).
      await hold(db, [blobHash], address, "draft");
      if (prev && prev.blobHash !== blobHash) await release(db, address, "draft", [prev.blobHash]);
      return { ok: true };
    });

    /** Discard the sealed draft: the editor starts again from the published page. */
    app.delete("/drafts", async (req, reply) => {
      const address = await sessionAddress(db, req);
      if (!address) return fail(reply, 401, "SIGNED_OUT", "Sign in first. Nothing changed.");
      const [prev] = await db.select().from(drafts).where(eq(drafts.address, address));
      await db.delete(drafts).where(eq(drafts.address, address));
      if (prev) await release(db, address, "draft", [prev.blobHash]);
      return { ok: true };
    });

    app.get("/drafts", async (req, reply) => {
      const address = await sessionAddress(db, req);
      if (!address) return fail(reply, 401, "SIGNED_OUT", "Sign in first.");
      const [row] = await db.select().from(drafts).where(eq(drafts.address, address));
      return { blobHash: row?.blobHash ?? null, updatedAt: row?.updatedAt.toISOString() ?? null };
    });

    /** Content-blind counters: a view or a tap, counted per day, no IP and no cookie stored. */
    app.post("/count", { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
      const b = z
        .object({ name: z.string().max(40), kind: z.enum(["view", "tap"]), subject: z.string().max(40).default("") })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Nothing was counted.");
      const reg = await resolveName(normalizeNameInput(b.data.name));
      if (!reg.owner) return { ok: false };
      await db
        .insert(counters)
        .values({ owner: reg.owner, day: today(), kind: b.data.kind, subject: b.data.subject, count: 1 })
        .onConflictDoUpdate({
          target: [counters.owner, counters.day, counters.kind, counters.subject],
          set: { count: sql`${counters.count} + 1` },
        });
      return { ok: true };
    });

    app.post("/reports", { config: { rateLimit: { max: 10, timeWindow: "1 hour" } } }, async (req, reply) => {
      const b = z
        .object({
          name: z.string().max(40),
          reason: z.enum(["impersonation", "scam", "abuse", "illegal", "other"]),
          detail: z.string().max(1000).default(""),
        })
        .safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Pick a reason. Nothing was sent.", "nothing-stored");
      await db
        .insert(reports)
        .values({ id: newId(16), name: normalizeNameInput(b.data.name), reason: b.data.reason, detail: b.data.detail });
      return { ok: true };
    });

    done();
  };
