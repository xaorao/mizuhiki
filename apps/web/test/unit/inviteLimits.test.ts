import { describe, expect, it } from "vitest";
import { toBase64Url } from "@mizuhiki/core";
import {
  customExpiryProblem,
  expiryLabel,
  expiryOf,
  fmtWhen,
  fromLocalInput,
  isInviteId,
  keyFromFragment,
  linkState,
  parseUseLimit,
  toLocalInput,
  usesHelp,
  usesLabel,
  usesOf,
} from "../../src/rooms/invite/limits";

const now = new Date(2026, 10, 19, 12, 0);
const row = { revoked: false, expiresAt: null as string | null, maxUses: null as number | null, uses: 0 };

describe("time slider", () => {
  it("maps each stop to an expiry from now", () => {
    expect(expiryOf({ kind: "stop", index: 0 }, now)?.getTime()).toBe(now.getTime() + 3_600_000);
    expect(expiryOf({ kind: "stop", index: 1 }, now)?.getTime()).toBe(now.getTime() + 86_400_000);
    expect(expiryOf({ kind: "stop", index: 2 }, now)?.getTime()).toBe(now.getTime() + 7 * 86_400_000);
    expect(expiryOf({ kind: "stop", index: 3 }, now)).toBeNull();
  });
  it("uses a custom date as given and refuses unknown stops", () => {
    const at = new Date(2026, 11, 1, 9, 30);
    expect(expiryOf({ kind: "custom", at }, now)).toBe(at);
    expect(() => expiryOf({ kind: "stop", index: 4 }, now)).toThrow(RangeError);
  });
  it("needs a custom expiry at least five minutes ahead", () => {
    expect(customExpiryProblem(null, now)).toMatch(/Pick a date/);
    expect(customExpiryProblem(new Date(Number.NaN), now)).toMatch(/Pick a date/);
    expect(customExpiryProblem(new Date(now.getTime() - 1), now)).toMatch(/five minutes/);
    expect(customExpiryProblem(new Date(now.getTime() + 4 * 60_000), now)).toMatch(/five minutes/);
    expect(customExpiryProblem(new Date(now.getTime() + 5 * 60_000), now)).toBeNull();
  });
});

describe("use slider", () => {
  it("maps stops and custom values", () => {
    expect([0, 1, 2, 3].map((index) => usesOf({ kind: "stop", index }))).toEqual([1, 10, 100, null]);
    expect(usesOf({ kind: "custom", uses: 42 })).toBe(42);
  });
  it("parses a typed limit within the server's bounds", () => {
    expect(parseUseLimit("25")).toEqual({ uses: 25 });
    expect(parseUseLimit(" 1,000 ")).toEqual({ uses: 1000 });
    expect(parseUseLimit("100000")).toEqual({ uses: 100_000 });
    expect(parseUseLimit("100001")).toHaveProperty("problem");
    expect(parseUseLimit("0")).toHaveProperty("problem");
    expect(parseUseLimit("2.5")).toHaveProperty("problem");
    expect(parseUseLimit("-3")).toHaveProperty("problem");
    expect(parseUseLimit("")).toHaveProperty("problem");
  });
  it("says what the limit means", () => {
    expect(usesHelp(null)).toMatch(/any number/);
    expect(usesHelp(1)).toBe("Works for one person, then stops.");
    expect(usesHelp(1000)).toBe("Works for 1,000 people, then stops.");
  });
});

describe("link state and labels", () => {
  it("follows the server's order: revoked, expired, used up", () => {
    expect(linkState(row, now)).toBe("active");
    expect(linkState({ ...row, revoked: true, expiresAt: "2020-01-01T00:00:00Z", maxUses: 1, uses: 1 }, now)).toBe(
      "revoked",
    );
    expect(linkState({ ...row, expiresAt: "2020-01-01T00:00:00Z", maxUses: 1, uses: 1 }, now)).toBe("expired");
    expect(linkState({ ...row, maxUses: 3, uses: 3 }, now)).toBe("used-up");
    expect(
      linkState({ ...row, maxUses: 3, uses: 2, expiresAt: new Date(now.getTime() + 1000).toISOString() }, now),
    ).toBe("active");
  });
  it("formats dates like Telegram, adding the year only when it differs", () => {
    expect(fmtWhen(new Date(2026, 10, 24, 21, 34), now)).toBe("Nov 24 at 21:34");
    expect(fmtWhen(new Date(2027, 0, 3, 7, 5), now)).toBe("Jan 3, 2027 at 07:05");
    expect(expiryLabel(null, now)).toBe("Never expires");
    expect(expiryLabel(new Date(2026, 10, 24, 21, 34).toISOString(), now)).toBe("Expires Nov 24 at 21:34");
    expect(expiryLabel(new Date(2026, 10, 18, 8, 0).toISOString(), now)).toBe("Expired Nov 18 at 08:00");
  });
  it("counts uses", () => {
    expect(usesLabel(3, 10)).toBe("3 of 10 used");
    expect(usesLabel(0, null)).toBe("Not used yet");
    expect(usesLabel(1, null)).toBe("1 use");
    expect(usesLabel(7, null)).toBe("7 uses");
  });
});

describe("link key and id", () => {
  const seed = toBase64Url(new Uint8Array(32).fill(7));
  it("reads a 32-byte key from the fragment", () => {
    expect(seed).toHaveLength(43);
    expect(keyFromFragment(`#k=${seed}`)).toBe(seed);
    expect(keyFromFragment(`#x=1&k=${seed}`)).toBe(seed);
    expect(keyFromFragment(`k=${seed}`)).toBe(seed);
  });
  it("refuses missing, cut or padded keys", () => {
    expect(keyFromFragment("")).toBeNull();
    expect(keyFromFragment("#k=")).toBeNull();
    expect(keyFromFragment(`#k=${seed.slice(0, 40)}`)).toBeNull();
    expect(keyFromFragment(`#k=${seed}A`)).toBeNull();
    expect(keyFromFragment(`#k=${seed}=`)).toBeNull();
    // 43 characters whose last one carries bits a 32-byte key cannot have.
    expect(keyFromFragment(`#k=${seed.slice(0, 42)}B`)).toBeNull();
  });
  it("accepts only ids the server accepts", () => {
    expect(isInviteId("a1b2c3d4e5f6a7b8c9d0")).toBe(true);
    expect(isInviteId("short")).toBe(false);
    expect(isInviteId("ABCDEF123456")).toBe(false);
    expect(isInviteId("x".repeat(33))).toBe(false);
  });
  it("round-trips datetime-local values in the device time zone", () => {
    const d = new Date(2026, 10, 24, 21, 34);
    expect(toLocalInput(d)).toBe("2026-11-24T21:34");
    expect(fromLocalInput("2026-11-24T21:34")?.getTime()).toBe(d.getTime());
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("nonsense")).toBeNull();
  });
});
