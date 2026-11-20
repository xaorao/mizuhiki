import { describe, expect, it } from "vitest";
import { deadlineDay, deadlineText } from "../../src/requests/model";

const r = { deadline: "2026-11-20T08:00:00.000Z", timeZone: "Asia/Tokyo" };

describe("file request deadlines", () => {
  it("says the owner's time first and adds the viewer's when it differs", () => {
    expect(deadlineText(r, "Asia/Tokyo")).toBe("Due 20 November 2026 at 17:00 Tokyo time");
    expect(deadlineText(r, "America/Los_Angeles")).toBe("Due 20 November 2026 at 17:00 Tokyo time (00:00 your time)");
    // Another day for the viewer: the date is said too.
    expect(deadlineText(r, "Pacific/Honolulu")).toBe(
      "Due 20 November 2026 at 17:00 Tokyo time (19 November 2026 at 22:00 your time)",
    );
    expect(deadlineText(r, "Europe/London")).toBe("Due 20 November 2026 at 17:00 Tokyo time (08:00 your time)");
    expect(deadlineText({ ...r, timeZone: "UTC" }, "UTC")).toBe("Due 20 November 2026 at 08:00 UTC");
  });
  it("no deadline, a broken date or an unknown zone never throws", () => {
    expect(deadlineText({ deadline: null, timeZone: "UTC" })).toBeNull();
    expect(deadlineText({ deadline: "soon", timeZone: "UTC" })).toBeNull();
    expect(deadlineText({ ...r, timeZone: "Mars/Olympus" }, "UTC")).toBe("Due 20 November 2026 at 08:00 UTC");
    expect(deadlineDay({ ...r, timeZone: "Mars/Olympus" })).toBe("20 Nov 2026");
    expect(deadlineDay(r)).toBe("20 Nov 2026");
  });
});
