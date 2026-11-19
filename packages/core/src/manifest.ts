/**
 * The page manifest: everything public about a page, signed by the owner's
 * keys (kind "manifest"). The server checks the signature on publish and every
 * visitor's browser checks it again before using it (THREAT_MODEL A1).
 */
import { z } from "zod";
import { NAME_RE } from "./names";

const id = z.string().regex(/^[A-Za-z0-9_-]{6,40}$/);
const short = (max: number) => z.string().trim().max(max);
const url = z
  .string()
  .max(2048)
  .refine((u) => {
    try {
      const x = new URL(u);
      return x.protocol === "https:" || x.protocol === "http:" || x.protocol === "mailto:";
    } catch {
      return false;
    }
  }, "Use a full link starting with https://");

export const TOKENS = ["fUSD", "QOR"] as const;

const base = {
  id,
  on: z.boolean(),
  archived: z.boolean().default(false),
  title: short(80).min(1),
  subtitle: short(120).default(""),
  /** Collection this block sits in, if any. */
  collection: id.optional(),
};

export const BlockSchema = z.discriminatedUnion("type", [
  z.object({ ...base, type: z.literal("link"), url }),
  z.object({ ...base, type: z.literal("collection") }),
  z.object({ ...base, type: z.literal("text"), body: short(1000) }),
  z.object({
    ...base,
    type: z.literal("pay"),
    tokens: z.array(z.enum(TOKENS)).min(1),
    presets: z
      .array(z.string().regex(/^\d+(\.\d{1,6})?$/))
      .max(4)
      .default([]),
    tip: z.boolean().default(false),
    thanks: short(200).default(""),
    redirect: url.optional(),
  }),
  z.object({ ...base, type: z.literal("invoiceRequest") }),
  z.object({
    ...base,
    type: z.literal("message"),
    greeting: short(200).default(""),
    allowFiles: z.boolean().default(true),
    maxFileMB: z.number().int().min(1).max(2048).default(500),
  }),
  z.object({ ...base, type: z.literal("fileRequest"), requestId: id }),
  z.object({ ...base, type: z.literal("form"), formId: id, slug: z.string().regex(/^[a-z0-9-]{1,48}$/) }),
  z.object({ ...base, type: z.literal("product"), productId: id }),
  z.object({ ...base, type: z.literal("shopSection"), productIds: z.array(id).max(48) }),
  /** A room invite on the page: the join path with its link key (anyone who sees the page can ask to join). */
  z.object({
    ...base,
    type: z.literal("room"),
    roomId: id,
    invite: z.string().regex(/^\/join\/[a-z0-9]{12,32}#k=[A-Za-z0-9_-]{43}$/),
  }),
  z.object({ ...base, type: z.literal("capsule") }),
  z.object({ ...base, type: z.literal("social") }),
]);
export type Block = z.infer<typeof BlockSchema>;
export type BlockType = Block["type"];

export const SOCIALS = ["instagram", "x", "linkedin", "youtube", "tiktok", "github", "website", "email"] as const;

export const ThemeSchema = z.object({
  preset: z.enum(["washi", "sora", "matcha", "kinari", "fuji", "custom"]).default("washi"),
  header: z.enum(["classic", "hero"]).default("classic"),
  wallpaper: z.object({
    kind: z.enum(["fill", "gradient", "pattern", "blur", "image"]).default("pattern"),
    a: z.string().regex(/^#[0-9a-f]{6}$/i),
    b: z.string().regex(/^#[0-9a-f]{6}$/i),
    image: z.string().optional(),
  }),
  font: z.enum(["round", "sans", "jp"]).default("round"),
  text: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .default("#2b2340"),
  button: z.object({
    style: z.enum(["solid", "glass", "outline"]).default("solid"),
    radius: z.enum(["pill", "round", "square"]).default("pill"),
    shadow: z.boolean().default(true),
    color: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i)
      .default("#ffffff"),
  }),
  poweredBy: z.boolean().default(false),
});
export type Theme = z.infer<typeof ThemeSchema>;

export const DEFAULT_THEME: Theme = {
  preset: "washi",
  header: "classic",
  wallpaper: { kind: "pattern", a: "#ffc4d0", b: "#ffb3c3" },
  font: "round",
  text: "#2b2340",
  button: { style: "solid", radius: "pill", shadow: true, color: "#ffffff" },
  poweredBy: false,
};

export const ManifestSchema = z.object({
  v: z.literal(1),
  name: z.string().regex(NAME_RE),
  address: z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/),
  displayName: short(60).min(1),
  bio: short(160).default(""),
  /** Public image in the media store, by SHA-256. */
  avatar: z
    .object({ hash: z.string().regex(/^[0-9a-f]{64}$/), type: z.enum(["image/png", "image/jpeg", "image/webp"]) })
    .optional(),
  socials: z
    .array(z.object({ kind: z.enum(SOCIALS), url }))
    .max(8)
    .default([]),
  goal: z.enum(["creator", "business", "personal", "team"]).default("creator"),
  theme: ThemeSchema,
  blocks: z.array(BlockSchema).max(100),
  /** Period public keys for passes are published here so senders seal to them too. */
  periodKeys: z
    .array(
      z.object({
        label: short(40),
        index: z.number().int(),
        mlkem: z.string().regex(/^[0-9a-f]+$/),
        x25519: z.string().regex(/^[0-9a-f]{64}$/),
        /** The pass this key belongs to (spec 5.12). */
        passId: z
          .string()
          .regex(/^[A-Za-z0-9_-]{6,40}$/)
          .optional(),
        /** Items dated in [from, until) are sealed to this key too; kinds limit which items. */
        from: z.iso.datetime().optional(),
        until: z.iso.datetime().optional(),
        kinds: z
          .array(z.enum(["messages", "payments", "forms", "invoices"]))
          .max(4)
          .optional(),
      }),
    )
    // 16 period passes and the offline recovery reader (spec 5.12, 5.13).
    .max(17)
    .default([]),
  version: z.number().int().min(1),
  updatedAt: z.iso.datetime(),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export function parseManifest(x: unknown): Manifest {
  return ManifestSchema.parse(x);
}

/** Short random id for blocks, forms, rooms and the like. */
export function newId(len = 12): string {
  const a = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = new Uint8Array(len);
  globalThis.crypto.getRandomValues(b);
  let out = "";
  for (const x of b) out += a[x % a.length] ?? "a";
  return out;
}
