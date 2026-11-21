import { describe, expect, it } from "vitest";
import { kindWords, kindsLine } from "../../src/lib/kinds";

describe("kind wording", () => {
  it("says one and many in words", () => {
    expect(kindWords("message", 1)).toBe("1 message");
    expect(kindWords("reply", 2)).toBe("2 replies");
    expect(kindWords("paynote", 3)).toBe("3 payment notes");
  });

  it("names the largest kinds first and folds the rest so the parts add up", () => {
    const line = kindsLine({ message: 455, paynote: 120, invoice: 40, order: 7, reply: 3 });
    expect(line).toBe("455 messages, 120 payment notes, 40 invoices, 10 other");
  });

  it("leaves out empty kinds and says nothing when nothing came in", () => {
    expect(kindsLine({ message: 0, order: 1 })).toBe("1 order");
    expect(kindsLine({})).toBe("");
  });
});
