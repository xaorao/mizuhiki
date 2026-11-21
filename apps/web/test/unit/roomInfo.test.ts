import { describe, expect, it } from "vitest";
import type { RoomBody } from "@mizuhiki/core";
import { derive, type SharedFile } from "../../src/rooms/derive";
import type { EpochRow, Line, MemberRow } from "../../src/rooms/engine";
import {
  adminCheck,
  autoDeleteChoice,
  autoDeleteText,
  customSeconds,
  filterFiles,
  matchesQuery,
  parsePerson,
  permissionsCheck,
  removeCheck,
  requestOrigin,
  sortMembers,
  splitCustom,
  transferGate,
  verifyState,
} from "../../src/rooms/info/model";

const A = "qor1" + "a".repeat(38);
const B = "qor1" + "c".repeat(38);
const C = "qor1" + "d".repeat(38);
const D = "qor1" + "e".repeat(38);

const row = (address: string, role: MemberRow["role"], extra: Partial<MemberRow> = {}): MemberRow => ({
  roomId: "room1234",
  address,
  role,
  permissions: ["send", "files", "add", "info", "pin"],
  status: "active",
  joinedEpoch: 1,
  firstEpoch: 1,
  lastEpoch: null,
  lastReadSeq: "0",
  muted: false,
  joinedAt: "2026-11-01T10:00:00.000Z",
  ...extra,
});
const owner = row(A, "owner");
const admin = row(B, "admin", { joinedAt: "2026-11-02T10:00:00.000Z" });
const member = row(C, "member", { joinedAt: "2026-11-01T11:00:00.000Z" });

describe("who may do what", () => {
  it("remove: owner removes anyone but themself; admins only plain members", () => {
    expect(removeCheck(owner, admin).allowed).toBe(true);
    expect(removeCheck(owner, member).allowed).toBe(true);
    expect(removeCheck(owner, owner)).toEqual({ allowed: false, reason: "To leave, use Leave room at the bottom." });
    expect(removeCheck(admin, member).allowed).toBe(true);
    expect(removeCheck(admin, owner)).toEqual({ allowed: false, reason: "The owner cannot be removed." });
    expect(removeCheck(admin, row(D, "admin"))).toEqual({
      allowed: false,
      reason: "Only the owner can remove an admin.",
    });
    expect(removeCheck(member, row(D, "member")).allowed).toBe(false);
    expect(removeCheck(owner, row(D, "member", { status: "left" })).allowed).toBe(false);
  });
  it("make or dismiss admin: owner only", () => {
    expect(adminCheck(owner, member).allowed).toBe(true);
    expect(adminCheck(owner, admin).allowed).toBe(true);
    expect(adminCheck(admin, member).allowed).toBe(false);
    expect(adminCheck(owner, owner).allowed).toBe(false);
  });
  it("permissions: admins change plain members only", () => {
    expect(permissionsCheck(admin, member).allowed).toBe(true);
    expect(permissionsCheck(owner, admin)).toEqual({ allowed: false, reason: "Admins can do everything in the room." });
    expect(permissionsCheck(member, row(D, "member")).allowed).toBe(false);
  });
});

describe("ownership transfer gate", () => {
  it("needs an admin and the exact room name", () => {
    expect(transferGate({ typed: "Deal", roomName: "Deal", target: undefined }).allowed).toBe(false);
    expect(transferGate({ typed: "Deal", roomName: "Deal", target: member })).toEqual({
      allowed: false,
      reason: "Only an admin of this room can become its owner.",
    });
    expect(transferGate({ typed: "deal", roomName: "Deal", target: admin }).allowed).toBe(false);
    expect(transferGate({ typed: "  Deal ", roomName: "Deal", target: admin }).allowed).toBe(true);
    expect(transferGate({ typed: "", roomName: " ", target: admin }).allowed).toBe(false);
    expect(transferGate({ typed: "Deal", roomName: "Deal", target: row(B, "admin", { status: "left" }) }).allowed).toBe(
      false,
    );
  });
});

describe("auto-delete", () => {
  it("maps presets and custom values", () => {
    expect(autoDeleteChoice(0)).toBe("off");
    expect(autoDeleteChoice(86_400)).toBe("day");
    expect(autoDeleteChoice(2_592_000)).toBe("month");
    expect(autoDeleteChoice(3 * 86_400)).toBe("custom");
    expect(splitCustom(3 * 86_400)).toEqual({ amount: "3", unit: "days" });
    expect(splitCustom(2 * 604_800)).toEqual({ amount: "2", unit: "weeks" });
    expect(splitCustom(7200)).toEqual({ amount: "2", unit: "hours" });
    expect(autoDeleteText(0)).toBe("Off");
    expect(autoDeleteText(604_800)).toBe("After 1 week");
  });
  it("checks custom input against the one-year limit", () => {
    expect(customSeconds("3", "days")).toEqual({ seconds: 259_200 });
    expect(customSeconds("365", "days")).toEqual({ seconds: 31_536_000 });
    expect(customSeconds("366", "days")).toEqual({ error: "The longest is 365 days." });
    expect(customSeconds("0", "hours")).toHaveProperty("error");
    expect(customSeconds("1.5", "hours")).toHaveProperty("error");
    expect(customSeconds("", "weeks")).toHaveProperty("error");
  });
});

describe("lists", () => {
  it("sorts owner, admins, members, then by join time", () => {
    expect(sortMembers([member, admin, owner]).map((m) => m.role)).toEqual(["owner", "admin", "member"]);
  });
  it("searches names and addresses", () => {
    expect(matchesQuery(C, "mila", "@MI")).toBe(true);
    expect(matchesQuery(C, null, "dddd")).toBe(true);
    expect(matchesQuery(C, "mila", "zz")).toBe(false);
    expect(matchesQuery(C, null, "  ")).toBe(true);
  });
  it("filters files by kind", () => {
    const f = (kind: SharedFile["kind"]) => ({ kind }) as SharedFile;
    const files = [f("photo"), f("doc"), f("photo"), f("audio")];
    expect(filterFiles(files, "all")).toHaveLength(4);
    expect(filterFiles(files, "photo")).toHaveLength(2);
    expect(filterFiles(files, "video")).toHaveLength(0);
  });
  it("parses people typed into the add field", () => {
    expect(parsePerson("@Ana.Studio")).toEqual({ kind: "name", name: "ana.studio" });
    expect(parsePerson(C.toUpperCase())).toEqual({ kind: "address", address: C });
    expect(parsePerson("qor1abc").kind).toBe("bad");
    expect(parsePerson("ab").kind).toBe("bad");
    expect(parsePerson(" ").kind).toBe("bad");
  });
  it("reads where a request came from", () => {
    expect(requestOrigin("f00dbeef12")).toEqual({ kind: "link" });
    expect(requestOrigin(`add:${B}`)).toEqual({ kind: "suggested", by: B });
  });
  it("compares saved safety words", () => {
    expect(verifyState(undefined, "a b")).toBe("never");
    expect(verifyState("a b", null)).toBe("saved");
    expect(verifyState("a b", "a b")).toBe("match");
    expect(verifyState("a b", "a c")).toBe("changed");
  });
});

describe("derive: rights announced in the room", () => {
  const epochs: EpochRow[] = [
    {
      epoch: 1,
      distribution: "d",
      membershipHash: "m",
      txHash: "0xabc",
      by: A,
      reason: "created",
      at: "2026-11-01T10:00:00.000Z",
    },
  ];
  let seq = 0n;
  const line = (author: string, body: RoomBody): Line => {
    seq += 1n;
    return {
      seq,
      hash: `h${seq}`,
      epoch: 1,
      at: "2026-11-01T10:00:00.000Z",
      expiresAt: null,
      msg: { id: `msg${seq}xyz`, author, sentAt: `2026-11-01T10:00:0${seq}.000Z`, body },
    };
  };
  const base = () => [
    line(A, { kind: "created", members: [C] }),
    line(A, { kind: "info", name: "Deal room", description: "", type: "deal" }),
  ];

  it("a member with the info right can rename the room", () => {
    const d = derive(
      [...base(), line(C, { kind: "info", name: "Renamed", description: "x", type: "team" })],
      [owner, member],
      epochs,
    );
    expect(d.info.name).toBe("Renamed");
    expect(d.actions[0]?.text).toEqual([{ who: C }, " renamed the room to “Renamed”"]);
  });
  it("after the info right is taken away, a rename from that member is ignored", () => {
    const lines = [
      ...base(),
      line(A, { kind: "role", member: C, role: "member", permissions: ["send", "files"] }),
      line(C, { kind: "info", name: "Hijacked", description: "", type: "team" }),
    ];
    expect(derive(lines, [owner, member], epochs).info.name).toBe("Deal room");
  });
  it("an admin's re-post of the same info under a new key shows no change pill", () => {
    const lines = [...base(), line(A, { kind: "info", name: "Deal room", description: "", type: "deal" })];
    const d = derive(lines, [owner, member], epochs);
    expect(d.items.filter((i) => i.type === "pill")).toEqual([]);
    expect(d.info.name).toBe("Deal room");
  });
  it("someone who joined without past messages still learns the room's name from the re-post", () => {
    const later: Line = { ...line(A, { kind: "info", name: "Deal room", description: "Q4", type: "deal" }), epoch: 2 };
    const d = derive([later], [owner, member], [...epochs, { ...epochs[0]!, epoch: 2, reason: "joined" }]);
    expect(d.info.name).toBe("Deal room");
    expect(d.items.filter((i) => i.type === "pill")).toEqual([]);
  });
  it("a re-uploaded copy of a signed message shows once", () => {
    const original = line(C, { kind: "text", text: "Wire sent", mentions: [] });
    const copy: Line = { ...original, seq: 99n, hash: "replayed" };
    const d = derive([...base(), original, copy], [owner, member], epochs);
    expect(d.items.filter((i) => i.type === "message")).toHaveLength(1);
  });
  it("a message from someone not in the room at that time is hidden and said so", () => {
    const stranger = "qor1" + "f".repeat(38);
    const lateJoiner = row(D, "member", { firstEpoch: 3, joinedEpoch: 3 });
    const removed = row(B, "member", { status: "removed", lastEpoch: 1 });
    const lines = [
      ...base(),
      line(stranger, { kind: "text", text: "not a member", mentions: [] }),
      line(D, { kind: "text", text: "before joining", mentions: [] }),
      { ...line(B, { kind: "text", text: "after removal", mentions: [] }), epoch: 2 },
    ];
    const d = derive(lines, [owner, member, lateJoiner, removed], [...epochs, { ...epochs[0]!, epoch: 2 }]);
    expect(d.items.filter((i) => i.type === "message")).toHaveLength(0);
    const problems = d.items.filter((i) => i.type === "problem");
    expect(problems).toHaveLength(3);
    for (const p of problems) expect(p.line.problem).toBe("not-member");
  });
  it("settings still count only from admins", () => {
    const lines = [
      ...base(),
      line(A, {
        kind: "settings",
        approval: true,
        autoDeleteSeconds: 0,
        restrictSaving: false,
        historyDefault: "hide",
      }),
      line(C, {
        kind: "settings",
        approval: false,
        autoDeleteSeconds: 0,
        restrictSaving: false,
        historyDefault: "share",
      }),
    ];
    expect(derive(lines, [owner, member], epochs).info.approval).toBe(true);
  });
});
