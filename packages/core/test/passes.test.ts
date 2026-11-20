import { describe, expect, it } from "vitest";
import { deriveSealKeys } from "@qorechain/qoreseal";
import {
  OPEN_END,
  boundaryText,
  newPhrase,
  passKeyIndex,
  passReaders,
  quarterPeriod,
  toHex,
  type Manifest,
} from "../src";

describe("passes", () => {
  it("a quarter is its first day to the next quarter's first day, in UTC", () => {
    expect(quarterPeriod(2026, 3)).toEqual({ from: "2026-07-01T00:00:00.000Z", until: "2026-10-01T00:00:00.000Z" });
    expect(quarterPeriod(2026, 4).until).toBe("2027-01-01T00:00:00.000Z");
  });

  it("says the boundary in plain words", () => {
    const q = quarterPeriod(2026, 3);
    expect(
      boundaryText({ kind: "period", ...q, kinds: ["invoices", "payments"], keyIndex: passKeyIndex(0) }, null),
    ).toBe(
      "Can read: invoices and payment notes, 1 July 2026 to 30 September 2026. Cannot read anything else. Cannot change anything.",
    );
    expect(boundaryText({ kind: "room", roomId: "room123456", label: "Payroll" }, "2027-01-01T00:00:00.000Z")).toMatch(
      /^Can read: the room “Payroll”, including its past messages\. Cannot send.*New items are covered through 31 December 2026\.$/,
    );
  });

  it("a default reader's pass reads from a day on, with no end", () => {
    expect(
      boundaryText(
        {
          kind: "period",
          from: "2026-11-20T00:00:00.000Z",
          until: OPEN_END,
          kinds: ["messages", "payments", "forms"],
          keyIndex: passKeyIndex(4),
        },
        null,
      ),
    ).toBe(
      "Can read: messages and files, payment notes and form answers, from 20 November 2026 on. Cannot read anything else. Cannot change anything.",
    );
  });

  it("each pass gets its own key index, and different indexes give different keys", () => {
    expect(passKeyIndex(0)).toBe(2_000_000);
    expect(() => passKeyIndex(-1)).toThrow();
    const phrase = newPhrase();
    const a = deriveSealKeys({ mnemonic: phrase, index: passKeyIndex(0) });
    const b = deriveSealKeys({ mnemonic: phrase, index: passKeyIndex(1) });
    expect(toHex(a.mlkemPublicKey)).not.toBe(toHex(b.mlkemPublicKey));
  });

  it("senders seal to a pass key only inside its window and for its kinds", () => {
    const k = deriveSealKeys({ mnemonic: newPhrase(), index: passKeyIndex(3) });
    const q = quarterPeriod(2026, 4);
    const m: Pick<Manifest, "periodKeys"> = {
      periodKeys: [
        {
          label: "Q4 accountant",
          index: passKeyIndex(3),
          mlkem: toHex(k.mlkemPublicKey),
          x25519: toHex(k.x25519PublicKey),
          passId: "pass_one",
          ...q,
          kinds: ["messages", "invoices"],
        },
      ],
    };
    expect(passReaders(m, "messages", new Date("2026-11-19T12:00:00Z"))).toHaveLength(1);
    expect(passReaders(m, "payments", new Date("2026-11-19T12:00:00Z"))).toHaveLength(0);
    expect(passReaders(m, "messages", new Date("2027-01-01T00:00:00Z"))).toHaveLength(0);
    expect(passReaders(m, "messages", new Date("2026-09-30T23:59:59Z"))).toHaveLength(0);
    expect(
      passReaders(
        { periodKeys: [{ label: "old", index: 1_000_100, mlkem: "ab", x25519: "0".repeat(64) }] },
        "messages",
      ),
    ).toHaveLength(0);
  });
});
