import type { RecipientCard } from "@qorechain/qoreseal";
import { canonicalJson } from "./canonical";
import { sha256Hex, utf8 } from "./bytes";

/** Same rule as MizuhikiRegistry.isValidName: 3 to 30 of a-z 0-9 . _ -, letter or digit at both ends. */
export const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{1,28})[a-z0-9]$/;

/** Names that would collide with app routes or mislead visitors. */
export const RESERVED_NAMES = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "blog",
  "design",
  "dashboard",
  "docs",
  "help",
  "home",
  "inbox",
  "legal",
  "login",
  "logout",
  "mizuhiki",
  "new",
  "null",
  "official",
  "pay",
  "privacy",
  "proof",
  "qorechain",
  "qorex",
  "root",
  "security",
  "settings",
  "signup",
  "sign-up",
  "static",
  "status",
  "support",
  "system",
  "terms",
  "undefined",
  "www",
  "_next",
]);

export type NameProblem = "empty" | "short" | "long" | "chars" | "edges" | "reserved";

/** Plain-words check for the claim box and sign-up (spec 5.1 step 3). */
export function nameProblem(raw: string): { problem: NameProblem; message: string } | undefined {
  const n = raw.trim();
  if (n.length === 0) return { problem: "empty", message: "Type the name you want." };
  if (n.length < 3) return { problem: "short", message: "Usernames must be 3 characters or longer" };
  if (n.length > 30) return { problem: "long", message: "Usernames can be up to 30 characters" };
  if (/[^a-z0-9._-]/.test(n))
    return { problem: "chars", message: "Use lowercase letters, numbers, dots, dashes or underscores" };
  if (!NAME_RE.test(n)) return { problem: "edges", message: "Start and end with a letter or a number" };
  if (RESERVED_NAMES.has(n)) return { problem: "reserved", message: "That name is reserved" };
  return undefined;
}

/** Lower-case and drop characters names cannot hold, as the person types. */
export function normalizeNameInput(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9._-]/g, "")
    .slice(0, 30);
}

/** Three suggestions when a name is taken ("That's taken." with three suggestions, spec 5.1). */
export function nameSuggestions(base: string, taken: (n: string) => boolean = () => false): string[] {
  const b = normalizeNameInput(base).replace(/[._-]+$/, "") || "page";
  const year = new Date().getUTCFullYear() % 100;
  const pool = [`${b}.studio`, `${b}${year}`, `hey.${b}`, `${b}_page`, `${b}.me`, `the.${b}`, `${b}.co`];
  return pool.filter((n) => !nameProblem(n) && !taken(n)).slice(0, 3);
}

/** The card hash stored in MizuhikiRegistry: SHA-256 of the card's canonical JSON. */
export function cardHash(card: RecipientCard): string {
  return sha256Hex(utf8(canonicalJson(card)));
}
