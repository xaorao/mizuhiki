import { describe, expect, it } from "vitest";
import {
  FileRequestSchema,
  fileRequestRef,
  namedFile,
  requestIdOfRef,
  requestState,
  stateRefusal,
  type FileRequest,
} from "../src";

const base: FileRequest = {
  v: 1,
  id: "freq_AbCdEf12",
  owner: `qor1${"a".repeat(38)}`,
  title: "Tax documents for 2026",
  description: "",
  deadline: null,
  allowLate: false,
  naming: "original",
  timeZone: "UTC",
  status: "open",
  version: 1,
  updatedAt: "2026-11-19T10:00:00.000Z",
};

describe("file requests", () => {
  it("states follow Dropbox: open, late when late uploads are taken, ended without them, closed", () => {
    const deadline = "2026-11-20T17:00:00.000Z";
    const before = Date.parse(deadline) - 1000;
    const after = Date.parse(deadline) + 1000;
    expect(requestState(base)).toBe("open");
    expect(requestState({ ...base, deadline }, before)).toBe("open");
    expect(requestState({ ...base, deadline }, after)).toBe("ended");
    expect(requestState({ ...base, deadline, allowLate: true }, after)).toBe("late");
    expect(requestState({ ...base, status: "closed" }, before)).toBe("closed");
    expect(stateRefusal("ended")).toMatch(/deadline .* passed\. Nothing was sent\./);
    expect(stateRefusal("closed")).toMatch(/closed\. Nothing was sent\./);
    expect(stateRefusal("late")).toBeNull();
  });

  it("names files by the rule on the uploader's device, never with path or control characters", () => {
    const at = new Date("2026-11-19T08:00:00Z");
    expect(namedFile("original", "w2.pdf")).toBe("w2.pdf");
    expect(namedFile("uploader", "w2.pdf", { uploader: "Hana Mori" })).toBe("Hana Mori – w2.pdf");
    expect(namedFile("uploader", "w2.pdf", { uploader: "  " })).toBe("w2.pdf");
    expect(namedFile("date", "w2.pdf", { at })).toBe("2026-11-19 – w2.pdf");
    expect(namedFile("uploader", "../../etc/passwd", { uploader: "a/b" })).toBe("a b – .. .. etc passwd");
    expect(namedFile("original", "\u0000")).toBe("file");
  });

  it("refs round trip and refuse anything else", () => {
    expect(requestIdOfRef(fileRequestRef(base.id))).toBe(base.id);
    expect(requestIdOfRef("form:abc")).toBeNull();
    expect(requestIdOfRef("freq:a")).toBeNull();
  });

  it("the schema refuses empty titles and bad deadlines", () => {
    expect(FileRequestSchema.safeParse(base).success).toBe(true);
    expect(FileRequestSchema.safeParse({ ...base, title: " " }).success).toBe(false);
    expect(FileRequestSchema.safeParse({ ...base, deadline: "next friday" }).success).toBe(false);
    expect(FileRequestSchema.safeParse({ ...base, timeZone: "Mars/Olympus" }).success).toBe(false);
    expect(FileRequestSchema.safeParse({ ...base, timeZone: "Asia/Tokyo" }).success).toBe(true);
  });
});
