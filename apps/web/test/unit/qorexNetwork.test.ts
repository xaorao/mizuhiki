import { describe, expect, it } from "vitest";
import { asFailure, qorexNetworkMismatch } from "@/lib/pay";

describe("QoreX on the wrong network", () => {
  it("says which network QoreX is on and where its testnet switch is (real QoreX 0.4.2 error text)", () => {
    expect(qorexNetworkMismatch("QoreX: chain qorechain-diana does not match the active network qorechain-vladi")).toBe(
      "QoreX is on QoreChain mainnet, and this page uses testnet. In QoreX, tap the version number at the bottom 7 times, choose \u201cSwitch to testnet (diana)\u201d, then pay again. No money moved.",
    );
  });

  it("leaves every other error alone", () => {
    expect(qorexNetworkMismatch("QoreX: user rejected the request")).toBeNull();
  });
});

describe("QoreX refusals as the payer sees them", () => {
  it("a second request while one is waiting: nothing sent by this attempt, and what to do", () => {
    const f = asFailure(new Error("QoreX: a request from this site is already waiting for your answer."));
    expect(f.moved).toBe("no");
    expect(f.message).toMatch(/^QoreX still has an earlier request from this page\..*This attempt sent nothing\.$/);
  });

  it("the wrong network: nothing moved", () => {
    const f = asFailure(new Error("QoreX: chain qorechain-diana does not match the active network qorechain-vladi"));
    expect(f.moved).toBe("no");
    expect(f.message).toMatch(/No money moved\.$/);
  });

  it("a rejection in the wallet: nothing moved", () => {
    expect(asFailure(new Error("QoreX: user rejected the request")).message).toBe(
      "You cancelled in the wallet. No money moved.",
    );
  });
});
