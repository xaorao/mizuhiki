import { describe, expect, it } from "vitest";
import { networkOf } from "../../src/lib/network";

describe("networkOf", () => {
  it("keeps an IPv4 address as its own network, including one written IPv4-in-IPv6", () => {
    expect(networkOf("203.0.113.7")).toBe("203.0.113.7");
    expect(networkOf("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("counts every address in an IPv6 /64 as one network", () => {
    const a = networkOf("2001:db8:85a3:1:aaaa:bbbb:cccc:1");
    expect(a).toBe("2001:db8:85a3:1::/64");
    expect(networkOf("2001:0db8:85a3:0001:0:0:0:2")).toBe(a);
    expect(networkOf("2001:db8:85a3:1::99")).toBe(a);
    expect(networkOf("2001:db8:85a3:2::1")).not.toBe(a);
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
    expect(networkOf("fe80::1%en0")).toBe("fe80:0:0:0::/64");
  });

  it("passes anything else through unchanged", () => {
    expect(networkOf("unknown")).toBe("unknown");
  });
});
