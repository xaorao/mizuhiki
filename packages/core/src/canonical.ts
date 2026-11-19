/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * no undefined, finite numbers only. The same value always gives the same
 * bytes, so a signature over it can be checked anywhere.
 */
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export function canonicalJson(value: unknown): string {
  return enc(value);
}

function enc(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("canonical JSON: non-finite number");
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : enc(x))).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${enc(o[k])}`).join(",")}}`;
  }
  throw new Error(`canonical JSON: unsupported ${typeof v}`);
}
