import { describe, expect, it } from "vitest";
import { ProductDefSchema, callSlots, type ProductDef } from "@mizuhiki/core";
import {
  addToCart,
  afterPaySteps,
  changedLines,
  fingerprint,
  fromPrice,
  holdLeft,
  liveTotal,
  minAmount,
  orderLines,
  paragraphs,
  parseCart,
  parseInline,
  removeLine,
  ribbonLabel,
  safeHref,
  slotsByDay,
  startOfWeek,
  suggestedAmount,
  unitPrice,
  type Cart,
  type CartLine,
} from "../../src/shop/buyer/model";

const OWNER = "qor1" + "q".repeat(38);
function product(over: Partial<ProductDef> = {}): ProductDef {
  return ProductDefSchema.parse({
    v: 1,
    id: "prAAAAAAAA",
    owner: OWNER,
    name: "kinari",
    slug: "brush-pack",
    kind: "file",
    title: "Brush pack",
    price: { token: "fUSD", amount: "5000000", pwyw: null },
    version: 3,
    updatedAt: "2026-11-19T00:00:00.000Z",
    ...over,
  });
}
const line = (over: Partial<CartLine> = {}): CartLine => ({
  productId: "prAAAAAAAA",
  slug: "brush-pack",
  title: "Brush pack",
  productVersion: 3,
  versionId: null,
  quantity: 1,
  chosen: null,
  slot: null,
  ...over,
});

describe("description renderer", () => {
  it("parses bold, italic and https links", () => {
    expect(parseInline("a **b** *c* [d](https://x.example/p)")).toEqual([
      { t: "text", v: "a " },
      { t: "b", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "i", c: [{ t: "text", v: "c" }] },
      { t: "text", v: " " },
      { t: "a", href: "https://x.example/p", c: [{ t: "text", v: "d" }] },
    ]);
  });
  it("keeps non-https links and HTML as plain text", () => {
    const out = parseInline('[x](javascript:alert(1)) <img src=x onerror="y">');
    expect(out).toEqual([{ t: "text", v: '[x](javascript:alert(1)) <img src=x onerror="y">' }]);
    expect(parseInline("[x](http://plain.example)")).toEqual([{ t: "text", v: "[x](http://plain.example)" }]);
    expect(safeHref("ftp://files.example/a")).toBeNull();
    expect(safeHref("https://ok.example/a")).toBe("https://ok.example/a");
  });
  it("nests bold inside a link label", () => {
    expect(parseInline("[**big**](https://a.example)")).toEqual([
      { t: "a", href: "https://a.example/", c: [{ t: "b", c: [{ t: "text", v: "big" }] }] },
    ]);
  });
  it("splits paragraphs on blank lines and keeps line breaks", () => {
    expect(paragraphs("one\ntwo\n\n\nthree\r\n\r\n   \n")).toEqual([["one", "two"], ["three"]]);
  });
});

describe("prices", () => {
  it("shows the cheapest price and a plus when it can rise", () => {
    expect(ribbonLabel(product())).toBe("5 fUSD");
    expect(ribbonLabel(product({ price: { token: "fUSD", amount: "0", pwyw: null } }))).toBe("Free");
    const v = product({
      versions: [
        { id: "vAAAAAAA", name: "Lite", description: "", extra: "0", max: null },
        { id: "vBBBBBBB", name: "Pro", description: "", extra: "2500000", max: 3 },
      ],
    });
    expect(ribbonLabel(v)).toBe("5 fUSD+");
    expect(fromPrice(v)).toBe(5_000_000n);
    expect(unitPrice(v, "vBBBBBBB", null)).toBe(7_500_000n);
  });
  it("enforces the pay-what-you-want minimum per version", () => {
    const p = product({
      price: { token: "QOR", amount: "1000000", pwyw: { min: "1000000", suggested: "3000000" } },
      versions: [{ id: "vAAAAAAA", name: "Signed", description: "", extra: "500000", max: null }],
    });
    expect(minAmount(p, "vAAAAAAA")).toBe(1_500_000n);
    expect(suggestedAmount(p, "vAAAAAAA")).toBe(3_500_000n);
    expect(unitPrice(p, "vAAAAAAA", 1_400_000n)).toBeNull();
    expect(unitPrice(p, "vAAAAAAA", 2_000_000n)).toBe(2_000_000n);
    expect(ribbonLabel(p)).toBe("1.5 QOR+");
  });
  it("groups fingerprints", () => {
    expect(fingerprint("0123456789abcdef0123456789", 12)).toBe("0123 4567 89ab");
  });
});

describe("cart", () => {
  const base = { name: "kinari", seller: OWNER, token: "fUSD" as const };
  it("adds, updates the same item, and refuses another token or seller", () => {
    const a = addToCart(null, base, line());
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    const b = addToCart(a.cart, base, line({ quantity: 2 }));
    expect(b.ok && b.cart.lines).toEqual([line({ quantity: 2 })]);
    expect(addToCart(a.cart, { ...base, token: "QOR" }, line({ productId: "prBBBBBBBB" }))).toEqual({
      ok: false,
      reason: "token",
    });
    expect(addToCart(a.cart, { ...base, seller: "qor1" + "p".repeat(38) }, line())).toEqual({
      ok: false,
      reason: "seller",
    });
  });
  it("keeps one line per call slot and replaces a configured line", () => {
    const one = addToCart(null, base, line({ slot: "2026-11-20T10:00:00.000Z" }));
    if (!one.ok) throw new Error("add");
    const two = addToCart(one.cart, base, line({ slot: "2026-11-20T11:00:00.000Z" }));
    if (!two.ok) throw new Error("add");
    expect(two.cart.lines).toHaveLength(2);
    const re = addToCart(two.cart, base, line({ slot: "2026-11-21T09:00:00.000Z" }), 0);
    expect(re.ok && re.cart.lines.map((l) => l.slot)).toEqual(["2026-11-21T09:00:00.000Z", "2026-11-20T11:00:00.000Z"]);
    expect(removeLine(two.cart, 0)?.lines).toHaveLength(1);
    expect(removeLine({ ...two.cart, lines: [line()] }, 0)).toBeNull();
  });
  it("parses only well-formed carts for the right page", () => {
    const c: Cart = {
      v: 1,
      name: "kinari",
      seller: OWNER,
      token: "fUSD",
      lines: [line(), line({ quantity: 0 }), line({ chosen: "1.5" })],
    };
    expect(parseCart(JSON.stringify(c), "kinari")?.lines).toEqual([line()]);
    expect(parseCart(JSON.stringify(c), "other")).toBeNull();
    expect(parseCart("{not json", "kinari")).toBeNull();
    expect(parseCart(JSON.stringify({ ...c, token: "BTC" }), "kinari")).toBeNull();
  });
  it("prices with the current record and flags lines that changed", () => {
    const d = product({ version: 4 });
    const cart: Cart = { v: 1, name: "kinari", seller: OWNER, token: "fUSD", lines: [line({ quantity: 1 })] };
    const defs = new Map([[d.id, d]]);
    expect(orderLines(cart, defs)[0]?.productVersion).toBe(4);
    expect(changedLines(cart, defs)).toEqual([0]);
    const t = liveTotal(
      { seller: OWNER, token: "fUSD", lines: orderLines(cart, defs), tip: 500_000n, discountCode: null },
      [d],
      { percent: 10, amountOff: null, productIds: [] },
    );
    expect(t.ok && [t.total.subtotal, t.total.discount, t.total.total]).toEqual([5_000_000n, 500_000n, 5_000_000n]);
    const bad = liveTotal(
      {
        seller: OWNER,
        token: "fUSD",
        lines: [{ ...orderLines(cart, defs)[0]!, quantity: 2 }],
        tip: 0n,
        discountCode: null,
      },
      [d],
      null,
    );
    expect(bad).toEqual({ ok: false, problem: "“Brush pack” is sold one at a time." });
  });
});

describe("call week", () => {
  it("groups free slots into the seven local days of the week", () => {
    const now = new Date("2026-11-16T00:00:00Z");
    const start = startOfWeek(new Date("2026-11-18T12:00:00"));
    expect(start.getDay()).toBe(1);
    const booking = { minutes: 60, timezone: "UTC", hours: [{ day: 3, from: 600, to: 780 }], place: "" };
    const slots = callSlots(booking, start, ["2026-11-18T11:00:00.000Z"], now);
    const days = slotsByDay(slots, start);
    expect(days).toHaveLength(7);
    expect(days.reduce((n, d) => n + d.slots.length, 0)).toBe(2);
  });
});

describe("after payment", () => {
  it("moves through submitted, confirmed, preparing, ready", () => {
    expect(afterPaySteps({ status: "awaiting", depositTx: null, delivery: null }, null)).toEqual([
      "running",
      "waiting",
      "waiting",
      "waiting",
    ]);
    expect(afterPaySteps({ status: "awaiting", depositTx: null, delivery: null }, "AB")).toEqual([
      "done",
      "running",
      "waiting",
      "waiting",
    ]);
    expect(afterPaySteps({ status: "paid", depositTx: "AB", delivery: null }, null)).toEqual([
      "done",
      "done",
      "running",
      "waiting",
    ]);
    expect(afterPaySteps({ status: "delivered", depositTx: "AB", delivery: "h" }, null)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ]);
    expect(afterPaySteps({ status: "expired", depositTx: null, delivery: null }, null)[0]).toBe("failed");
  });
  it("says how long the hold lasts", () => {
    const now = Date.parse("2026-11-19T10:00:00Z");
    expect(holdLeft("2026-11-19T10:41:10Z", now)).toBe("42 min");
    expect(holdLeft("2026-11-19T09:00:00Z", now)).toBe("ended");
  });
});
