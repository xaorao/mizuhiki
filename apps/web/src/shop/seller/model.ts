/**
 * Pure helpers for the seller's Shop screens (spec 5.11): labels, amounts,
 * the description subset (**bold**, *italic*, [link](https://…), paragraphs),
 * order and discount wording, and the fingerprint that tells "changes not
 * published" apart from what buyers see. No React, no network: unit-tested.
 */
import {
  canonicalJson,
  formatAmount,
  sha256Hex,
  utf8,
  type Content,
  type ProductDef,
  type ProductKind,
  type ShopToken,
} from "@mizuhiki/core";
import type { IconName } from "@mizuhiki/ui";
import type { DiscountRow, OrderView, ProductDraft } from "../engine";

export type Tone = "sakura" | "sora" | "matcha" | "butter" | "fuji" | "kinari";

export const KIND_ICON: Record<ProductKind, IconName> = {
  file: "file",
  course: "folder",
  report: "chart",
  bundle: "archive",
  call: "calendar",
  commission: "pen",
  tip: "heart",
};
export const KIND_TONE: Record<ProductKind, Tone> = {
  file: "sakura",
  course: "sora",
  report: "matcha",
  bundle: "butter",
  call: "fuji",
  commission: "kinari",
  tip: "sakura",
};

/** The editor's working copy: the engine's draft plus the fingerprint of what was last published. */
export type EditorDraft = ProductDraft & { publishedFp?: string | undefined };

/** What buyers would see, minus bookkeeping (version, time, the sealed content's hash). */
export function fingerprint(d: Pick<ProductDraft, "def" | "content">): string {
  const { version: _v, updatedAt: _u, content: _c, ...rest } = d.def;
  return sha256Hex(utf8(canonicalJson({ def: rest, content: d.content })));
}

export const productPath = (name: string, slug: string) => `/@${name}/p/${slug}`;

/** "12.5 fUSD", "From 3 QOR" for pay what you want and tip jars. */
export function priceLabel(def: Pick<ProductDef, "price" | "kind">): string {
  const p = def.price;
  if (p.pwyw || def.kind === "tip") return `${formatAmount(p.pwyw?.min ?? p.amount, p.token)}+`;
  return formatAmount(p.amount, p.token);
}

/** Base units back to what a person types ("12.5"), for amount fields. */
export function amountInput(base: string | bigint, token: ShopToken): string {
  return formatAmount(base, token).replace(` ${token}`, "");
}

/** Sum amounts per token: "12 fUSD · 3 QOR", or "0" in the first token when empty. */
export function sumByToken(
  items: { amount: string | bigint; token: ShopToken }[],
  fallback: ShopToken = "fUSD",
): string {
  const sums = new Map<ShopToken, bigint>();
  for (const i of items) sums.set(i.token, (sums.get(i.token) ?? 0n) + BigInt(i.amount));
  const parts = [...sums].filter(([, n]) => n > 0n).map(([t, n]) => formatAmount(n, t));
  return parts.length ? parts.join(" · ") : formatAmount(0n, fallback);
}

// ---- files -----------------------------------------------------------------------------

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Math.round(v * 10) / 10} ${units[i] ?? "TB"}`;
}

/** "ZIP" from "pack.zip", else the subtype of the media type, else "FILE". */
export function fileKind(name: string, type = ""): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1];
  if (ext) return ext.toUpperCase();
  const sub = type.split("/")[1]?.split(/[+.;-]/)[0];
  return sub ? sub.toUpperCase().slice(0, 8) : "FILE";
}

/** Gumroad's upload line: "ZIP · 34% of 878.6 KB". */
export function uploadLine(name: string, type: string, done: number, total: number): string {
  const pct = total === 0 ? 100 : Math.min(100, Math.floor((done / total) * 100));
  return `${fileKind(name, type)} · ${pct}% of ${formatBytes(total)}`;
}

// ---- description subset ----------------------------------------------------------------

export type Inline =
  | { t: "text"; text: string }
  | { t: "b"; text: string }
  | { t: "i"; text: string }
  | { t: "a"; text: string; href: string };

const INLINE = /\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|\[([^\]\n]{1,200})\]\((https?:\/\/[^)\s]{1,2000})\)/g;

/** Paragraphs (split on blank lines), each a list of inline pieces. Single newlines stay as line breaks. */
export function parseRich(src: string): Inline[][] {
  return src
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const out: Inline[] = [];
      let at = 0;
      for (const m of p.matchAll(INLINE)) {
        if (m.index > at) out.push({ t: "text", text: p.slice(at, m.index) });
        if (m[1] !== undefined) out.push({ t: "b", text: m[1] });
        else if (m[2] !== undefined) out.push({ t: "i", text: m[2] });
        else if (m[3] !== undefined && m[4] !== undefined) {
          try {
            const u = new URL(m[4]);
            out.push(
              u.protocol === "https:" || u.protocol === "http:"
                ? { t: "a", text: m[3], href: u.toString() }
                : { t: "text", text: m[0] },
            );
          } catch {
            out.push({ t: "text", text: m[0] });
          }
        }
        at = m.index + m[0].length;
      }
      if (at < p.length) out.push({ t: "text", text: p.slice(at) });
      return out;
    });
}

/** Wrap the selection in a textarea's value: returns the new value and the selection to restore. */
export function wrapSelection(
  value: string,
  start: number,
  end: number,
  kind: "b" | "i" | "a",
): { value: string; start: number; end: number } {
  const picked = value.slice(start, end);
  if (kind === "a") {
    const label = picked || "link text";
    const ins = `[${label}](https://)`;
    // Select "https://" so the seller types the address straight away.
    const urlAt = start + label.length + 3;
    return { value: value.slice(0, start) + ins + value.slice(end), start: urlAt, end: urlAt + 8 };
  }
  const mark = kind === "b" ? "**" : "*";
  const text = picked || (kind === "b" ? "bold text" : "italic text");
  return {
    value: value.slice(0, start) + mark + text + mark + value.slice(end),
    start: start + mark.length,
    end: start + mark.length + text.length,
  };
}

// ---- booking hours ----------------------------------------------------------------------

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export const toTime = (min: number) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
export function fromTime(t: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
}

/** Plain problems with weekly hours: a range must end after it starts, fit one call, and not overlap another that day. */
export function hoursProblems(hours: { day: number; from: number; to: number }[], minutes: number): string[] {
  const out: string[] = [];
  for (let day = 0; day < 7; day++) {
    const name = WEEKDAYS[day] ?? "";
    const rs = hours.filter((h) => h.day === day).sort((a, b) => a.from - b.from);
    rs.forEach((r, i) => {
      if (r.to <= r.from) out.push(`${name}: the end time must be after the start time.`);
      else if (r.to - r.from < minutes)
        out.push(`${name}: ${toTime(r.from)}–${toTime(r.to)} is shorter than one ${minutes}-minute call.`);
      const prev = rs[i - 1];
      if (prev && r.from < prev.to) out.push(`${name}: two ranges overlap.`);
    });
  }
  return out;
}

// ---- orders -----------------------------------------------------------------------------

export type Chip = "ok" | "wait" | "danger" | "info" | "neutral";

export function orderStatus(o: Pick<OrderView, "status" | "delivery">): { label: string; chip: Chip } {
  switch (o.status) {
    case "awaiting":
      return { label: "Awaiting payment", chip: "neutral" };
    case "in_progress":
      return { label: "Deposit paid", chip: "info" };
    case "paid":
      return o.delivery ? { label: "Delivered", chip: "ok" } : { label: "Paid · waiting to be sealed", chip: "wait" };
    case "delivered":
      return { label: "Delivered", chip: "ok" };
    case "refunded":
      return { label: "Refunded", chip: "danger" };
    case "expired":
      return { label: "Expired", chip: "neutral" };
  }
}

export const shortAddr = (a: string) => (a.length > 16 ? `${a.slice(0, 9)}…${a.slice(-5)}` : a);

/** Who bought it, as the seller should read it. */
/**
 * Who an order is from, for the seller: the buyer's @name when they have one (looked up from QoreChain names by
 * the caller), otherwise their shortened address.
 */
export function buyerLabel(
  o: Pick<OrderView, "payer" | "request">,
  names: Readonly<Record<string, string | null | undefined>> = {},
): string {
  const who = (a: string) => (names[a] ? `@${names[a]}` : shortAddr(a));
  const r = o.request.recipient;
  if (o.request.gift && r.kind === "account") return `Gift to ${who(r.address)}`;
  if (o.payer) return who(o.payer);
  return r.kind === "account" ? who(r.address) : "A buyer key (not paid yet)";
}

/** Every account an order list names: payers and account recipients. */
export function orderAccounts(os: readonly Pick<OrderView, "payer" | "request">[]): string[] {
  const all = os.flatMap((o) => [
    ...(o.payer ? [o.payer] : []),
    ...(o.request.recipient.kind === "account" ? [o.request.recipient.address] : []),
  ]);
  return [...new Set(all)];
}

export interface OrderLineView {
  title: string;
  option: string | null;
  quantity: number;
  slot: string | null;
  chosen: string | null;
}

export function orderLines(o: Pick<OrderView, "request" | "records" | "token">): OrderLineView[] {
  return o.request.lines.map((l) => {
    const def = o.records.find((r) => r.body.id === l.productId)?.body;
    return {
      title: def?.title ?? "A product that is no longer listed",
      option: l.versionId
        ? (def?.versions.find((v) => v.id === l.versionId)?.name ?? "An option no longer offered")
        : null,
      quantity: l.quantity,
      slot: l.slot,
      chosen: l.chosen ? formatAmount(l.chosen, o.token) : null,
    };
  });
}

/** What QoreChain shows the buyer paid so far: the deposit (or whole order) and, for commissions, the rest. */
export function paidSoFar(o: Pick<OrderView, "status" | "dueNow" | "dueLater" | "depositTx" | "balanceTx">): bigint {
  if (!o.depositTx) return 0n;
  return BigInt(o.dueNow) + (o.balanceTx ? BigInt(o.dueLater) : 0n);
}

export const canRefund = (o: Pick<OrderView, "payer" | "status" | "refundTx" | "depositTx">) =>
  !!o.payer &&
  !!o.depositTx &&
  !o.refundTx &&
  (o.status === "paid" || o.status === "in_progress" || o.status === "delivered");
export const canAskRest = (o: Pick<OrderView, "status" | "dueLater" | "balanceTx">) =>
  o.status === "in_progress" && BigInt(o.dueLater) > 0n && !o.balanceTx;
export const canDeliver = (o: Pick<OrderView, "status" | "delivery">) => o.status === "paid" && !o.delivery;

// ---- discounts --------------------------------------------------------------------------

export function discountValue(d: Pick<DiscountRow, "percent" | "amountOff" | "token">): string {
  if (d.percent !== null) return `${d.percent}% off`;
  return d.amountOff && d.token ? `${formatAmount(d.amountOff, d.token)} off` : "—";
}

export function discountState(
  d: Pick<DiscountRow, "active" | "expiresAt" | "maxUses" | "uses">,
  now = new Date(),
): { label: string; chip: Chip } {
  if (!d.active) return { label: "Off", chip: "neutral" };
  if (d.expiresAt && new Date(d.expiresAt) < now) return { label: "Expired", chip: "neutral" };
  if (d.maxUses !== null && d.uses >= d.maxUses) return { label: "Used up", chip: "wait" };
  return { label: "Active", chip: "ok" };
}

export const CODE_RE = /^[A-Za-z0-9_-]{3,40}$/;

export function codeProblem(code: string, others: string[]): string | null {
  const c = code.trim();
  if (!c) return "Give the code a name, like SPRING20.";
  if (!CODE_RE.test(c)) return "Use 3 to 40 letters, numbers, dashes or underscores.";
  if (others.includes(c.toUpperCase())) return `You already have a code ${c.toUpperCase()}.`;
  return null;
}

/** Content blocks that hold something a buyer gets (an empty text block does not). */
export const hasContent = (c: Content) =>
  c.pages.some((p) => p.blocks.some((b) => (b.t === "text" ? b.text.trim() : true)));

export function move<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const next = [...list];
  const [x] = next.splice(from, 1);
  if (x === undefined) return list;
  next.splice(to, 0, x);
  return next;
}

/** Problems in the content page that would stop it sealing (on top of the engine's publish checks). */
export function contentProblems(c: Content): string[] {
  const out: string[] = [];
  c.pages.forEach((p, i) => {
    const where = c.pages.length > 1 ? `Page ${i + 1}: ` : "";
    for (const b of p.blocks) {
      if (b.t === "link") {
        let ok: boolean;
        try {
          const u = new URL(b.url);
          ok = (u.protocol === "https:" || u.protocol === "http:") && !!u.hostname;
        } catch {
          ok = false;
        }
        if (!ok) out.push(`${where}a link needs a full address, starting with https://`);
      }
    }
  });
  return [...new Set(out)];
}

/** Every problem that stops publishing, in the order a seller would fix them. */
export function allProblems(engine: string[], d: Pick<ProductDraft, "def" | "content">): string[] {
  const extra = [...contentProblems(d.content)];
  if (d.def.kind === "call" && d.def.booking) extra.push(...hoursProblems(d.def.booking.hours, d.def.booking.minutes));
  if (d.def.versions.some((v) => !v.name.trim())) extra.push("Name every version.");
  if (d.def.details.some((x) => !x.k.trim())) extra.push("Name every detail in What's included, or remove it.");
  return [...new Set([...engine, ...extra])];
}
