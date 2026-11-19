import { describe, expect, it } from "vitest";
import { ChainError } from "@mizuhiki/chain";
import { isChainUnreachable } from "../../src/lib/errors";

describe("chain outage errors", () => {
  it("recognises an unreachable QoreChain and nothing else", () => {
    expect(isChainUnreachable(new ChainError("NETWORK", "Could not reach QoreChain."))).toBe(true);
    const viem = new Error("HTTP request failed.");
    viem.name = "HttpRequestError";
    expect(isChainUnreachable(viem)).toBe(true);
    expect(
      isChainUnreachable(new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED 1.2.3.4:443") })),
    ).toBe(true);
    expect(isChainUnreachable(new ChainError("REFUSED", "Not registered."))).toBe(false);
    expect(isChainUnreachable(new Error("relation does not exist"))).toBe(false);
    expect(isChainUnreachable("not an error")).toBe(false);
  });
});
