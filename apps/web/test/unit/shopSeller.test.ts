import { describe, expect, it } from "vitest";
import { ProductDefSchema } from "@mizuhiki/core";
import type { OrderView, ProductDraft } from "../../src/shop/engine";
import {
  allProblems,
  amountInput,
  buyerLabel,
  canAskRest,
  canDeliver,
  canRefund,
  codeProblem,
  contentProblems,
  discountState,
  discountValue,
  fileKind,
  fingerprint,
  formatBytes,
  fromTime,
  hoursProblems,
  move,
  orderLines,
  orderStatus,
  paidSoFar,
  parseRich,
  priceLabel,
  sumByToken,
  toTime,
  uploadLine,
  wrapSelection,
} from "../../src/shop/seller/model";

const SELLER = "qor1h333d02dd0zrxu2s6xfrdezgan8tfaqcykgvsv";
const BUYER = "qor1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v7";

const draft = (): ProductDraft => ({
  v: 1,
  def: ProductDefSchema.parse({
    v: 1,
    id: "pr0123456789",
    owner: SELLER,
    name: "aria",
    slug: "brand-kit",
    kind: "file",
    title: "Brand kit",
    price: { token: "fUSD", amount: "12500000" },
    version: 1,
    updatedAt: "now",
  }),
  content: { v: 1, pages: [{ id: "pg0000001", title: "", blocks: [{ t: "text", text: "" }] }] },
  key: "k",
  savedAt: "now",
});

const order = (o: Partial<OrderView> = {}): OrderView => ({
  ref: "abcdefghijklmnopqrstuv",
  seller: SELLER,
  request: {
    v: 1,
    seller: SELLER,
    token: "fUSD",
    lines: [{ productId: "pr0123456789", productVersion: 1, versionId: null, quantity: 1, chosen: null, slot: null }],
    recipient: { kind: "account", address: BUYER },
    gift: false,
    tip: "0",
    discountCode: null,
    reviewHash: "0".repeat(64),
    nonce: "AAAAAAAAAAAAAAAAAAAAAA",
  },
  records: [],
  token: "fUSD",
  total: "10000000",
  dueNow: "10000000",
  dueLater: "0",
  status: "paid",
  payer: BUYER,
  depositTx: "A".repeat(64),
  balanceTx: null,
  refundTx: null,
  delivery: null,
  deliveredBy: null,
  balanceRequested: false,
  createdAt: "2026-11-19T10:00:00Z",
  paidAt: null,
  deliveredAt: null,
  expiresAt: "2026-11-19T11:00:00Z",
  payTo: SELLER,
  memo: "",
  ...o,
});

describe("description subset", () => {
  it("splits paragraphs and reads bold, italic and links", () => {
    const p = parseRich("Hello **big** and *small*.\n\nSee [the guide](https://example.com/g).");
    expect(p).toHaveLength(2);
    expect(p[0]).toEqual([
      { t: "text", text: "Hello " },
      { t: "b", text: "big" },
      { t: "text", text: " and " },
      { t: "i", text: "small" },
      { t: "text", text: "." },
    ]);
    expect(p[1]?.[1]).toEqual({ t: "a", text: "the guide", href: "https://example.com/g" });
  });
  it("never makes a javascript: link", () => {
    const p = parseRich("[x](javascript:alert(1))");
    expect(p[0]?.every((x) => x.t === "text")).toBe(true);
  });
  it("wraps the selection and selects the inner text", () => {
    expect(wrapSelection("make this bold", 5, 9, "b")).toEqual({ value: "make **this** bold", start: 7, end: 11 });
    const l = wrapSelection("go here", 3, 7, "a");
    expect(l.value).toBe("go [here](https://)");
    expect(l.value.slice(l.start, l.end)).toBe("https://");
  });
});

describe("amounts and files", () => {
  it("labels prices, pay what you want and tip jars", () => {
    const d = draft();
    expect(priceLabel(d.def)).toBe("12.5 fUSD");
    expect(priceLabel({ ...d.def, price: { ...d.def.price, pwyw: { min: "3000000", suggested: "5000000" } } })).toBe(
      "3 fUSD+",
    );
    expect(amountInput("12500000", "fUSD")).toBe("12.5");
    expect(
      sumByToken([
        { amount: "1000000", token: "fUSD" },
        { amount: "2000000", token: "QOR" },
        { amount: "500000", token: "fUSD" },
      ]),
    ).toBe("1.5 fUSD · 2 QOR");
    expect(sumByToken([])).toBe("0 fUSD");
  });
  it("writes Gumroad's upload line", () => {
    expect(formatBytes(899_174)).toBe("878.1 KB");
    expect(fileKind("pack.zip")).toBe("ZIP");
    expect(fileKind("README", "application/pdf")).toBe("PDF");
    expect(uploadLine("pack.zip", "", 300_000, 899_174)).toBe("ZIP · 33% of 878.1 KB");
  });
});

describe("working copy", () => {
  it("fingerprints what buyers see, not bookkeeping", () => {
    const d = draft();
    const same = { ...d, def: { ...d.def, version: 4, updatedAt: "later", content: "b".repeat(64) } };
    expect(fingerprint(same)).toBe(fingerprint(d));
    expect(fingerprint({ ...d, def: { ...d.def, title: "Other" } })).not.toBe(fingerprint(d));
  });
  it("lists every problem before publishing", () => {
    const d = draft();
    const bad = {
      ...d,
      def: { ...d.def, versions: [{ id: "vr00000001", name: " ", description: "", extra: "0", max: null }] },
      content: {
        v: 1 as const,
        pages: [{ id: "pg0000001", title: "", blocks: [{ t: "link" as const, url: "https://", label: "" }] }],
      },
    };
    expect(contentProblems(bad.content)).toEqual(["a link needs a full address, starting with https://"]);
    expect(allProblems([], bad)).toContain("Name every version.");
  });
});

describe("booking hours", () => {
  it("converts times", () => {
    expect(toTime(540)).toBe("09:00");
    expect(fromTime("17:30")).toBe(1050);
    expect(fromTime("25:00")).toBeNull();
  });
  it("catches backwards, short and overlapping ranges", () => {
    expect(hoursProblems([{ day: 1, from: 600, to: 540 }], 30)[0]).toMatch(/Monday: the end time/);
    expect(hoursProblems([{ day: 2, from: 600, to: 615 }], 30)[0]).toMatch(/shorter than one 30-minute call/);
    expect(
      hoursProblems(
        [
          { day: 3, from: 540, to: 720 },
          { day: 3, from: 700, to: 800 },
        ],
        30,
      ),
    ).toContain("Wednesday: two ranges overlap.");
    expect(hoursProblems([{ day: 1, from: 540, to: 1020 }], 30)).toEqual([]);
  });
});

describe("orders", () => {
  it("names every status the seller sees", () => {
    expect(orderStatus(order()).label).toBe("Paid · waiting to be sealed");
    expect(orderStatus(order({ status: "awaiting" })).label).toBe("Awaiting payment");
    expect(orderStatus(order({ status: "in_progress" })).label).toBe("Deposit paid");
    expect(orderStatus(order({ status: "delivered" })).label).toBe("Delivered");
    expect(orderStatus(order({ status: "refunded" })).label).toBe("Refunded");
    expect(orderStatus(order({ status: "expired" })).label).toBe("Expired");
  });
  it("says who bought it, and gifts plainly", () => {
    expect(buyerLabel(order())).toBe("qor1qqqsy…3v7".replace("…3v7", `…${BUYER.slice(-5)}`));
    const gift = order();
    gift.request = { ...gift.request, gift: true };
    expect(buyerLabel(gift)).toMatch(/^Gift to qor1/);
    // With the buyer's QoreChain name known, the seller sees the @name instead of the address.
    expect(buyerLabel(order(), { [order().payer ?? ""]: "leaf.kettle" })).toBe("@leaf.kettle");
  });
  it("offers only the actions that make sense", () => {
    expect(canDeliver(order())).toBe(true);
    expect(canDeliver(order({ delivery: "c".repeat(64), status: "delivered" }))).toBe(false);
    expect(canRefund(order())).toBe(true);
    expect(canRefund(order({ refundTx: "B".repeat(64), status: "refunded" }))).toBe(false);
    expect(canRefund(order({ status: "awaiting", payer: null, depositTx: null }))).toBe(false);
    expect(canAskRest(order({ status: "in_progress", dueLater: "5000000" }))).toBe(true);
    expect(canAskRest(order({ status: "paid", dueLater: "5000000", balanceTx: "C".repeat(64) }))).toBe(false);
  });
  it("counts what QoreChain shows was paid", () => {
    expect(paidSoFar(order({ dueNow: "5000000", dueLater: "5000000" }))).toBe(5_000_000n);
    expect(paidSoFar(order({ dueNow: "5000000", dueLater: "5000000", balanceTx: "C".repeat(64) }))).toBe(10_000_000n);
    expect(paidSoFar(order({ depositTx: null }))).toBe(0n);
  });
  it("reads lines from the records the order was priced with", () => {
    const d = draft();
    const o = order({
      records: [
        {
          kind: "product",
          signer: SELLER,
          body: { ...d.def, id: "pr0123456789", version: 1 },
          signature: {},
        } as unknown as OrderView["records"][number],
      ],
    });
    expect(orderLines(o)[0]?.title).toBe("Brand kit");
    expect(orderLines(order())[0]?.title).toBe("A product that is no longer listed");
  });
});

describe("discounts", () => {
  it("labels value and state", () => {
    expect(discountValue({ percent: 20, amountOff: null, token: null })).toBe("20% off");
    expect(discountValue({ percent: null, amountOff: "5000000", token: "QOR" })).toBe("5 QOR off");
    const now = new Date("2026-11-19T12:00:00Z");
    expect(discountState({ active: true, expiresAt: null, maxUses: null, uses: 0 }, now).label).toBe("Active");
    expect(discountState({ active: false, expiresAt: null, maxUses: null, uses: 0 }, now).label).toBe("Off");
    expect(discountState({ active: true, expiresAt: "2026-11-18T00:00:00Z", maxUses: null, uses: 0 }, now).label).toBe(
      "Expired",
    );
    expect(discountState({ active: true, expiresAt: null, maxUses: 3, uses: 3 }, now).label).toBe("Used up");
  });
  it("checks codes the way the server does", () => {
    expect(codeProblem("", [])).toMatch(/Give the code/);
    expect(codeProblem("a b", [])).toMatch(/3 to 40/);
    expect(codeProblem("spring20", ["SPRING20"])).toMatch(/already have/);
    expect(codeProblem("SPRING20", [])).toBeNull();
  });
  it("moves items", () => {
    expect(move([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(move([1, 2, 3], 0, 5)).toEqual([1, 2, 3]);
  });
});
