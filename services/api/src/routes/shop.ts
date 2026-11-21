/**
 * Shop (spec 5.11, ARCHITECTURE 8b). Content-blind: product records are public
 * and signed by their owner (checked here against the owner's key on chain and
 * again in every buyer's browser); contents and product keys are sealed blobs.
 * Orders keep the buyer's request, which binds their key through the order
 * reference, reserve stock and call slots, and follow payments from QoreChain.
 */
import type { FastifyPluginCallback, FastifyReply } from "fastify";
import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  OrderRequestSchema,
  PriceError,
  ProductDefSchema,
  balanceRef,
  canonicalJson,
  normalizeNameInput,
  orderRef,
  orderTotal,
  refundRef,
  reviewHashOf,
  sha256Hex,
  utf8,
  verifyRecord,
  type Discount,
  type OrderRequest,
  type ProductDef,
  type Signed,
} from "@mizuhiki/core";
import { DENOMS, getTx } from "@mizuhiki/chain";
import { storePayments } from "@mizuhiki/indexer";
import {
  blobHolds,
  blobs,
  cards,
  discounts,
  media,
  names,
  orderSlots,
  orders,
  payments,
  products,
  reviews,
} from "@mizuhiki/db";
import type { Ctx } from "../server";
import { sessionAddress } from "../lib/auth";
import { pqKeyOf, ownerOfName } from "../lib/chainreads";
import { fail, isAddress, isHash } from "../lib/http";
import { hold, release } from "../lib/holds";

const ID = /^[A-Za-z0-9_-]{6,40}$/;
const REF = /^[A-Za-z0-9_-]{22}$/;
const TX = /^[0-9A-Fa-f]{64}$/;
/** An unpaid order holds stock and call slots for this long. */
const HOLD_MS = 60 * 60_000;
/** Live unpaid orders one network address may hold with one seller. */
const MAX_HOLDS = 3;

type OrderRow = typeof orders.$inferSelect;
type Status = "awaiting" | "in_progress" | "paid" | "delivered" | "refunded" | "expired";

const keyHash = (r: Extract<OrderRequest["recipient"], { kind: "key" }>) =>
  sha256Hex(utf8(canonicalJson({ mlkem: r.mlkem, x25519: r.x25519 })));

export const shopRoutes =
  (ctx: Ctx): FastifyPluginCallback =>
  (app, _opts, done) => {
    const db = ctx.db;
    const notify = async (kind: string, address: string) => {
      await db.execute(sql`select pg_notify('mzk_events', ${`${kind}:${address}`})`);
    };
    /** This account's hold on exactly `hashes` for `purpose` (what it held before for it is released). */
    const keep = async (holder: string, purpose: string, hashes: (string | null | undefined)[]) => {
      const h = hashes.filter((x): x is string => !!x);
      await db.transaction(async (tx) => {
        await release(tx, holder, purpose);
        await hold(tx, h, holder, purpose);
      });
    };
    /**
     * A discount's uses: orders that are paid, or still awaiting payment inside their hold. Unpaid orders that
     * expired do not count (security review L2), so nobody can use up a seller's code with orders they never pay.
     */
    const usesOf = async (ids: string[]): Promise<Map<string, number>> => {
      if (!ids.length) return new Map();
      const rows = await db
        .select({ id: orders.discountId, n: sql<number>`count(*)::int` })
        .from(orders)
        .where(
          and(
            inArray(orders.discountId, ids),
            or(
              inArray(orders.status, ["paid", "balance_due", "delivered"]),
              and(eq(orders.status, "awaiting"), gt(orders.expiresAt, new Date())),
            ),
          ),
        )
        .groupBy(orders.discountId);
      return new Map(rows.map((r) => [r.id ?? "", r.n]));
    };
    const blobsExist = async (hashes: string[]) => {
      if (hashes.length === 0) return true;
      const found = await db.select({ hash: blobs.hash }).from(blobs).where(inArray(blobs.hash, hashes));
      return new Set(found.map((f) => f.hash)).size === new Set(hashes).size;
    };
    const published = async (ids: string[]) =>
      ids.length
        ? await db
            .select()
            .from(products)
            .where(and(inArray(products.id, ids), eq(products.status, "published")))
        : [];
    const recordOf = (row: typeof products.$inferSelect) => (row.record as Signed<ProductDef>).body;

    /** Payments for an order reference to its seller in its token, from the indexer's table. */
    const paidFor = async (
      o: OrderRow,
      ref: string,
    ): Promise<{ sum: bigint; tx: string | null; payer: string | null }> => {
      const denom = DENOMS[o.token as "QOR" | "fUSD"].denom;
      const rows = await db
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.toAddr, o.seller),
            eq(payments.ref, ref),
            eq(payments.kind, "ord"),
            eq(payments.denom, denom),
          ),
        );
      return {
        sum: rows.reduce((n, r) => n + BigInt(r.amount), 0n),
        tx: rows[0]?.txHash ?? null,
        payer: rows[0]?.fromAddr ?? null,
      };
    };

    /** Bring an order's status up to date with the payments seen on chain. */
    async function refresh(o: OrderRow): Promise<OrderRow> {
      if (o.status === "delivered" || o.status === "refunded") return o;
      const dep = await paidFor(o, o.ref);
      const depositOk = dep.sum >= BigInt(o.dueNow);
      let status: Status = o.status as Status;
      const set: Partial<OrderRow> = {};
      if (depositOk) {
        if (!o.depositTx) Object.assign(set, { depositTx: dep.tx, payer: dep.payer, paidAt: new Date() });
        if (BigInt(o.dueLater) > 0n) {
          const bal = await paidFor(o, balanceRef(o.ref));
          if (bal.sum >= BigInt(o.dueLater)) {
            status = "paid";
            if (!o.balanceTx) set.balanceTx = bal.tx;
          } else status = "in_progress";
        } else status = "paid";
      } else if (o.expiresAt < new Date()) status = "expired";
      if (status !== o.status || Object.keys(set).length) {
        const [row] = await db
          .update(orders)
          .set({ ...set, status })
          .where(eq(orders.ref, o.ref))
          .returning();
        if (status === "expired") await db.delete(orderSlots).where(eq(orderSlots.orderRef, o.ref));
        // Tell the seller's open dashboard whenever money arrives: the first payment and a commission's rest.
        if ((status === "paid" || status === "in_progress") && status !== o.status) await notify("order", o.seller);
        return row ?? o;
      }
      return o;
    }

    const orderView = (o: OrderRow) => ({
      ref: o.ref,
      seller: o.seller,
      request: o.request as OrderRequest,
      records: o.records as Signed<ProductDef>[],
      token: o.token,
      total: o.total,
      dueNow: o.dueNow,
      dueLater: o.dueLater,
      status: o.status,
      payer: o.payer,
      depositTx: o.depositTx,
      balanceTx: o.balanceTx,
      refundTx: o.refundTx,
      delivery: o.delivery,
      deliveredBy: o.deliveredBy,
      balanceRequested: o.balanceRequested,
      createdAt: o.createdAt,
      paidAt: o.paidAt,
      deliveredAt: o.deliveredAt,
      expiresAt: o.expiresAt,
    });

    const discountFor = async (
      seller: string,
      code: string | null,
      token: string,
    ): Promise<{ id: string; d: Discount } | null | "bad"> => {
      if (!code) return null;
      const [row] = await db
        .select()
        .from(discounts)
        .where(and(eq(discounts.owner, seller), eq(discounts.code, code.trim().toUpperCase())));
      if (
        !row ||
        !row.active ||
        (row.expiresAt && row.expiresAt < new Date()) ||
        (row.maxUses !== null && ((await usesOf([row.id])).get(row.id) ?? 0) >= row.maxUses)
      )
        return "bad";
      if (row.amountOff && row.token !== token) return "bad";
      return { id: row.id, d: { percent: row.percent, amountOff: row.amountOff, productIds: row.productIds } };
    };

    // ---- seller: products ------------------------------------------------------------------
    const Save = z.object({
      id: z.string().regex(ID),
      slug: z.string().regex(/^[a-z0-9-]{1,48}$/),
      kind: z.string().max(20),
      draftEnvelope: z.string().regex(/^[0-9a-f]{64}$/),
      agentEnvelope: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .nullable()
        .default(null),
      publish: z
        .object({ kind: z.literal("product"), signer: z.string(), body: z.unknown(), signature: z.unknown() })
        .optional(),
      /** Sealed file pieces the (sealed) content page points at: kept with the product instead of being swept. */
      files: z
        .array(z.string().regex(/^[0-9a-f]{64}$/))
        .max(20_000)
        .default([]),
    });

    app.put("/products", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me)
        return fail(
          reply,
          401,
          "SIGNED_OUT",
          "Unlock Mizuhiki on this device first. Nothing was saved.",
          "nothing-stored",
        );
      const b = Save.safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "The product was incomplete. Nothing was saved.", "nothing-stored");
      const [existing] = await db.select().from(products).where(eq(products.id, b.data.id));
      if (existing && existing.owner !== me)
        return fail(
          reply,
          409,
          "TAKEN",
          "That product id belongs to someone else. Nothing was saved.",
          "nothing-stored",
        );
      const [slugOwner] = await db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.owner, me), eq(products.slug, b.data.slug)));
      if (slugOwner && slugOwner.id !== b.data.id)
        return fail(
          reply,
          409,
          "SLUG_TAKEN",
          `You already have a product at /p/${b.data.slug}. Pick another link. Nothing was saved.`,
          "nothing-stored",
        );
      const must = [b.data.draftEnvelope, ...(b.data.agentEnvelope ? [b.data.agentEnvelope] : []), ...b.data.files];

      let record: Signed<ProductDef> | null = null;
      if (b.data.publish) {
        const parsed = ProductDefSchema.safeParse(b.data.publish.body);
        if (!parsed.success)
          return fail(
            reply,
            400,
            "BAD_PRODUCT",
            "The product has a part that is not valid. Nothing was published.",
            "nothing-stored",
          );
        const def = parsed.data;
        if (
          b.data.publish.signer !== me ||
          def.owner !== me ||
          def.id !== b.data.id ||
          def.slug !== b.data.slug ||
          def.kind !== b.data.kind
        )
          return fail(
            reply,
            400,
            "BAD_SIGNATURE",
            "This product is signed for another account or link. Nothing was published.",
            "nothing-stored",
          );
        if (def.version <= (existing?.version ?? 0))
          return fail(
            reply,
            409,
            "STALE",
            "A newer version is already published. Reload and try again.",
            "nothing-stored",
          );
        const owned = await db.select({ name: names.name }).from(names).where(eq(names.address, me));
        if (!owned.some((n) => n.name === normalizeNameInput(def.name)))
          return fail(
            reply,
            400,
            "NOT_YOUR_NAME",
            `@${def.name} is not registered to your account. Nothing was published.`,
            "nothing-stored",
          );
        // Tips, calls, commissions and bundles may have no page of their own (a bundle delivers its parts).
        if (!["tip", "call", "commission", "bundle"].includes(def.kind) && !def.content)
          return fail(
            reply,
            400,
            "NO_CONTENT",
            "Add what the buyer gets in Content before publishing. Nothing was published.",
            "nothing-stored",
          );
        if (def.delivery === "instant" && (!def.agent || !b.data.agentEnvelope))
          return fail(
            reply,
            400,
            "NO_AGENT",
            "Instant delivery needs the helper's key. Nothing was published.",
            "nothing-stored",
          );
        if (def.kind === "bundle" && def.bundle) {
          const parts = await published(def.bundle.productIds);
          if (parts.length !== def.bundle.productIds.length || parts.some((p) => p.owner !== me))
            return fail(
              reply,
              400,
              "BAD_BUNDLE",
              "A bundle can only hold your own published products. Nothing was published.",
              "nothing-stored",
            );
        }
        const pics = [...def.covers.map((c) => c.hash), ...(def.thumbnail ? [def.thumbnail.hash] : [])];
        if (pics.length) {
          const found = await db.select({ hash: media.hash }).from(media).where(inArray(media.hash, pics));
          if (new Set(found.map((f) => f.hash)).size !== new Set(pics).size)
            return fail(
              reply,
              409,
              "MISSING_PARTS",
              "A picture did not finish uploading. Nothing was published.",
              "nothing-stored",
            );
        }
        if (def.content) must.push(def.content);
        const key = await pqKeyOf(me);
        try {
          if (!key.publicKey || !key.possessionProven) throw new Error("no key");
          verifyRecord(b.data.publish as unknown as Signed<ProductDef>, {
            kind: "product",
            signer: me,
            pqPublicKey: key.publicKey,
          });
        } catch {
          return fail(
            reply,
            400,
            "BAD_SIGNATURE",
            "The signature does not match your key on chain. Nothing was published.",
            "nothing-stored",
          );
        }
        record = b.data.publish as unknown as Signed<ProductDef>;
      }
      if (!(await blobsExist(must)))
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "Some sealed parts did not arrive. Nothing was saved.",
          "nothing-stored",
        );
      await keep(me, `product:${b.data.id}`, must);
      const now = new Date();
      await db
        .insert(products)
        .values({
          id: b.data.id,
          owner: me,
          slug: b.data.slug,
          kind: b.data.kind,
          draftEnvelope: b.data.draftEnvelope,
          agentEnvelope: b.data.agentEnvelope,
          ...(record ? { record, version: record.body.version, status: "published" } : {}),
        })
        .onConflictDoUpdate({
          target: products.id,
          set: {
            slug: b.data.slug,
            kind: b.data.kind,
            draftEnvelope: b.data.draftEnvelope,
            agentEnvelope: b.data.agentEnvelope,
            updatedAt: now,
            ...(record ? { record, version: record.body.version, status: "published" } : {}),
          },
        });
      return { ok: true, published: !!record };
    });

    app.get("/owner/products", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const rows = await db.select().from(products).where(eq(products.owner, me)).orderBy(desc(products.updatedAt));
      const stats = await db
        .select({
          id: sql<string>`(jsonb_array_elements(${orders.request}->'lines')->>'productId')`,
          status: orders.status,
          total: orders.total,
          token: orders.token,
        })
        .from(orders)
        .where(and(eq(orders.seller, me), inArray(orders.status, ["paid", "in_progress", "delivered"])));
      return {
        products: rows.map((p) => {
          const mine = stats.filter((s) => s.id === p.id);
          return {
            id: p.id,
            slug: p.slug,
            kind: p.kind,
            status: p.status,
            version: p.version,
            record: p.record,
            draftEnvelope: p.draftEnvelope,
            agentEnvelope: p.agentEnvelope,
            sales: mine.length,
            // Revenue is the order total; an order with several products counts once per product line.
            revenue: mine.reduce((n, s) => n + BigInt(s.total), 0n).toString(),
            updatedAt: p.updatedAt,
          };
        }),
      };
    });

    app.patch("/owner/products/:id", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const { id } = req.params as { id: string };
      const b = z.object({ status: z.enum(["published", "unpublished"]) }).safeParse(req.body);
      if (!b.success) return fail(reply, 400, "BAD_REQUEST", "Bad request. Nothing changed.");
      const [p] = await db
        .select()
        .from(products)
        .where(and(eq(products.id, id), eq(products.owner, me)));
      if (!p) return fail(reply, 404, "NOT_FOUND", "No such product.");
      if (b.data.status === "published" && !p.record)
        return fail(reply, 400, "NEVER_PUBLISHED", "Publish it from the editor first.");
      await db.update(products).set({ status: b.data.status, updatedAt: new Date() }).where(eq(products.id, id));
      return { ok: true };
    });

    app.delete("/owner/products/:id", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const { id } = req.params as { id: string };
      const [p] = await db
        .select()
        .from(products)
        .where(and(eq(products.id, id), eq(products.owner, me)));
      if (!p) return { ok: true };
      const [sold] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .where(
          and(
            eq(orders.seller, me),
            sql`${orders.request}->'lines' @> ${JSON.stringify([{ productId: id }])}::jsonb`,
            ne(orders.status, "expired"),
          ),
        );
      if ((sold?.n ?? 0) > 0)
        return fail(
          reply,
          409,
          "HAS_ORDERS",
          "People bought this, so it cannot be deleted (they keep access). Unpublish it instead.",
        );
      await db.transaction(async (tx) => {
        await tx.delete(products).where(eq(products.id, id));
        await release(tx, me, `product:${id}`);
      });
      return { ok: true };
    });

    /** The Instant delivery helper this server offers sellers (they may enter another, self-hosted one). */
    app.get("/shop/helper", () => ({
      address: isAddress(process.env.DELIVERY_AGENT_ADDRESS) ? process.env.DELIVERY_AGENT_ADDRESS : null,
    }));

    // ---- public: product pages -------------------------------------------------------------
    const publicView = async (p: typeof products.$inferSelect) => {
      const def = recordOf(p);
      const counted = await db
        .select({
          line: sql<{
            productId: string;
            versionId: string | null;
            quantity: number;
          }>`jsonb_array_elements(${orders.request}->'lines')`,
          status: orders.status,
        })
        .from(orders)
        .where(
          and(
            eq(orders.seller, p.owner),
            or(
              inArray(orders.status, ["paid", "in_progress", "delivered"]),
              and(eq(orders.status, "awaiting"), gt(orders.expiresAt, new Date())),
            ),
          ),
        );
      const mine = counted.filter((c) => c.line.productId === p.id);
      const sold = mine.filter((c) => c.status !== "awaiting").reduce((n, c) => n + c.line.quantity, 0);
      const held = mine.reduce((n, c) => n + c.line.quantity, 0);
      const versionsLeft = Object.fromEntries(
        def.versions.map((v) => [
          v.id,
          v.max === null
            ? null
            : Math.max(
                0,
                v.max - mine.filter((c) => c.line.versionId === v.id).reduce((n, c) => n + c.line.quantity, 0),
              ),
        ]),
      );
      const [rating] = await db
        .select({ avg: sql<number | null>`avg(${reviews.rating})::float`, n: sql<number>`count(*)::int` })
        .from(reviews)
        .where(eq(reviews.productId, p.id));
      const latest = await db
        .select()
        .from(reviews)
        .where(eq(reviews.productId, p.id))
        .orderBy(desc(reviews.createdAt))
        .limit(20);
      const booked =
        def.kind === "call"
          ? (await db.select({ slot: orderSlots.slot }).from(orderSlots).where(eq(orderSlots.productId, p.id))).map(
              (s) => s.slot,
            )
          : [];
      return {
        record: p.record as Signed<ProductDef>,
        status: p.status,
        sales: def.limits.showSales ? sold : null,
        left: def.limits.maxSales === null ? null : Math.max(0, def.limits.maxSales - held),
        versionsLeft,
        rating: { average: rating?.avg ?? null, count: rating?.n ?? 0 },
        reviews: latest.map((r) => ({ rating: r.rating, text: r.text, at: r.createdAt })),
        booked,
      };
    };

    app.get("/products/:name/:slug", async (req, reply) => {
      const { name, slug } = req.params as { name: string; slug: string };
      const address = await ownerOfName(db, name);
      if (!address) return fail(reply, 404, "NOT_FOUND", "This product is not available.");
      const owner = { address };
      const [p] = await db
        .select()
        .from(products)
        .where(and(eq(products.owner, owner.address), eq(products.slug, slug)));
      if (!p?.record || p.status !== "published")
        return fail(reply, 404, "NOT_FOUND", "This product is not available.");
      return publicView(p);
    });

    /** Published products of a page (for a Shop section, product buttons, bundles). */
    app.get("/shop/:name", async (req, reply) => {
      const { name } = req.params as { name: string };
      const address = await ownerOfName(db, name);
      if (!address) return fail(reply, 404, "NOT_FOUND", "This page does not exist.");
      const owner = { address };
      const rows = await db
        .select()
        .from(products)
        .where(and(eq(products.owner, owner.address), eq(products.status, "published")));
      const out = [];
      for (const p of rows) {
        const [rating] = await db
          .select({ avg: sql<number | null>`avg(${reviews.rating})::float`, n: sql<number>`count(*)::int` })
          .from(reviews)
          .where(eq(reviews.productId, p.id));
        out.push({
          record: p.record as Signed<ProductDef>,
          rating: { average: rating?.avg ?? null, count: rating?.n ?? 0 },
        });
      }
      return { products: out };
    });

    // ---- discounts -------------------------------------------------------------------------
    const DiscountBody = z.object({
      id: z.string().regex(ID),
      code: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/),
      percent: z.number().int().min(1).max(100).nullable(),
      amountOff: z
        .string()
        .regex(/^\d{1,40}$/)
        .nullable(),
      token: z.enum(["QOR", "fUSD"]).nullable(),
      productIds: z.array(z.string().regex(ID)).max(100).default([]),
      maxUses: z.number().int().min(1).max(1_000_000).nullable(),
      expiresAt: z.iso.datetime().nullable(),
      active: z.boolean().default(true),
    });

    app.get("/owner/discounts", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      return {
        discounts: await (async () => {
          const rows = await db
            .select()
            .from(discounts)
            .where(eq(discounts.owner, me))
            .orderBy(desc(discounts.createdAt));
          const used = await usesOf(rows.map((r) => r.id));
          return rows.map((r) => ({ ...r, uses: used.get(r.id) ?? 0 }));
        })(),
      };
    });

    app.put("/owner/discounts", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const b = DiscountBody.safeParse(req.body);
      if (
        !b.success ||
        (b.data.percent === null) === (b.data.amountOff === null) ||
        (b.data.amountOff !== null && !b.data.token)
      )
        return fail(
          reply,
          400,
          "BAD_REQUEST",
          "A discount is either a percent or an amount in one token. Nothing was saved.",
          "nothing-stored",
        );
      const code = b.data.code.toUpperCase();
      const [clash] = await db
        .select({ id: discounts.id })
        .from(discounts)
        .where(and(eq(discounts.owner, me), eq(discounts.code, code)));
      if (clash && clash.id !== b.data.id)
        return fail(reply, 409, "CODE_TAKEN", `You already have a code ${code}. Nothing was saved.`, "nothing-stored");
      const [mine] = await db.select({ owner: discounts.owner }).from(discounts).where(eq(discounts.id, b.data.id));
      if (mine && mine.owner !== me)
        return fail(reply, 409, "TAKEN", "That discount belongs to someone else.", "nothing-stored");
      const row = { ...b.data, code, owner: me, expiresAt: b.data.expiresAt ? new Date(b.data.expiresAt) : null };
      await db.insert(discounts).values(row).onConflictDoUpdate({ target: discounts.id, set: row });
      return { ok: true };
    });

    app.delete("/owner/discounts/:id", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      await db
        .delete(discounts)
        .where(and(eq(discounts.id, (req.params as { id: string }).id), eq(discounts.owner, me)));
      return { ok: true };
    });

    /** The check runs here, never as a list in the browser. */
    app.post("/discounts/check", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
      const b = z
        .object({ seller: z.string().refine(isAddress), code: z.string().max(40), token: z.enum(["QOR", "fUSD"]) })
        .safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "That request was incomplete. Reload the page and try again.");
      const d = await discountFor(b.data.seller, b.data.code, b.data.token);
      if (d === "bad" || d === null) return fail(reply, 404, "NO_DISCOUNT", "That code is not valid for this order.");
      return { discount: d.d };
    });

    // ---- orders ----------------------------------------------------------------------------
    app.post("/orders", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
      const parsed = OrderRequestSchema.safeParse((req.body as { request?: unknown } | undefined)?.request);
      if (!parsed.success)
        return fail(reply, 400, "BAD_REQUEST", "The order was incomplete. Nothing was charged.", "nothing-stored");
      const r = parsed.data;
      const ref = orderRef(r);
      const [again] = await db.select().from(orders).where(eq(orders.ref, ref));
      if (again) return { ...orderView(await refresh(again)), payTo: again.seller, memo: `mzk:ord:${ref}` };
      const rows = await published([...new Set(r.lines.map((l) => l.productId))]);
      const defs = rows.map(recordOf);
      // Bundle parts travel with the order too, so the deliverer can check every product it seals.
      const parts = await published([...new Set(defs.flatMap((d) => d.bundle?.productIds ?? []))]);
      const records = [...rows, ...parts.filter((p) => !rows.some((x) => x.id === p.id))].map(
        (p) => p.record as Signed<ProductDef>,
      );
      if (r.recipient.kind === "account") {
        const [card] = await db.select({ a: cards.address }).from(cards).where(eq(cards.address, r.recipient.address));
        if (!card)
          return fail(
            reply,
            400,
            "NO_ACCOUNT",
            "That wallet has not set up a Mizuhiki key, so nothing can be sealed to it. Nothing was charged.",
            "nothing-stored",
          );
      }
      const disc = await discountFor(r.seller, r.discountCode, r.token);
      if (disc === "bad")
        return fail(
          reply,
          400,
          "NO_DISCOUNT",
          "That discount code is not valid for this order. Nothing was charged.",
          "nothing-stored",
        );
      let total;
      try {
        total = orderTotal(r, defs, disc?.d ?? null);
      } catch (e) {
        if (e instanceof PriceError)
          return fail(reply, 409, "PRICE", `${e.message} Nothing was charged.`, "nothing-stored");
        throw e;
      }
      // Stock, version caps and call slots: count live orders (paid, or unpaid and still held).
      for (const line of r.lines) {
        const row = rows.find((p) => p.id === line.productId);
        const view = row ? await publicView(row) : null;
        const def = row ? recordOf(row) : null;
        if (!view || !def) continue;
        if (view.left !== null && view.left < line.quantity)
          return fail(reply, 409, "SOLD_OUT", `“${def.title}” is sold out. Nothing was charged.`, "nothing-stored");
        const vl = line.versionId ? view.versionsLeft[line.versionId] : null;
        if (vl !== null && vl !== undefined && vl < line.quantity)
          return fail(
            reply,
            409,
            "SOLD_OUT",
            `That option of “${def.title}” is sold out. Nothing was charged.`,
            "nothing-stored",
          );
      }
      // Unpaid orders hold stock and call slots; one network address may hold only a few at a time per seller.
      const holdBy = sha256Hex(utf8(`mzk:hold:${req.ip}`));
      const [holding] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(orders)
        .where(
          and(
            eq(orders.seller, r.seller),
            eq(orders.holdBy, holdBy),
            eq(orders.status, "awaiting"),
            gt(orders.expiresAt, new Date()),
          ),
        );
      if ((holding?.n ?? 0) >= MAX_HOLDS)
        return fail(
          reply,
          429,
          "TOO_MANY_HOLDS",
          "You have several unpaid orders with this seller. Pay or wait for one to expire (an hour). Nothing was charged.",
          "nothing-stored",
        );
      const expiresAt = new Date(Date.now() + HOLD_MS);
      try {
        await db.transaction(async (tx) => {
          // Expired holds give their slots back first.
          await tx.delete(orderSlots).where(
            inArray(
              orderSlots.orderRef,
              db
                .select({ ref: orders.ref })
                .from(orders)
                .where(and(eq(orders.status, "awaiting"), lt(orders.expiresAt, new Date()))),
            ),
          );
          for (const line of r.lines)
            if (line.slot)
              await tx.insert(orderSlots).values({ productId: line.productId, slot: line.slot, orderRef: ref });
          await tx.insert(orders).values({
            ref,
            seller: r.seller,
            request: r,
            records,
            token: r.token,
            total: total.total.toString(),
            dueNow: total.dueNow.toString(),
            dueLater: total.dueLater.toString(),
            recipientAddress: r.recipient.kind === "account" ? r.recipient.address : null,
            recipientKeyHash: r.recipient.kind === "key" ? keyHash(r.recipient) : null,
            discountId: disc?.id ?? null,
            reviewHash: r.reviewHash,
            holdBy,
            expiresAt,
          });
        });
      } catch (e) {
        // Postgres unique violation, possibly wrapped by the query builder (DrizzleQueryError.cause).
        const pg = e as { code?: string; cause?: { code?: string } };
        if (pg.code === "23505" || pg.cause?.code === "23505")
          return fail(
            reply,
            409,
            "SLOT_TAKEN",
            "Someone just booked that time. Pick another. Nothing was charged.",
            "nothing-stored",
          );
        throw e;
      }
      await notify("order", r.seller);
      const [row] = await db.select().from(orders).where(eq(orders.ref, ref));
      return reply.code(201).send({
        ...orderView(row as OrderRow),
        payTo: r.seller,
        memo: `mzk:ord:${ref}`,
        lines: total.lines.map((l) => ({ ...l, unit: l.unit.toString(), subtotal: l.subtotal.toString() })),
      });
    });

    app.get("/orders/:ref", async (req, reply) => {
      const { ref } = req.params as { ref: string };
      if (!REF.test(ref)) return fail(reply, 404, "NOT_FOUND", "No such order.");
      const [o] = await db.select().from(orders).where(eq(orders.ref, ref));
      if (!o) return fail(reply, 404, "NOT_FOUND", "No such order.");
      return { ...orderView(await refresh(o)), payTo: o.seller, memo: `mzk:ord:${ref}` };
    });

    /**
     * Fast path after paying: the buyer's browser names its transaction; the server reads it from QoreChain
     * and records the payment exactly as the indexer would. Nothing is trusted from the request but the hash.
     */
    app.post("/orders/:ref/tx", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
      const { ref } = req.params as { ref: string };
      const b = z.object({ txHash: z.string().regex(TX) }).safeParse(req.body);
      if (!REF.test(ref) || !b.success)
        return fail(reply, 400, "BAD_REQUEST", "That request was incomplete. Reload the page and try again.");
      const [o] = await db.select().from(orders).where(eq(orders.ref, ref));
      if (!o) return fail(reply, 404, "NOT_FOUND", "No such order.");
      const t = await getTx(b.data.txHash.toUpperCase()).catch(() => undefined);
      if (t) await storePayments(db, o.seller, t);
      return { ...orderView(await refresh(o)), payTo: o.seller, memo: `mzk:ord:${ref}`, seen: !!t };
    });

    app.get("/orders/mine", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const rows = await db
        .select()
        .from(orders)
        .where(or(eq(orders.recipientAddress, me), eq(orders.payer, me)))
        .orderBy(desc(orders.createdAt))
        .limit(200);
      const out = [];
      for (const o of rows) out.push(orderView(await refresh(o)));
      return { orders: out };
    });

    /** Purchases sealed to a buyer key (no account): looked up by the hash of the key's public parts. */
    app.get("/orders/by-key/:hash", async (req, reply) => {
      const { hash } = req.params as { hash: string };
      if (!isHash(hash))
        return fail(reply, 400, "BAD_REQUEST", "That request was incomplete. Reload the page and try again.");
      const rows = await db
        .select()
        .from(orders)
        .where(eq(orders.recipientKeyHash, hash))
        .orderBy(desc(orders.createdAt))
        .limit(200);
      const out = [];
      for (const o of rows) out.push(orderView(await refresh(o)));
      return { orders: out };
    });

    // ---- seller: orders and delivery -------------------------------------------------------
    app.get("/owner/orders", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const rows = await db
        .select()
        .from(orders)
        .where(and(eq(orders.seller, me), or(ne(orders.status, "awaiting"), gt(orders.expiresAt, new Date()))))
        .orderBy(desc(orders.createdAt))
        .limit(500);
      const out = [];
      for (const o of rows) out.push(orderView(await refresh(o)));
      return { orders: out };
    });

    /** Orders an "Instant delivery" helper may deliver: paid, not delivered, for products naming this helper. */
    app.get("/agent/orders", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const mine = await db
        .select()
        .from(products)
        .where(
          and(
            eq(products.status, "published"),
            sql`${products.record}->'body'->>'agent' = ${me}`,
            sql`${products.record}->'body'->>'delivery' = 'instant'`,
          ),
        );
      if (mine.length === 0) return { orders: [], products: [] };
      const sellers = [...new Set(mine.map((p) => p.owner))];
      const rows = await db
        .select()
        .from(orders)
        .where(
          and(inArray(orders.seller, sellers), inArray(orders.status, ["awaiting", "paid"]), isNull(orders.delivery)),
        );
      const ids = new Set(mine.map((p) => p.id));
      const out = [];
      for (const o of rows) {
        const lines = (o.request as OrderRequest).lines;
        if (!lines.every((l) => ids.has(l.productId))) continue;
        const r = await refresh(o);
        if (r.status === "paid") out.push(orderView(r));
      }
      return {
        orders: out,
        products: mine.map((p) => ({ id: p.id, record: p.record, agentEnvelope: p.agentEnvelope })),
      };
    });

    app.post("/orders/:ref/deliver", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.", "nothing-stored");
      const { ref } = req.params as { ref: string };
      const b = z.object({ envelope: z.string().regex(/^[0-9a-f]{64}$/) }).safeParse(req.body);
      if (!REF.test(ref) || !b.success)
        return fail(
          reply,
          400,
          "BAD_REQUEST",
          "That request was incomplete. Reload the page and try again.",
          "nothing-stored",
        );
      const [o0] = await db.select().from(orders).where(eq(orders.ref, ref));
      if (!o0) return fail(reply, 404, "NOT_FOUND", "No such order.", "nothing-stored");
      const o = await refresh(o0);
      const lines = (o.request as OrderRequest).lines;
      let allowed = me === o.seller;
      if (!allowed) {
        const rows = await db
          .select()
          .from(products)
          .where(
            inArray(
              products.id,
              lines.map((l) => l.productId),
            ),
          );
        allowed = rows.length > 0 && rows.every((p) => recordOf(p).delivery === "instant" && recordOf(p).agent === me);
      }
      if (!allowed)
        return fail(
          reply,
          403,
          "NOT_YOURS",
          "Only the seller or their delivery helper can deliver this order.",
          "nothing-stored",
        );
      if (o.status === "delivered") return { ok: true, already: true };
      if (o.status !== "paid")
        return fail(
          reply,
          409,
          "NOT_PAID",
          "This order is not fully paid on QoreChain yet. Nothing was delivered.",
          "nothing-stored",
        );
      if (!(await blobsExist([b.data.envelope])))
        return fail(
          reply,
          409,
          "MISSING_PARTS",
          "The sealed delivery did not arrive. Nothing was delivered.",
          "nothing-stored",
        );
      // What the buyer bought stays as long as the order does, even if the seller later deletes the product
      // or the page: the delivery and the content of every product in the order are held for the order.
      const content = await db
        .select({ hash: blobHolds.hash })
        .from(blobHolds)
        .where(
          and(
            eq(blobHolds.holder, o.seller),
            inArray(
              blobHolds.purpose,
              lines.map((l) => `product:${l.productId}`),
            ),
          ),
        );
      await hold(db, [b.data.envelope, ...content.map((c) => c.hash)], o.seller, `order:${ref}`);
      await db
        .update(orders)
        .set({ status: "delivered", delivery: b.data.envelope, deliveredBy: me, deliveredAt: new Date() })
        .where(eq(orders.ref, ref));
      if (o.recipientAddress) await notify("order", o.recipientAddress);
      return { ok: true };
    });

    app.post("/orders/:ref/balance", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const { ref } = req.params as { ref: string };
      const [o] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.ref, ref), eq(orders.seller, me)));
      if (!o) return fail(reply, 404, "NOT_FOUND", "No such order.");
      if (BigInt(o.dueLater) === 0n) return fail(reply, 400, "NO_BALANCE", "This order has nothing left to pay.");
      await db.update(orders).set({ balanceRequested: true }).where(eq(orders.ref, ref));
      if (o.recipientAddress) await notify("order", o.recipientAddress);
      return { ok: true };
    });

    /** A refund is the seller's own transfer back; recorded only once QoreChain shows it. */
    app.post("/orders/:ref/refund", async (req, reply) => {
      const me = await sessionAddress(db, req);
      if (!me) return fail(reply, 401, "SIGNED_OUT", "Unlock Mizuhiki on this device first.");
      const { ref } = req.params as { ref: string };
      const b = z.object({ txHash: z.string().regex(TX) }).safeParse(req.body);
      if (!b.success)
        return fail(reply, 400, "BAD_REQUEST", "That request was incomplete. Reload the page and try again.");
      const [o] = await db
        .select()
        .from(orders)
        .where(and(eq(orders.ref, ref), eq(orders.seller, me)));
      if (!o?.payer) return fail(reply, 404, "NOT_FOUND", "No paid order with that reference.");
      const t = await getTx(b.data.txHash.toUpperCase()).catch(() => undefined);
      const denom = DENOMS[o.token as "QOR" | "fUSD"].denom;
      const sends = (
        (t?.tx?.body?.messages ?? []) as {
          "@type"?: string;
          from_address?: string;
          to_address?: string;
          amount?: { denom: string; amount: string }[];
        }[]
      ).filter(
        (m) => m["@type"] === "/cosmos.bank.v1beta1.MsgSend" && m.from_address === me && m.to_address === o.payer,
      );
      const sum = sends
        .flatMap((m) => m.amount ?? [])
        .filter((c) => c.denom === denom)
        .reduce((n, c) => n + BigInt(c.amount), 0n);
      if (!t || t.code !== 0 || t.tx?.body?.memo !== `mzk:ord:${refundRef(ref)}` || sum === 0n)
        return fail(
          reply,
          409,
          "NOT_ON_CHAIN",
          "QoreChain does not show that refund (from you, to the buyer, with this order's refund memo). Nothing changed.",
        );
      await db
        .update(orders)
        .set({ status: "refunded", refundTx: b.data.txHash.toUpperCase() })
        .where(eq(orders.ref, ref));
      if (o.recipientAddress) await notify("order", o.recipientAddress);
      return { ok: true, refunded: sum.toString() };
    });

    // ---- reviews ---------------------------------------------------------------------------
    app.post(
      "/orders/:ref/review",
      { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
      async (req, reply) => {
        const { ref } = req.params as { ref: string };
        const b = z
          .object({
            secret: z.string().min(16).max(128),
            productId: z.string().regex(ID),
            rating: z.number().int().min(1).max(5),
            text: z.string().max(2000).default(""),
          })
          .safeParse(req.body);
        if (!REF.test(ref) || !b.success)
          return fail(reply, 400, "BAD_REQUEST", "Bad request. The review was not posted.");
        const [o] = await db.select().from(orders).where(eq(orders.ref, ref));
        if (!o || reviewHashOf(b.data.secret) !== o.reviewHash)
          return fail(reply, 403, "NOT_BUYER", "Only the buyer of this order can review it.");
        if (o.status !== "delivered")
          return fail(reply, 409, "NOT_DELIVERED", "You can review once your purchase has arrived.");
        if (!(o.request as OrderRequest).lines.some((l) => l.productId === b.data.productId))
          return fail(reply, 400, "NOT_IN_ORDER", "That product is not in this order.");
        const now = new Date();
        await db
          .insert(reviews)
          .values({
            orderRef: ref,
            productId: b.data.productId,
            seller: o.seller,
            rating: b.data.rating,
            text: b.data.text.trim(),
          })
          .onConflictDoUpdate({
            target: [reviews.orderRef, reviews.productId],
            set: { rating: b.data.rating, text: b.data.text.trim(), updatedAt: now },
          });
        return { ok: true };
      },
    );

    app.get("/orders/:ref/review", async (req, reply: FastifyReply) => {
      const { ref } = req.params as { ref: string };
      if (!REF.test(ref))
        return fail(reply, 400, "BAD_REQUEST", "That request was incomplete. Reload the page and try again.");
      return { reviews: await db.select().from(reviews).where(eq(reviews.orderRef, ref)) };
    });

    done();
  };
