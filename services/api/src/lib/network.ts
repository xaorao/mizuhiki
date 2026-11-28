import { isIPv4, isIPv6 } from "node:net";

/**
 * The network a client address belongs to, for per-network limits. An IPv4 address is its own network. An IPv6 client
 * is usually given a whole /64 and can pick any address in it, so IPv6 is counted by its /64 prefix.
 */
export function networkOf(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1]) return mapped[1];
  if (isIPv4(ip) || !isIPv6(ip)) return ip;
  const [head = "", tail = ""] = (ip.split("%")[0] ?? ip).split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...left, ...Array.from({ length: 8 - left.length - right.length }, () => "0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g || "0", 16).toString(16))
    .join(":")}::/64`;
}
