import { describe, expect, it } from "vitest";
import { durationText, planHash, planProblems, planSentences, warnLeadSeconds, type CapsulePlan } from "../src";

const A = "qor1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq".replace(/q{38}$/, "a".repeat(38));
const G1 = `qor1${"c".repeat(38)}`;
const G2 = `qor1${"d".repeat(38)}`;
const R1 = `qor1${"e".repeat(38)}`;
const H = (c: string) => c.repeat(64);
const base: CapsulePlan = {
  v: 1,
  id: H("1"),
  owner: A,
  label: "For my family",
  mode: "after-wait",
  releaseAt: 0,
  waitSeconds: 14 * 86400,
  quietSeconds: 0,
  accessSeconds: 90 * 86400,
  guardians: [G1, G2],
  threshold: 2,
  recipients: [{ address: R1, content: H("a"), files: 1 }],
  pieces: [
    { guardian: G1, recipient: R1, envelope: H("b") },
    { guardian: G2, recipient: R1, envelope: H("c") },
  ],
  deleteAfter: false,
  version: 1,
  at: "2026-11-19T00:00:00.000Z",
};

describe("capsule plans", () => {
  it("accepts a complete plan and names what is wrong with a broken one", () => {
    expect(planProblems(base)).toEqual([]);
    expect(planProblems({ ...base, threshold: 3 })).toContain("More guardians are needed than there are.");
    expect(planProblems({ ...base, pieces: base.pieces.slice(0, 1) }).join(" ")).toMatch(/exactly one piece/);
    expect(
      planProblems({
        ...base,
        guardians: [G1, A],
        pieces: [
          { guardian: G1, recipient: R1, envelope: H("b") },
          { guardian: A, recipient: R1, envelope: H("c") },
        ],
      }),
    ).toContain("You cannot be your own guardian.");
    expect(planProblems({ ...base, waitSeconds: 60 })).toContain("The wait must be between one hour and a year.");
    expect(planProblems({ ...base, mode: "at-time", waitSeconds: 0 })).toContain("Choose when it opens.");
  });

  it("the hash on chain changes with any part of the plan, and not with key order", () => {
    const h = planHash(base);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(planHash({ ...base, label: "Other" })).not.toBe(h);
    expect(planHash({ ...base, deleteAfter: true })).not.toBe(h);
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as CapsulePlan;
    expect(planHash(reordered)).toBe(h);
  });

  it("says the plan in plain sentences, and warns earlier for longer quiet periods", () => {
    const quiet = planSentences({
      ...base,
      mode: "if-quiet",
      quietSeconds: Math.round(12 * 30.4375 * 86400),
      guardians: ["@kenji", "@mia"],
      recipients: ["@hana"],
    });
    expect(quiet[0]).toBe("If you don't check in for 12 months, @hana will be able to open what you chose for them.");
    expect(quiet[1]).toBe("@kenji and @mia each hold a key piece; any 2 of them hand it over at that time.");
    expect(quiet[3]).toMatch(/from 90 days before/);
    const wait = planSentences({
      ...base,
      guardians: ["@kenji"],
      recipients: ["@hana", "@sora"],
      threshold: 1,
      deleteAfter: true,
    });
    expect(wait[0]).toBe(
      "If a guardian asks for it, @hana and @sora will be able to open what you chose for them 14 days later, unless you say no first.",
    );
    expect(wait[2]).toBe("They can collect it for 90 days after it opens. Then the sealed copies are deleted.");
    expect(warnLeadSeconds(Math.round(3 * 30.4375 * 86400))).toBe(30 * 86400);
    expect(durationText(365 * 86400)).toBe("1 year");
    expect(durationText(3600)).toBe("1 hour");
  });
});
