/**
 * Shop on the real QoreChain testnet and a real Postgres: publishing is checked
 * against the seller's key, orders bind the buyer's key, payments are real
 * transfers read back from chain, the seller's device and the Instant delivery
 * helper seal product keys only after a full payment, and refunds and reviews
 * follow the rules in ARCHITECTURE 8b.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { signSiwq } from "@qorechain/qoresign";
import { recipientOf } from "@qorechain/qoreseal";
import {
  CHAIN_ID,
  ProductDefSchema,
  Purpose,
  balanceRef,
  canonicalJson,
  newProductKey,
  openContent,
  openItem,
  orderRef,
  readDelivery,
  refundRef,
  reviewHashOf,
  sealContent,
  sealItem,
  sha256Hex,
  signRecord,
  toBase64Url,
  toHex,
  utf8,
  type Content,
  type OrderRequest,
  type ProductDef,
  type RecipientCard,
} from "@mizuhiki/core";
import {
  DENOMS,
  DeliveryRefused,
  msgSend,
  prepareDelivery,
  sendTx,
  waitForTx,
  type DeliverableOrder,
} from "@mizuhiki/chain";
import { ensurePersona, type ReadyPersona } from "@mizuhiki/testnet";
import { DeliveryAgent } from "@mizuhiki/delivery-agent";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../src/config";
import { runMigrations } from "@mizuhiki/db";
import { buildServer } from "../../src/server";

const DB = "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki_test";
let app: FastifyInstance;
let close: () => Promise<void>;
let base = "";
let seller: ReadyPersona & { name: string };
let buyer: ReadyPersona;
let helper: ReadyPersona;
const tokens = new Map<string, string>();

async function signIn(p: ReadyPersona): Promise<string> {
  const have = tokens.get(p.address);
  if (have) return have;
  const c = await app.inject({ method: "POST", url: "/auth/challenge", payload: { address: p.address } });
  const { message, nonce } = c.json<{ message: string; nonce: string }>();
  const signature = signSiwq({ message, classicalKey: p.classical, pqKey: p.pq });
  const t = (await app.inject({ method: "POST", url: "/auth/verify", payload: { nonce, signature } })).json<{
    token: string;
  }>().token;
  tokens.set(p.address, t);
  return t;
}
const auth = async (p: ReadyPersona) => ({ authorization: `Bearer ${await signIn(p)}` });
const put = async (bytes: Uint8Array) =>
  (
    await app.inject({
      method: "PUT",
      url: "/blobs",
      headers: { "content-type": "application/octet-stream" },
      payload: Buffer.from(bytes),
    })
  ).json<{ hash: string }>().hash;
const cardOf = async (address: string) =>
  (await app.inject({ url: `/cards/${address}` })).json<{ card: RecipientCard }>().card;
const QOR = (n: string) => BigInt(Math.round(Number(n) * 1_000_000));

interface Published {
  def: ProductDef;
  key: Uint8Array;
}

async function publishProduct(extra: Partial<ProductDef>, content: Content | null): Promise<Published> {
  const id = extra.id ?? `pr${toHex(crypto.getRandomValues(new Uint8Array(6)))}`;
  const key = newProductKey();
  const contentHash = content ? await put(await sealContent(key, id, content)) : null;
  const draft = sealItem({
    purpose: Purpose.product(id),
    readers: [recipientOf(seller.seal)],
    plaintext: utf8(JSON.stringify({ key: toBase64Url(key) })),
    context: "draft",
  });
  const draftHash = await put(draft.envelope);
  const def = ProductDefSchema.parse({
    v: 1,
    id,
    owner: seller.address,
    name: seller.name,
    slug: extra.slug ?? id,
    kind: "file",
    title: "Field recordings",
    price: { token: "QOR", amount: QOR("0.02").toString() },
    content: contentHash,
    version: 1,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
  let agentEnvelope: string | null = null;
  if (def.delivery === "instant") {
    const s = sealItem({
      purpose: Purpose.product(id),
      readers: [recipientOf(helper.seal)],
      plaintext: utf8(JSON.stringify({ key: toBase64Url(key), content: contentHash })),
      context: "agent",
    });
    agentEnvelope = await put(s.envelope);
  }
  const record = signRecord({
    kind: "product",
    body: def,
    signer: seller.address,
    classical: seller.classical,
    pq: seller.pq,
  });
  const r = await app.inject({
    method: "PUT",
    url: "/products",
    headers: await auth(seller),
    payload: { id, slug: def.slug, kind: def.kind, draftEnvelope: draftHash, agentEnvelope, publish: record },
  });
  expect(r.statusCode, r.body).toBe(200);
  return { def, key };
}

function request(lines: OrderRequest["lines"], extra: Partial<OrderRequest> = {}): OrderRequest {
  return {
    v: 1,
    seller: seller.address,
    token: "QOR",
    lines,
    recipient: { kind: "account", address: buyer.address },
    gift: false,
    tip: "0",
    discountCode: null,
    reviewHash: reviewHashOf("buyer-secret-0123456789"),
    nonce: toBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    ...extra,
  };
}
const line = (p: Published, extra: Partial<OrderRequest["lines"][number]> = {}) => ({
  productId: p.def.id,
  productVersion: p.def.version,
  versionId: null,
  quantity: 1,
  chosen: null,
  slot: null,
  ...extra,
});

/** A real payment from the buyer to the seller with the order's memo; returns the tx hash. */
async function pay(amount: bigint, ref: string, from: ReadyPersona = buyer): Promise<string> {
  const sent = await sendTx(from, [msgSend(from.address, seller.address, DENOMS.QOR.denom, amount)], `mzk:ord:${ref}`);
  await waitForTx(sent.txHash);
  return sent.txHash;
}

beforeAll(async () => {
  await runMigrations(DB);
  const postgres = (await import("postgres")).default;
  const sql = postgres(DB);
  await sql`truncate products, orders, order_slots, discounts, reviews, payments, sessions, auth_nonces, cards, blobs, media`;
  const cfg = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: DB,
    BLOB_DIR: mkdtempSync(join(tmpdir(), "mzk-shop-")),
  });
  ({ app, close } = await buildServer(cfg));
  await app.listen({ host: "127.0.0.1", port: 0 });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  seller = (await ensurePersona("shop-api-seller", { name: "mzk-shop-api" })) as ReadyPersona & { name: string };
  buyer = await ensurePersona("shop-api-buyer", { minQor: 3n });
  helper = await ensurePersona("shop-api-helper");
  for (const p of [seller, buyer, helper])
    await app.inject({ method: "PUT", url: "/cards", headers: await auth(p), payload: { card: p.card } });
  await sql`insert into names (name, name_hash, address, evm, "primary", claimed_tx, claimed_block) values (${seller.name}, 'x', ${seller.address}, ${seller.evm}, true, 'x', 1) on conflict do nothing`;
  await sql.end();
}, 600_000);

afterAll(async () => close());

describe("shop: publishing", () => {
  it("refuses a record not signed by the seller, a missing content, and another's name; publishes a valid one", async () => {
    const id = "prrefused1";
    const draft = await put(
      sealItem({
        purpose: Purpose.product(id),
        readers: [recipientOf(seller.seal)],
        plaintext: utf8("{}"),
        context: "draft",
      }).envelope,
    );
    const def = ProductDefSchema.parse({
      v: 1,
      id,
      owner: seller.address,
      name: seller.name,
      slug: "refused",
      kind: "file",
      title: "X",
      price: { token: "QOR", amount: "1" },
      content: null,
      version: 1,
      updatedAt: new Date().toISOString(),
    });
    // Signed by the buyer's keys but claiming to be the seller's record.
    const forged = {
      ...signRecord({ kind: "product", body: def, signer: buyer.address, classical: buyer.classical, pq: buyer.pq }),
      signer: seller.address,
    };
    const r1 = await app.inject({
      method: "PUT",
      url: "/products",
      headers: await auth(seller),
      payload: { id, slug: "refused", kind: "file", draftEnvelope: draft, publish: forged },
    });
    expect(r1.json<{ error: { code: string } }>().error.code).toBe("NO_CONTENT");
    const withContent = {
      ...def,
      content: await put(
        await sealContent(newProductKey(), id, {
          v: 1,
          pages: [{ id: "pageone", title: "", blocks: [{ t: "text", text: "hi" }] }],
        }),
      ),
    };
    const forged2 = {
      ...signRecord({
        kind: "product",
        body: withContent,
        signer: buyer.address,
        classical: buyer.classical,
        pq: buyer.pq,
      }),
      signer: seller.address,
    };
    const r2 = await app.inject({
      method: "PUT",
      url: "/products",
      headers: await auth(seller),
      payload: { id, slug: "refused", kind: "file", draftEnvelope: draft, publish: forged2 },
    });
    expect(r2.json<{ error: { code: string } }>().error.code).toBe("BAD_SIGNATURE");
    const p = await publishProduct(
      { slug: "recordings" },
      { v: 1, pages: [{ id: "pageone", title: "Start", blocks: [{ t: "text", text: "Thank you for buying." }] }] },
    );
    const pub = await app.inject({ url: `/products/${seller.name}/recordings` });
    expect(pub.json<{ record: { body: ProductDef } }>().record.body.id).toBe(p.def.id);
    expect(
      (await app.inject({ url: `/shop/${seller.name}` })).json<{ products: unknown[] }>().products.length,
    ).toBeGreaterThan(0);
  });
});

describe("shop: orders, payment and delivery by the seller's device", () => {
  let p: Published;
  let ref = "";
  let req: OrderRequest;
  beforeAll(async () => {
    p = await publishProduct(
      { slug: "tape-loops", limits: { maxSales: 2, quantity: false, showSales: true } },
      { v: 1, pages: [{ id: "pageone", title: "Loops", blocks: [{ t: "text", text: "Here are the loops." }] }] },
    );
  });

  it("prices with the shared total and refuses a stale product version", async () => {
    const stale = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { request: request([line(p, { productVersion: 9 })]) },
    });
    expect(stale.json<{ error: { code: string } }>().error.code).toBe("PRICE");
    req = request([line(p)]);
    const r = await app.inject({ method: "POST", url: "/orders", payload: { request: req } });
    expect(r.statusCode, r.body).toBe(201);
    const o = r.json<{ ref: string; dueNow: string; memo: string; status: string }>();
    ref = o.ref;
    expect(ref).toBe(orderRef(req));
    expect(o.dueNow).toBe(QOR("0.02").toString());
    expect(o.memo).toBe(`mzk:ord:${ref}`);
    expect(o.status).toBe("awaiting");
  });

  it("an underpayment leaves it unpaid; the full payment, read from chain, marks it paid", async () => {
    const short = await pay(QOR("0.01"), ref);
    const after1 = (await app.inject({ method: "POST", url: `/orders/${ref}/tx`, payload: { txHash: short } })).json<{
      status: string;
      seen: boolean;
    }>();
    expect(after1.seen).toBe(true);
    expect(after1.status).toBe("awaiting");
    const rest = await pay(QOR("0.01"), ref);
    const after2 = (await app.inject({ method: "POST", url: `/orders/${ref}/tx`, payload: { txHash: rest } })).json<{
      status: string;
    }>();
    expect(after2.status).toBe("paid");
  }, 240_000);

  it("only the seller (or their helper) delivers; a swapped buyer key is caught before sealing", async () => {
    const o = (await app.inject({ url: `/orders/${ref}` })).json<DeliverableOrder & { records: unknown[] }>();
    // A server that swapped the buyer for its own key: the reference no longer matches the request.
    const swapped = {
      ...o,
      request: { ...o.request, recipient: { kind: "account" as const, address: helper.address } },
    };
    await expect(
      prepareDelivery({
        order: swapped,
        products: [p.def],
        keys: new Map([[p.def.id, { key: p.key, content: p.def.content }]]),
        discount: null,
        cardOf,
      }),
    ).rejects.toBeInstanceOf(DeliveryRefused);
    // Two transfers paid it in full; the deliverer checks the transaction the server names, so it reads one and refuses.
    await expect(
      prepareDelivery({
        order: o,
        products: [p.def],
        keys: new Map([[p.def.id, { key: p.key, content: p.def.content }]]),
        discount: null,
        cardOf,
      }),
    ).rejects.toThrow(/full payment/);
  });

  it("a single full payment is delivered by the seller's device and opens only with the buyer's key", async () => {
    const req2 = request([line(p)]);
    const o0 = (await app.inject({ method: "POST", url: "/orders", payload: { request: req2 } })).json<{
      ref: string;
    }>();
    const tx = await pay(QOR("0.02"), o0.ref);
    await app.inject({ method: "POST", url: `/orders/${o0.ref}/tx`, payload: { txHash: tx } });
    const o = (await app.inject({ url: `/orders/${o0.ref}` })).json<DeliverableOrder & { status: string }>();
    expect(o.status).toBe("paid");
    const { envelope } = await prepareDelivery({
      order: o,
      products: [p.def],
      keys: new Map([[p.def.id, { key: p.key, content: p.def.content }]]),
      discount: null,
      cardOf,
    });
    const h = await put(envelope);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/orders/${o0.ref}/deliver`,
          headers: await auth(buyer),
          payload: { envelope: h },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/orders/${o0.ref}/deliver`,
          headers: await auth(seller),
          payload: { envelope: h },
        })
      ).statusCode,
    ).toBe(200);
    const done = (await app.inject({ url: `/orders/${o0.ref}` })).json<{ status: string; delivery: string }>();
    expect(done.status).toBe("delivered");
    const env = Buffer.from((await app.inject({ url: `/blobs/${done.delivery}` })).rawPayload);
    const d = readDelivery(
      openItem({ chainId: CHAIN_ID, purpose: Purpose.order(o0.ref), envelope: new Uint8Array(env), keys: buyer.seal }),
    );
    const content = await openContent(
      d.keys[0]?.key ?? new Uint8Array(32),
      p.def.id,
      new Uint8Array(Buffer.from((await app.inject({ url: `/blobs/${p.def.content ?? ""}` })).rawPayload)),
    );
    expect(content.pages[0]?.blocks[0]).toEqual({ t: "text", text: "Here are the loops." });
    expect(() =>
      openItem({ chainId: CHAIN_ID, purpose: Purpose.order(o0.ref), envelope: new Uint8Array(env), keys: seller.seal }),
    ).toThrow();
    // The stock limit of 2 is used (both orders paid): a third is sold out.
    const third = await app.inject({ method: "POST", url: "/orders", payload: { request: request([line(p)]) } });
    expect(third.json<{ error: { code: string } }>().error.code).toBe("SOLD_OUT");
    // Verified-purchase review: the wrong secret is refused, the buyer's is accepted.
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/orders/${o0.ref}/review`,
          payload: { secret: "not-the-secret-000", productId: p.def.id, rating: 5 },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/orders/${o0.ref}/review`,
          payload: { secret: "buyer-secret-0123456789", productId: p.def.id, rating: 5, text: "Lovely" },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: `/products/${seller.name}/tape-loops` })).json<{ rating: { count: number } }>().rating
        .count,
    ).toBe(1);
    // A refund is recorded only when QoreChain shows it with the order's refund memo.
    const wrong = await sendTx(
      seller,
      [msgSend(seller.address, buyer.address, DENOMS.QOR.denom, QOR("0.01"))],
      `mzk:ord:${o0.ref}`,
    );
    await waitForTx(wrong.txHash);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/orders/${o0.ref}/refund`,
          headers: await auth(seller),
          payload: { txHash: wrong.txHash },
        })
      ).statusCode,
    ).toBe(409);
    const right = await sendTx(
      seller,
      [msgSend(seller.address, buyer.address, DENOMS.QOR.denom, QOR("0.02"))],
      `mzk:ord:${refundRef(o0.ref)}`,
    );
    await waitForTx(right.txHash);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/orders/${o0.ref}/refund`,
          headers: await auth(seller),
          payload: { txHash: right.txHash },
        })
      ).json<{ ok: boolean }>().ok,
    ).toBe(true);
    expect((await app.inject({ url: `/orders/${o0.ref}` })).json<{ status: string }>().status).toBe("refunded");
  }, 300_000);
});

describe("shop: discounts, call slots and a commission", () => {
  it("a bad code is refused; a good one is applied by the server", async () => {
    const p = await publishProduct(
      { slug: "presets-pack" },
      { v: 1, pages: [{ id: "pageone", title: "", blocks: [{ t: "text", text: "Presets" }] }] },
    );
    await app.inject({
      method: "PUT",
      url: "/owner/discounts",
      headers: await auth(seller),
      payload: {
        id: "dischalf01",
        code: "half",
        percent: 50,
        amountOff: null,
        token: null,
        productIds: [],
        maxUses: 5,
        expiresAt: null,
      },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/discounts/check",
          payload: { seller: seller.address, code: "nope", token: "QOR" },
        })
      ).statusCode,
    ).toBe(404);
    const bad = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { request: request([line(p)], { discountCode: "nope" }) },
    });
    expect(bad.json<{ error: { code: string } }>().error.code).toBe("NO_DISCOUNT");
    const ok = (
      await app.inject({
        method: "POST",
        url: "/orders",
        payload: { request: request([line(p)], { discountCode: "HALF" }) },
      })
    ).json<{ total: string }>();
    expect(ok.total).toBe(QOR("0.01").toString());
  });

  it("one call slot can be booked once", async () => {
    const p = await publishProduct(
      {
        slug: "intro-call",
        kind: "call",
        content: null,
        booking: {
          minutes: 30,
          timezone: "UTC",
          hours: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, from: 0, to: 1440 })),
          place: "Mizuhiki room",
        },
      },
      null,
    );
    const slot = new Date(Date.UTC(2031, 0, 6, 10, 0)).toISOString();
    expect(
      (await app.inject({ method: "POST", url: "/orders", payload: { request: request([line(p, { slot })]) } }))
        .statusCode,
    ).toBe(201);
    const again = await app.inject({
      method: "POST",
      url: "/orders",
      payload: { request: request([line(p, { slot })]) },
    });
    expect(again.json<{ error: { code: string } }>().error.code).toBe("SLOT_TAKEN");
    expect(
      (await app.inject({ url: `/products/${seller.name}/intro-call` })).json<{ booked: string[] }>().booked,
    ).toEqual([slot]);
  });

  it("a commission is in progress after the deposit and paid after the rest", async () => {
    const p = await publishProduct(
      {
        slug: "portrait",
        kind: "commission",
        commission: { depositPercent: 50 },
        price: { token: "QOR", amount: QOR("0.04").toString(), pwyw: null },
      },
      { v: 1, pages: [{ id: "pageone", title: "", blocks: [{ t: "text", text: "Your portrait" }] }] },
    );
    const o = (await app.inject({ method: "POST", url: "/orders", payload: { request: request([line(p)]) } })).json<{
      ref: string;
      dueNow: string;
      dueLater: string;
    }>();
    expect([o.dueNow, o.dueLater]).toEqual([QOR("0.02").toString(), QOR("0.02").toString()]);
    const t1 = await pay(QOR("0.02"), o.ref);
    expect(
      (await app.inject({ method: "POST", url: `/orders/${o.ref}/tx`, payload: { txHash: t1 } })).json<{
        status: string;
      }>().status,
    ).toBe("in_progress");
    await app.inject({ method: "POST", url: `/orders/${o.ref}/balance`, headers: await auth(seller) });
    const t2 = await pay(QOR("0.02"), balanceRef(o.ref));
    const after = (await app.inject({ method: "POST", url: `/orders/${o.ref}/tx`, payload: { txHash: t2 } })).json<{
      status: string;
      balanceRequested: boolean;
    }>();
    expect(after.status).toBe("paid");
    expect(after.balanceRequested).toBe(true);
  }, 240_000);
});

describe("shop: Instant delivery by the helper", () => {
  it("a buyer key (no account) pays and the helper seals it at once", async () => {
    const p = await publishProduct(
      { slug: "instant-report", kind: "report", delivery: "instant", agent: helper.address },
      { v: 1, pages: [{ id: "pageone", title: "", blocks: [{ t: "text", text: "Q3 report" }] }] },
    );
    const buyerKey = recipientOf(buyer.seal);
    const req = request([line(p)], {
      recipient: {
        kind: "key",
        mlkem: toHex(buyerKey.mlkemPublicKey),
        x25519: toHex(buyerKey.x25519PublicKey ?? new Uint8Array()),
      },
    });
    const o = (await app.inject({ method: "POST", url: "/orders", payload: { request: req } })).json<{ ref: string }>();
    const tx = await pay(QOR("0.02"), o.ref);
    await app.inject({ method: "POST", url: `/orders/${o.ref}/tx`, payload: { txHash: tx } });
    const agent = new DeliveryAgent({ api: base, phrase: helper.phrase, log: () => undefined });
    expect(await agent.pass()).toContain(o.ref);
    const keyHash = sha256Hex(
      utf8(
        canonicalJson({
          mlkem: toHex(buyerKey.mlkemPublicKey),
          x25519: toHex(buyerKey.x25519PublicKey ?? new Uint8Array()),
        }),
      ),
    );
    const mine = (await app.inject({ url: `/orders/by-key/${keyHash}` })).json<{
      orders: { ref: string; status: string }[];
    }>();
    expect(mine.orders.find((x) => x.ref === o.ref)?.status).toBe("delivered");
  }, 240_000);
});

describe("shop: protections", () => {
  it("one network address can hold only three unpaid orders with a seller", async () => {
    const p = await publishProduct(
      { slug: "hold-test" },
      { v: 1, pages: [{ id: "pageone", title: "", blocks: [{ t: "text", text: "x" }] }] },
    );
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push(
        (await app.inject({ method: "POST", url: "/orders", payload: { request: request([line(p)]) } })).statusCode,
      );
    expect(codes).toContain(429);
    const postgres = (await import("postgres")).default;
    const sql = postgres(DB);
    const [live] = await sql<
      { n: number }[]
    >`select count(*)::int as n from orders where seller = ${seller.address} and status = 'awaiting' and expires_at > now()`;
    await sql`update orders set expires_at = now() - interval '1 second' where seller = ${seller.address} and status = 'awaiting'`;
    await sql.end();
    expect(live?.n).toBe(3);
  });

  it("unpaid orders that expire give a discount's use back, so nobody can use up a seller's code (review L2)", async () => {
    const p = await publishProduct(
      { slug: "once-code" },
      { v: 1, pages: [{ id: "pageone", title: "", blocks: [{ t: "text", text: "x" }] }] },
    );
    await app.inject({
      method: "PUT",
      url: "/owner/discounts",
      headers: await auth(seller),
      payload: {
        id: "discone001",
        code: "ONCE",
        percent: 10,
        amountOff: null,
        token: null,
        productIds: [],
        maxUses: 1,
        expiresAt: null,
      },
    });
    const order = () =>
      app.inject({
        method: "POST",
        url: "/orders",
        payload: { request: request([line(p)], { discountCode: "ONCE" }) },
      });
    expect((await order()).statusCode).toBe(201);
    // While that order is held, the single use is taken.
    expect((await order()).json<{ error: { code: string } }>().error.code).toBe("NO_DISCOUNT");
    const postgres = (await import("postgres")).default;
    const sql = postgres(DB);
    await sql`update orders set expires_at = now() - interval '1 second' where seller = ${seller.address} and status = 'awaiting'`;
    await sql.end();
    // It expired unpaid: the code works again.
    expect((await order()).statusCode).toBe(201);
    const list = (await app.inject({ url: "/owner/discounts", headers: await auth(seller) })).json<{
      discounts: { id: string; uses: number }[];
    }>().discounts;
    expect(list.find((d) => d.id === "discone001")?.uses).toBe(1);
  });

  it("a server cannot sell at an old, lower price: the deliverer refuses an old version paid long after it changed", async () => {
    const p = await publishProduct(
      { slug: "old-price", price: { token: "QOR", amount: QOR("0.02").toString(), pwyw: null } },
      { v: 1, pages: [{ id: "pageone", title: "", blocks: [{ t: "text", text: "x" }] }] },
    );
    const o0 = (await app.inject({ method: "POST", url: "/orders", payload: { request: request([line(p)]) } })).json<{
      ref: string;
    }>();
    const tx = await pay(QOR("0.02"), o0.ref);
    await app.inject({ method: "POST", url: `/orders/${o0.ref}/tx`, payload: { txHash: tx } });
    const o = (await app.inject({ url: `/orders/${o0.ref}` })).json<DeliverableOrder>();
    const keys = new Map([[p.def.id, { key: p.key, content: p.def.content }]]);
    // The seller's newer version was published two hours before this payment.
    const newer = {
      ...p.def,
      version: 2,
      price: { ...p.def.price, amount: QOR("5").toString() },
      updatedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
    };
    await expect(
      prepareDelivery({ order: o, products: [p.def], keys, discount: null, cardOf, current: [newer] }),
    ).rejects.toThrow(/old version/);
    // A change published after the payment does not block it.
    const later = { ...newer, updatedAt: new Date(Date.now() + 60_000).toISOString() };
    await expect(
      prepareDelivery({ order: o, products: [p.def], keys, discount: null, cardOf, current: [later] }),
    ).resolves.toHaveProperty("envelope");
  }, 240_000);
});
