import { describe, expect, it } from "vitest";
import { pieceState, strangerRequests, type Mine } from "../../src/recovery/model";

const contact = (c: string, status: string, piece: string | null, pieceVersion: number | null) =>
  ({
    contact: c,
    status,
    piece,
    pieceVersion,
    invite: {},
    accept: null,
    createdAt: "",
    updatedAt: "",
  }) as unknown as Mine["contacts"][number];
const mine = (
  version: number,
  contacts: Mine["contacts"],
  requests: Partial<Mine["requests"][number]>[] = [],
): Mine => ({
  settings: { threshold: 2, version, sheetSavedAt: null, testedAt: null, offlineKey: null, offlineSheetSavedAt: null },
  contacts,
  requests: requests as Mine["requests"],
});

describe("spare key states", () => {
  it("asks for a new set of pieces when confirmed contacts and current pieces differ", () => {
    expect(
      pieceState(mine(0, [contact("a", "confirmed", null, null), contact("b", "confirmed", null, null)])).needsSeal,
    ).toBe(true);
    expect(
      pieceState(mine(1, [contact("a", "confirmed", "h1", 1), contact("b", "confirmed", "h2", 1)])).needsSeal,
    ).toBe(false);
    // a third contact confirmed later
    expect(
      pieceState(
        mine(1, [
          contact("a", "confirmed", "h1", 1),
          contact("b", "confirmed", "h2", 1),
          contact("c", "confirmed", null, null),
        ]),
      ).needsSeal,
    ).toBe(true);
    // one confirmed contact is not enough to seal
    expect(
      pieceState(mine(0, [contact("a", "confirmed", null, null), contact("b", "invited", null, null)])).needsSeal,
    ).toBe(false);
    expect(
      pieceState(mine(1, [contact("a", "confirmed", "h1", 1), contact("b", "confirmed", "h2", 1)])).holders,
    ).toHaveLength(2);
  });

  it("raises the alarm only for live recoveries the owner did not start as a test", () => {
    const m = mine(
      1,
      [],
      [
        { id: "1", test: false, status: "open" },
        { id: "2", test: true, status: "open" },
        { id: "3", test: false, status: "cancelled" },
        { id: "4", test: false, status: "ready" },
        { id: "5", test: false, status: "done" },
      ],
    );
    expect(strangerRequests(m).map((r) => r.id)).toEqual(["1", "4"]);
  });
});
