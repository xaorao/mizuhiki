/**
 * Deep links into a page (spec 5.4): /@name/pay, /@name/pay/25 (the amount in
 * the path pre-fills pay and wins over presets), /@name/message, /@name/f/<slug>,
 * /@name/p/<slug>, /@name/checkout, /@name/b/<blockId>, /@name/r/<requestId> (a file request). The same sheets open in place on tap.
 */
export type DeepLink =
  | { kind: "none" }
  | { kind: "pay"; amount?: string }
  | { kind: "message" }
  | { kind: "form"; slug: string }
  | { kind: "product"; slug: string }
  | { kind: "checkout" }
  | { kind: "block"; id: string }
  | { kind: "request"; id: string }
  | { kind: "unknown"; path: string };

const AMOUNT = /^\d{1,12}(\.\d{1,6})?$/;
const SLUG = /^[a-z0-9-]{1,48}$/;
const ID = /^[A-Za-z0-9_-]{6,40}$/;

export function parseDeepLink(path: string[]): DeepLink {
  const [a, b, ...rest] = path.map((p) => decodeURIComponent(p));
  if (!a) return { kind: "none" };
  if (rest.length) return { kind: "unknown", path: path.join("/") };
  if (a === "pay" && !b) return { kind: "pay" };
  if (a === "pay" && b && AMOUNT.test(b)) return { kind: "pay", amount: b };
  if (a === "message" && !b) return { kind: "message" };
  if (a === "checkout" && !b) return { kind: "checkout" };
  if (a === "f" && b && SLUG.test(b)) return { kind: "form", slug: b };
  if (a === "p" && b && SLUG.test(b)) return { kind: "product", slug: b };
  if (a === "b" && b && ID.test(b)) return { kind: "block", id: b };
  if (a === "r" && b && ID.test(b)) return { kind: "request", id: b };
  return { kind: "unknown", path: path.join("/") };
}

export function deepLinkPath(name: string, d: DeepLink): string {
  switch (d.kind) {
    case "pay":
      return `/@${name}/pay${d.amount ? `/${d.amount}` : ""}`;
    case "message":
      return `/@${name}/message`;
    case "form":
      return `/@${name}/f/${d.slug}`;
    case "product":
      return `/@${name}/p/${d.slug}`;
    case "checkout":
      return `/@${name}/checkout`;
    case "block":
      return `/@${name}/b/${d.id}`;
    case "request":
      return `/@${name}/r/${d.id}`;
    default:
      return `/@${name}`;
  }
}
