/** Server-side reads from services/api (public data only; no keys exist on the server). */
import "server-only";
import type { Manifest, RecipientCard, Signed } from "@mizuhiki/core";

const BASE = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000";

export type PageLookup =
  | { state: "ok"; record: Signed<Manifest>; card: RecipientCard | null; registry: { owner: string; cardHash: string } }
  | { state: "missing" | "moved" | "error"; message: string };

export async function lookupPage(name: string): Promise<PageLookup> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/pages/${encodeURIComponent(name)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { state: "error", message: "Mizuhiki could not be reached. Try again in a moment." };
  }
  const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Partial<
    Extract<PageLookup, { state: "ok" }>
  >;
  if (res.status === 404) return { state: "missing", message: j.error?.message ?? "This page isn't available." };
  if (res.status === 410)
    return { state: "moved", message: j.error?.message ?? `This @${name} no longer points here.` };
  if (!res.ok || !j.record || !j.registry)
    return { state: "error", message: j.error?.message ?? "This page could not be loaded." };
  return { state: "ok", record: j.record, card: j.card ?? null, registry: j.registry };
}

export type FormLookup =
  | { state: "ok"; record: Signed<import("@mizuhiki/core").FormDef>; open: boolean; closedReason: string | null }
  | { state: "missing" | "error"; message: string };

export async function lookupForm(name: string, slug: string): Promise<FormLookup> {
  try {
    const res = await fetch(`${BASE}/forms/${encodeURIComponent(name)}/${encodeURIComponent(slug)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Partial<
      Extract<FormLookup, { state: "ok" }>
    >;
    if (res.status === 404) return { state: "missing", message: j.error?.message ?? "This form isn't available." };
    if (!res.ok || !j.record) return { state: "error", message: j.error?.message ?? "This form could not be loaded." };
    return { state: "ok", record: j.record, open: j.open ?? false, closedReason: j.closedReason ?? null };
  } catch {
    return { state: "error", message: "Mizuhiki could not be reached. Try again in a moment." };
  }
}
