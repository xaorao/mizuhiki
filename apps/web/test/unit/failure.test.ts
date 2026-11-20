import { afterEach, describe, expect, it, vi } from "vitest";
import { BaseError, HttpRequestError, TimeoutError } from "viem";
import { ChainError, isUnreachable } from "@mizuhiki/chain";
import { MizuhikiError } from "@mizuhiki/core";
import { ApiFailure } from "../../src/lib/api";
import { OFFLINE_TEXT, failureText } from "../../src/lib/failure";

describe("isUnreachable: network trouble, not a wrong answer", () => {
  it("names connection failures from every browser and from viem", () => {
    expect(isUnreachable(new TypeError("Failed to fetch"))).toBe(true);
    expect(isUnreachable(new TypeError("NetworkError when attempting to fetch resource."))).toBe(true);
    expect(isUnreachable(new TypeError("Load failed"))).toBe(true);
    expect(isUnreachable(new HttpRequestError({ url: "https://evm-testnet.qore.host" }))).toBe(true);
    expect(isUnreachable(new TimeoutError({ body: {}, url: "https://evm-testnet.qore.host" }))).toBe(true);
    // Wrapped, as viem does inside a contract call.
    expect(isUnreachable(new BaseError("call failed", { cause: new HttpRequestError({ url: "x" }) }))).toBe(true);
    expect(isUnreachable(new ChainError("NETWORK", "QoreChain did not answer."))).toBe(true);
  });
  it("leaves real refusals and mismatches alone", () => {
    expect(isUnreachable(new ChainError("REFUSED", "QoreChain says @a belongs to a different account."))).toBe(false);
    expect(isUnreachable(new Error("This page is not signed by the account that owns the name."))).toBe(false);
    expect(isUnreachable(new TypeError("Cannot read properties of undefined"))).toBe(false);
  });
});

describe("failureText: words a person can act on", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("passes our own messages through", () => {
    expect(failureText(new ApiFailure(409, "TAKEN", "That name is taken.", "no"), "x")).toBe("That name is taken.");
    expect(failureText(new ChainError("REFUSED", "Nothing was sent."), "x")).toBe("Nothing was sent.");
    expect(failureText(new MizuhikiError("NOT_A_READER", "This item is not sealed to you."), "x")).toBe(
      "This item is not sealed to you.",
    );
    expect(failureText(new Error("Name the capsule first."), "x")).toBe("Name the capsule first.");
  });
  it("names the network instead of blaming sealing or the input", () => {
    expect(failureText(new TypeError("Failed to fetch"), "Something went wrong while sealing it.")).toBe(OFFLINE_TEXT);
    vi.stubGlobal("navigator", { onLine: false });
    expect(failureText(new Error("anything"), "fallback")).toBe(OFFLINE_TEXT);
  });
  it("never shows a library's raw message", () => {
    expect(
      failureText(new TypeError("Cannot read properties of undefined (reading 'x')"), "The room was not made."),
    ).toBe("The room was not made.");
    expect(failureText(new RangeError("Invalid array length"), "Not saved.")).toBe("Not saved.");
    expect(failureText("a string", "Not saved.")).toBe("Not saved.");
  });
});
