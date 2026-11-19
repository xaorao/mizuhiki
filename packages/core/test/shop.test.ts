import { describe, expect, it } from "vitest";
import {
  ProductDefSchema,
  callSlots,
  formatAmount,
  newProductKey,
  openContent,
  orderRef,
  orderTotal,
  parseAmount,
  readDelivery,
  deliveryPayload,
  sealContent,
  zonedToUtc,
  type OrderRequest,
  type ProductDef,
} from "../src";

const SELLER = "qor1" + "a".repeat(38);
const fusd = (n: string) => parseAmount(n, "fUSD") ?? 0n;

const product = (extra: Partial<ProductDef> = {}): ProductDef =>
  ProductDefSchema.parse({
    v: 1,
    id: "prod_one",
    owner: SELLER,
    name: "kinari",
    slug: "presets",
    kind: "file",
    title: "Film presets",
    price: { token: "fUSD", amount: fusd("10").toString() },
    version: 3,
    updatedAt: "2026-11-19T10:00:00.000Z",
    ...extra,
  });

const request = (extra: Partial<OrderRequest> = {}): OrderRequest => ({
  v: 1,
  seller: SELLER,
  token: "fUSD",
  lines: [{ productId: "prod_one", productVersion: 3, versionId: null, quantity: 1, chosen: null, slot: null }],
  recipient: { kind: "account", address: "qor1" + "c".repeat(38) },
  gift: false,
  tip: "0",
  discountCode: null,
  reviewHash: "f".repeat(64),
  nonce: "abcdefghijklmnop",
  ...extra,
});

describe("shop: tokens and amounts", () => {
  it("parses and formats amounts without floating point", () => {
    expect(parseAmount("12.5", "fUSD")).toBe(12_500_000n);
    expect(parseAmount("0.0000001", "fUSD")).toBeNull();
    expect(parseAmount("abc", "QOR")).toBeNull();
    expect(formatAmount(12_500_000n, "fUSD")).toBe("12.5 fUSD");
    expect(formatAmount("3000000", "QOR")).toBe("3 QOR");
  });
});

describe("shop: order reference", () => {
  it("is stable and changes when the recipient key changes", () => {
    const a = orderRef(request());
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(orderRef(request())).toBe(a);
    expect(orderRef(request({ recipient: { kind: "account", address: "qor1" + "d".repeat(38) } }))).not.toBe(a);
  });
});

describe("shop: the one total", () => {
  it("fixed price, versions, quantity", () => {
    const p = product({
      versions: [{ id: "vers_pro", name: "Pro", description: "", extra: fusd("5").toString(), max: null }],
      limits: { maxSales: null, quantity: true, showSales: false },
    });
    const t = orderTotal(
      request({
        lines: [
          { productId: "prod_one", productVersion: 3, versionId: "vers_pro", quantity: 2, chosen: null, slot: null },
        ],
      }),
      [p],
      null,
    );
    expect(t.total).toBe(fusd("30"));
    expect(t.dueLater).toBe(0n);
  });
  it("refuses a changed product, a missing option, a fixed price with a chosen amount", () => {
    expect(() =>
      orderTotal(
        request({
          lines: [{ productId: "prod_one", productVersion: 2, versionId: null, quantity: 1, chosen: null, slot: null }],
        }),
        [product()],
        null,
      ),
    ).toThrow(/changed/);
    expect(() =>
      orderTotal(
        request(),
        [product({ versions: [{ id: "vers_pro", name: "Pro", description: "", extra: "0", max: null }] })],
        null,
      ),
    ).toThrow(/Pick an option/);
    expect(() =>
      orderTotal(
        request({
          lines: [{ productId: "prod_one", productVersion: 3, versionId: null, quantity: 1, chosen: "1", slot: null }],
        }),
        [product()],
        null,
      ),
    ).toThrow(/fixed price/);
    expect(() =>
      orderTotal(
        request({
          lines: [{ productId: "prod_one", productVersion: 3, versionId: null, quantity: 2, chosen: null, slot: null }],
        }),
        [product()],
        null,
      ),
    ).toThrow(/one at a time/);
  });
  it("pay what you want respects the minimum", () => {
    const p = product({
      price: {
        token: "fUSD",
        amount: fusd("5").toString(),
        pwyw: { min: fusd("5").toString(), suggested: fusd("8").toString() },
      },
    });
    const line = (chosen: string) =>
      request({
        lines: [{ productId: "prod_one", productVersion: 3, versionId: null, quantity: 1, chosen, slot: null }],
      });
    expect(orderTotal(line(fusd("9").toString()), [p], null).total).toBe(fusd("9"));
    expect(() => orderTotal(line(fusd("4").toString()), [p], null)).toThrow(/at least/);
  });
  it("discounts never go below zero and apply only to their products; tips add on", () => {
    const t = orderTotal(request({ tip: fusd("2").toString() }), [product()], {
      percent: 25,
      amountOff: null,
      productIds: [],
    });
    expect(t.discount).toBe(fusd("2.5"));
    expect(t.total).toBe(fusd("9.5"));
    expect(
      orderTotal(request(), [product()], { percent: null, amountOff: fusd("50").toString(), productIds: [] }).total,
    ).toBe(0n);
    expect(
      orderTotal(request(), [product()], { percent: 50, amountOff: null, productIds: ["other_prod"] }).discount,
    ).toBe(0n);
  });
  it("a commission takes its deposit now and the rest later", () => {
    const p = product({
      kind: "commission",
      commission: { depositPercent: 50 },
      price: { token: "fUSD", amount: fusd("100").toString(), pwyw: null },
    });
    const t = orderTotal(request(), [p], null);
    expect(t.dueNow).toBe(fusd("50"));
    expect(t.dueLater).toBe(fusd("50"));
    expect(t.dueNow + t.dueLater).toBe(t.total);
  });
});

describe("shop: content and delivery", () => {
  it("content opens only with its key and its product id", async () => {
    const key = newProductKey();
    const content = {
      v: 1 as const,
      pages: [{ id: "page_one", title: "Start here", blocks: [{ t: "text" as const, text: "Thank you!" }] }],
    };
    const blob = await sealContent(key, "prod_one", content);
    expect(await openContent(key, "prod_one", blob)).toEqual(content);
    await expect(openContent(newProductKey(), "prod_one", blob)).rejects.toThrow(/does not open/);
    await expect(openContent(key, "prod_two", blob)).rejects.toThrow(/does not open/);
    blob[blob.length - 1] = (blob[blob.length - 1] ?? 0) ^ 1;
    await expect(openContent(key, "prod_one", blob)).rejects.toThrow(/does not open/);
  });
  it("the delivery payload round-trips", () => {
    const key = newProductKey();
    const d = readDelivery(
      deliveryPayload("refrefrefrefrefrefrefr", [{ productId: "prod_one", key, content: "a".repeat(64) }]),
    );
    expect(d.keys[0]?.key).toEqual(key);
  });
});

describe("shop: call times", () => {
  it("turns weekly hours in the seller's zone into UTC slots, skipping booked ones", () => {
    // Monday 10:00–11:00 in Kolkata (UTC+5:30), 30-minute calls.
    const booking = { minutes: 30, timezone: "Asia/Kolkata", hours: [{ day: 1, from: 600, to: 660 }], place: "" };
    const weekStart = new Date("2030-01-06T00:00:00Z"); // a Sunday
    const slots = callSlots(booking, weekStart, [], new Date("2029-12-01T00:00:00Z"));
    expect(slots).toEqual(["2030-01-07T04:30:00.000Z", "2030-01-07T05:00:00.000Z"]);
    expect(callSlots(booking, weekStart, ["2030-01-07T04:30:00.000Z"], new Date("2029-12-01T00:00:00Z"))).toEqual([
      "2030-01-07T05:00:00.000Z",
    ]);
  });
  it("handles daylight-saving time", () => {
    // New York: 9:00 is 14:00 UTC in winter and 13:00 UTC in summer.
    expect(zonedToUtc(2030, 1, 15, 9, 0, "America/New_York").toISOString()).toBe("2030-01-15T14:00:00.000Z");
    expect(zonedToUtc(2030, 7, 15, 9, 0, "America/New_York").toISOString()).toBe("2030-07-15T13:00:00.000Z");
  });
});

describe("shop: content links", () => {
  it("only web links are accepted in a content page", async () => {
    const { ContentSchema } = await import("../src");
    const page = (url: string) => ({
      v: 1,
      pages: [{ id: "page_one", title: "", blocks: [{ t: "link", url, label: "x" }] }],
    });
    expect(ContentSchema.safeParse(page("https://example.org/a")).success).toBe(true);
    expect(ContentSchema.safeParse(page("javascript:alert(1)")).success).toBe(false);
    expect(ContentSchema.safeParse(page("data:text/html,<script>1</script>")).success).toBe(false);
  });
});
