import { describe, expect, it } from "vitest";
import { createPublicClient, custom } from "viem";
import { lagTolerant, qorechainTestnet } from "../src/evm";

/** A provider that fails the first `failures` calls with `error`, then answers. */
function flaky(failures: number, error: { code: number; message: string }) {
  let calls = 0;
  const provider = {
    request: () => {
      calls++;
      // A JSON-RPC error as a provider rejects with it: an Error carrying the RPC code.
      if (calls <= failures) return Promise.reject(Object.assign(new Error(error.message), { code: error.code }));
      return Promise.resolve("0x2648");
    },
  };
  return { provider, calls: () => calls };
}

const client = (p: { request: () => Promise<string> }, attempts = 4) =>
  createPublicClient({
    chain: qorechainTestnet,
    transport: lagTolerant(custom(p, { retryCount: 0 }), { attempts, delayMs: 1 }),
  });

const lag = { code: -32602, message: "header not found" };

describe("lagTolerant", () => {
  it("asks again when a node a block behind answers 'header not found'", async () => {
    const f = flaky(2, lag);
    expect(await client(f.provider).request({ method: "eth_chainId" })).toBe("0x2648");
    expect(f.calls()).toBe(3);
  });

  it("gives up after the set number of attempts and passes the error on", async () => {
    const f = flaky(10, lag);
    await expect(client(f.provider, 3).request({ method: "eth_chainId" })).rejects.toThrow(/header not found/);
    expect(f.calls()).toBe(3);
  });

  it("does not repeat any other error", async () => {
    const f = flaky(1, { code: -32602, message: "invalid argument 0: hex string has odd length" });
    await expect(client(f.provider).request({ method: "eth_chainId" })).rejects.toThrow(/odd length/);
    expect(f.calls()).toBe(1);
  });
});
