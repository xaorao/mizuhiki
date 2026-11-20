/**
 * File requests (spec 5.7, Dropbox's file requests; ARCHITECTURE 8g). A
 * request is public and signed by the owner (kind "filerequest"); the
 * uploader's browser checks it against the owner's key on chain before
 * showing it. Uploads are ordinary sealed drops (kind "filedrop", ref
 * `freq:<id>`): the server never sees names, notes or contents.
 */
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/);
const addr = z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/);

/** Dropbox's "naming conventions", applied on the uploader's device before sealing. */
export const NAMING_RULES = ["original", "uploader", "date"] as const;
export type NamingRule = (typeof NAMING_RULES)[number];

export const FileRequestSchema = z.object({
  v: z.literal(1),
  id,
  owner: addr,
  title: z.string().trim().min(1).max(120),
  description: z.string().max(1000).default(""),
  /** An instant (ISO, UTC); shown in the owner's time zone and the uploader's. */
  deadline: z.iso.datetime().nullable().default(null),
  /** After the deadline: take uploads and mark them late, or refuse them. */
  allowLate: z.boolean().default(false),
  naming: z.enum(NAMING_RULES).default("original"),
  /** The owner's IANA time zone when the deadline was set, so both sides can name it. */
  timeZone: z
    .string()
    .max(64)
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat("en-GB", { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, "not a time zone")
    .default("UTC"),
  status: z.enum(["open", "closed"]),
  version: z.number().int().min(1),
  updatedAt: z.iso.datetime(),
});
export type FileRequest = z.infer<typeof FileRequestSchema>;

export const fileRequestRef = (requestId: string): string => `freq:${requestId}`;
export function requestIdOfRef(ref: string | null | undefined): string | null {
  return /^freq:([A-Za-z0-9_-]{8,40})$/.exec(ref ?? "")?.[1] ?? null;
}

export type RequestState = "open" | "late" | "ended" | "closed";

/**
 * What an upload would meet right now: open; after the deadline but late uploads
 * are taken ("late"); after the deadline without late uploads ("ended"); or closed.
 */
export function requestState(
  r: Pick<FileRequest, "status" | "deadline" | "allowLate">,
  now = Date.now(),
): RequestState {
  if (r.status === "closed") return "closed";
  if (r.deadline && now > Date.parse(r.deadline)) return r.allowLate ? "late" : "ended";
  return "open";
}

/** Plain words for each state, for the uploader and the owner. */
export function stateRefusal(state: RequestState): string | null {
  if (state === "closed") return "This request is closed. Nothing was sent.";
  if (state === "ended") return "The deadline for this request has passed. Nothing was sent.";
  return null;
}

/** Drop path separators, characters file systems refuse, and control characters; collapse spaces. */
const clean = (s: string) =>
  Array.from(s, (c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();

/** The file's name after the request's naming rule ("Uploader – file", "2026-11-19 – file"). */
export function namedFile(rule: NamingRule, original: string, opts: { uploader?: string; at?: Date } = {}): string {
  const base = clean(original) || "file";
  if (rule === "uploader") {
    const who = clean(opts.uploader ?? "").slice(0, 60);
    return who ? `${who} – ${base}` : base;
  }
  if (rule === "date") return `${(opts.at ?? new Date()).toISOString().slice(0, 10)} – ${base}`;
  return base;
}

export const NAMING_LABEL: Record<NamingRule, string> = {
  original: "Keep the file's own name",
  uploader: "Uploader's name – file name",
  date: "Upload date – file name",
};
