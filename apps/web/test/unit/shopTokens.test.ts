import { describe, expect, it } from "vitest";
import { DENOMS } from "@mizuhiki/chain";
import { TOKEN_DECIMALS } from "@mizuhiki/core";

describe("shop token decimals", () => {
  it("match the chain's denominations", () => {
    expect(TOKEN_DECIMALS.fUSD).toBe(DENOMS.fUSD.decimals);
    expect(TOKEN_DECIMALS.QOR).toBe(DENOMS.QOR.decimals);
  });
});
