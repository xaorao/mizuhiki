import type { Metadata } from "next";
import { normalizeNameInput } from "@mizuhiki/core";
import { lookupFileRequest, lookupForm, lookupPage, lookupProduct } from "@/lib/server-api";
import { verifiedFor } from "@/lib/server-verify";
import { RequestPage } from "@/requests/RequestPage";
import { FormPage } from "@/forms/FormPage";
import { SITE_URL, pageUrl } from "@/lib/site";
import { ProductPage } from "@/shop/buyer/ProductPage";
import { CheckoutPage } from "@/shop/buyer/CheckoutPage";
import { PublicPage, PageUnavailable } from "@/public/PublicPage";
import { parseDeepLink } from "@/public/deeplink";

type Props = {
  params: Promise<{ name: string; path?: string[] }>;
  searchParams?: Promise<{ line?: string | string[] }>;
};

/**
 * Titles and previews use only records that verify against QoreChain (lib/server-verify.ts); anything else gets a
 * plain title and is kept out of search, so changed words never reach a tab or a chat preview.
 */
const UNVERIFIED = (what: string): Metadata => ({
  title: `This ${what} could not be verified`,
  robots: { index: false },
});

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name: raw, path } = await params;
  const name = normalizeNameInput(decodeURIComponent(raw));
  const page = await lookupPage(name);
  if (page.state !== "ok") return { title: "Page not available", robots: { index: false } };
  const link = parseDeepLink(path ?? []);
  if (link.kind === "form") {
    const f = await lookupForm(name, link.slug);
    if (f.state !== "ok") return { title: "Form not available", robots: { index: false } };
    const d = await verifiedFor(name, f.record, "form");
    if (!d) return UNVERIFIED("form");
    const title = d.preview.title || d.title;
    const description =
      d.preview.description ||
      d.description ||
      `A form by @${name}. Answers are encrypted on your device; only @${name} can read them.`;
    return {
      title,
      description,
      openGraph: { title, description, siteName: "Mizuhiki", type: "website" },
      twitter: { card: "summary", title, description },
    };
  }
  if (link.kind === "product") {
    const p = await lookupProduct(name, link.slug);
    if (p.state !== "ok") return { title: "Product not available", robots: { index: false } };
    const d = await verifiedFor(name, p.record, "product");
    if (!d) return UNVERIFIED("product");
    const title = `${d.title} · @${name}`;
    const description =
      d.summary ||
      d.description.replace(/[*[\]()]/g, "").slice(0, 200) ||
      `A product by @${name}, sealed to the buyer after payment.`;
    const cover = d.covers.find((c) => c.type.startsWith("image/")) ?? d.thumbnail;
    const api = (process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");
    const images = cover ? [{ url: `${api}/media/${cover.hash}`, alt: d.title }] : [];
    return {
      title,
      description,
      alternates: { canonical: `${pageUrl(name)}/p/${d.slug}` },
      openGraph: {
        title,
        description,
        url: `${pageUrl(name)}/p/${d.slug}`,
        siteName: "Mizuhiki",
        type: "website",
        images,
      },
      twitter: { card: cover ? "summary_large_image" : "summary", title, description },
    };
  }
  if (link.kind === "checkout") return { title: `Checkout · @${name}`, robots: { index: false } };
  if (link.kind === "request") {
    const r = await lookupFileRequest(link.id);
    if (r.state !== "ok") return { title: "Request not available", robots: { index: false } };
    const req = await verifiedFor(name, r.record, "filerequest");
    if (!req) return UNVERIFIED("request");
    const title = `${req.title} · @${name}`;
    const description = `@${name} is asking for files. Uploads are sealed on your device; only @${name} can open them.`;
    return { title, description, robots: { index: false }, openGraph: { title, description, siteName: "Mizuhiki" } };
  }
  const m = await verifiedFor(name, page.record, "manifest");
  if (!m) return UNVERIFIED("page");
  const title = `${m.displayName} (@${m.name})`;
  const description = m.bio || `Pay ${m.displayName}, or send them a message or a file, sealed on your device.`;
  return {
    title,
    description,
    alternates: { canonical: pageUrl(m.name) },
    // The card is generated per page (app/p/[name]/opengraph-image.tsx); named explicitly so deep links carry it too.
    openGraph: {
      title,
      description,
      url: pageUrl(m.name),
      siteName: "Mizuhiki",
      type: "profile",
      images: [{ url: `${SITE_URL}/p/${m.name}/opengraph-image`, width: 1200, height: 630, alt: title }],
    },
    twitter: { card: "summary_large_image", title, description, images: [`${SITE_URL}/p/${m.name}/opengraph-image`] },
  };
}

export default async function Page({ params, searchParams }: Props) {
  const { name: raw, path } = await params;
  const sp = (await searchParams) ?? {};
  const name = normalizeNameInput(decodeURIComponent(raw));
  const page = await lookupPage(name);
  if (page.state !== "ok") return <PageUnavailable state={page.state} message={page.message} name={name} />;
  const link = parseDeepLink(path ?? []);
  if (link.kind === "form") {
    const f = await lookupForm(name, link.slug);
    if (f.state !== "ok")
      return <PageUnavailable state={f.state === "missing" ? "missing" : "error"} message={f.message} name={name} />;
    return (
      <FormPage
        name={name}
        page={page.record}
        card={page.card}
        owner={page.registry.owner}
        form={f.record}
        closedReason={f.open ? null : f.closedReason}
      />
    );
  }
  if (link.kind === "request") {
    const r = await lookupFileRequest(link.id);
    if (r.state !== "ok")
      return <PageUnavailable state={r.state === "missing" ? "missing" : "error"} message={r.message} name={name} />;
    if (r.record.signer !== page.registry.owner)
      return <PageUnavailable state="missing" message={`This request does not belong to @${name}.`} name={name} />;
    return (
      <RequestPage name={name} page={page.record} card={page.card} owner={page.registry.owner} request={r.record} />
    );
  }
  const m = page.record.body;
  const seller = { displayName: m.displayName, avatar: m.avatar, owner: page.registry.owner };
  if (link.kind === "product") {
    const p = await lookupProduct(name, link.slug);
    if (p.state !== "ok")
      return <PageUnavailable state={p.state === "missing" ? "missing" : "error"} message={p.message} name={name} />;
    const line = typeof sp.line === "string" && /^\d{1,2}$/.test(sp.line) ? Number(sp.line) : undefined;
    return <ProductPage name={name} slug={link.slug} seller={seller} line={line} />;
  }
  if (link.kind === "checkout") return <CheckoutPage name={name} seller={seller} />;
  return (
    <PublicPage
      name={name}
      record={page.record}
      card={page.card}
      registry={page.registry}
      deepLink={parseDeepLink(path ?? [])}
    />
  );
}
