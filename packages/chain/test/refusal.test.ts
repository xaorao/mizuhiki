import { describe, expect, it } from "vitest";
import { explainRefusal } from "../src/errors";

// Logs as QoreChain testnet returns them from a simulation (captured 2026-11-24).
const bank = (have: string, need: string, denom: string) =>
  `failed to execute message; message index: 0: spendable balance ${have}${denom} is smaller than ${need}${denom}: insufficient funds [cosmos/cosmos-sdk@v0.53.8/x/bank/keeper/send.go:298] with gas used: '175539'`;
const FUSD = "erc20:0x97143B771D34ddb9130b807b135Ae675A5a963CA";

describe("explainRefusal: insufficient funds", () => {
  it("names fUSD, with both amounts, when a payment is short of fUSD", () => {
    expect(explainRefusal("sdk", 5, bank("1585000", "10000000", FUSD))).toEqual({
      code: "NO_FUNDS",
      message: "Not enough test dollars (fUSD): this needs 10 fUSD and the account has 1.585 fUSD. Nothing was sent.",
    });
  });

  it("names QOR when the amount sent is more QOR than the account holds", () => {
    expect(explainRefusal("sdk", 5, bank("666006322", "10000000000", "uqor")).message).toBe(
      "Not enough test QOR: this needs 10000 QOR and the account has 666.006322 QOR. Nothing was sent.",
    );
  });

  it("falls back to the network fee when the log does not name a known coin", () => {
    expect(explainRefusal("sdk", 5, "insufficient funds to pay for fees; 10uqor < 20000uqor").message).toBe(
      "Not enough test QOR to pay the network fee. Nothing was sent.",
    );
  });
});
