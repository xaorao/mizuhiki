import { describe, expect, it } from "vitest";
import { deriveSealKeys } from "@qorechain/qoreseal";
import {
  newPhrase,
  passKeyIndex,
  passReaders,
  quarterPeriod,
  toHex,
  type PassInvite,
  type Signed,
} from "@mizuhiki/core";
import {
  chipOf,
  covers,
  expiryOf,
  periodKeysOf,
  periodLabel,
  personProblem,
  recentQuarters,
  scopeLine,
} from "../../src/passes/model";
import type { PassView } from "../../src/passes/engine";

const q3 = quarterPeriod(2026, 3);
function view(over: Partial<PassView> & { scope: PassInvite["scope"] }): PassView {
  const { scope, ...rest } = over;
  return {
    id: "pass_abcdefghijkl",
    owner: "qor1owner",
    holder: "qor1holder",
    invite: { body: { scope } } as unknown as Signed<PassInvite>,
    accept: null,
    status: "active",
    keyEnvelope: null,
    expiresAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    acceptedAt: null,
    confirmedAt: null,
    revokedAt: null,
    ...rest,
  };
}

describe("passes screen words", () => {
  it("names a quarter as a quarter and anything else by its dates", () => {
    expect(periodLabel(q3.from, q3.until)).toBe("Q3 2026");
    expect(periodLabel("2026-07-01T00:00:00.000Z", "2026-07-16T00:00:00.000Z")).toBe("1 Jul 2026 – 15 Jul 2026");
    expect(scopeLine({ kind: "period", ...q3, kinds: ["invoices", "payments"], keyIndex: passKeyIndex(0) })).toBe(
      "Invoices and payment notes · Q3 2026",
    );
    expect(scopeLine({ kind: "room", roomId: "r1234567", label: "Payroll" })).toBe("Room · Payroll");
  });

  it("offers this quarter and the seven before it", () => {
    const qs = recentQuarters(new Date("2026-02-10T00:00:00Z"));
    expect(qs.map((q) => q.label).slice(0, 3)).toEqual(["Q1 2026", "Q4 2025", "Q3 2025"]);
    expect(qs).toHaveLength(8);
  });

  it("works out when a pass stops covering new items", () => {
    const now = Date.parse("2026-08-01T00:00:00Z");
    expect(expiryOf("period", { kind: "period", until: q3.until }, now)).toBe(q3.until);
    // a past period has nothing new: until revoked
    expect(expiryOf("period", { kind: "period", until: quarterPeriod(2026, 1).until }, now)).toBeNull();
    expect(expiryOf("30d", { kind: "room" }, now)).toBe("2026-08-31T00:00:00.000Z");
    expect(expiryOf("revoke", { kind: "room" }, now)).toBeNull();
  });

  it("checks who before looking them up", () => {
    expect(personProblem("")).toMatch(/Say who/);
    expect(personProblem("@mila.cpa")).toBeNull();
    expect(personProblem("qor1abc")).toMatch(/not complete/);
    expect(personProblem("hi there")).toMatch(/@name/);
  });

  it("shows each side its own status words", () => {
    expect(chipOf({ status: "accepted" }, "owner").label).toBe("Needs confirmation");
    expect(chipOf({ status: "accepted" }, "holder").label).toBe("Waiting for the owner");
    expect(chipOf({ status: "revoked" }, "owner").status).toBe("danger");
  });
});

describe("pass keys on the page", () => {
  it("lists only active, unexpired period passes, ending at the earlier of the period and the expiry", () => {
    const phrase = newPhrase();
    const account = { keys: { phrase } };
    const now = Date.parse("2026-08-01T00:00:00Z");
    const scope = { kind: "period" as const, ...q3, kinds: ["messages" as const], keyIndex: passKeyIndex(2) };
    const keys = periodKeysOf(
      account,
      [
        view({ scope, expiresAt: "2026-09-01T00:00:00.000Z" }),
        view({ id: "pass_revokedxxxxx", scope: { ...scope, keyIndex: passKeyIndex(3) }, status: "revoked" }),
        view({
          id: "pass_expiredxxxxx",
          scope: { ...scope, keyIndex: passKeyIndex(4) },
          expiresAt: "2026-07-15T00:00:00.000Z",
        }),
        view({ id: "pass_roomxxxxxxxx", scope: { kind: "room", roomId: "r1234567", label: "x" } }),
      ],
      now,
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]?.until).toBe("2026-09-01T00:00:00.000Z");
    expect(keys[0]?.mlkem).toBe(toHex(deriveSealKeys({ mnemonic: phrase, index: passKeyIndex(2) }).mlkemPublicKey));
    // and senders then seal to it only for its kinds and window
    expect(passReaders({ periodKeys: keys }, "messages", new Date("2026-08-20T00:00:00Z"))).toHaveLength(1);
    expect(passReaders({ periodKeys: keys }, "messages", new Date("2026-09-02T00:00:00Z"))).toHaveLength(0);
  });

  it("Add a reader offers only passes that cover the item's kind", () => {
    const period = view({ scope: { kind: "period", ...q3, kinds: ["payments"], keyIndex: passKeyIndex(0) } });
    expect(covers(period, { kind: "paynote", ref: null })).toBe(true);
    expect(covers(period, { kind: "message", ref: null })).toBe(false);
    const form = view({ scope: { kind: "form", formId: "form1234", label: "Intake" } });
    expect(covers(form, { kind: "form", ref: "form:form1234" })).toBe(true);
    expect(covers(form, { kind: "form", ref: "form:other123" })).toBe(false);
    expect(covers({ ...period, status: "revoked" }, { kind: "paynote", ref: null })).toBe(false);
  });
});
