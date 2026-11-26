import { describe, expect, it } from "vitest";
import { loadConfig, webOriginFor, webOrigins } from "../../src/config";

describe("web origins", () => {
  const cfg = { WEB_ORIGIN: "http://localhost:3000, https://mizuhiki.example" };

  it("reads one origin or a comma-separated list", () => {
    expect(webOrigins({ WEB_ORIGIN: "http://localhost:3000" })).toEqual(["http://localhost:3000"]);
    expect(webOrigins(cfg)).toEqual(["http://localhost:3000", "https://mizuhiki.example"]);
  });

  it("binds a sign-in to the requesting site only when it is listed", () => {
    expect(webOriginFor(cfg, "https://mizuhiki.example")).toBe("https://mizuhiki.example");
    expect(webOriginFor(cfg, "http://localhost:3000")).toBe("http://localhost:3000");
    expect(webOriginFor(cfg, "https://evil.example")).toBe("http://localhost:3000");
    expect(webOriginFor(cfg, undefined)).toBe("http://localhost:3000");
  });

  it("refuses an entry that is not a bare origin", () => {
    expect(() => loadConfig({ WEB_ORIGIN: "https://mizuhiki.example/" })).toThrow(/bare origins/);
    expect(() => loadConfig({ WEB_ORIGIN: "http://localhost:3000,https://a.example/path" })).toThrow(/bare origins/);
    expect(() => loadConfig({ WEB_ORIGIN: "not a url" })).toThrow();
  });
});
