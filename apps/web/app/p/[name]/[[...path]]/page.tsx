import type { Metadata } from "next";
import { normalizeNameInput } from "@mizuhiki/core";
import { lookupPage } from "@/lib/server-api";
import { SITE_URL, pageUrl } from "@/lib/site";
import { PublicPage, PageUnavailable } from "@/public/PublicPage";
import { parseDeepLink } from "@/public/deeplink";

type Props = { params: Promise<{ name: string; path?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { name: raw } = await params;
  const name = normalizeNameInput(decodeURIComponent(raw));
  const page = await lookupPage(name);
  if (page.state !== "ok") return { title: "Page not available", robots: { index: false } };
  const m = page.record.body;
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

export default async function Page({ params }: Props) {
  const { name: raw, path } = await params;
  const name = normalizeNameInput(decodeURIComponent(raw));
  const page = await lookupPage(name);
  if (page.state !== "ok") return <PageUnavailable state={page.state} message={page.message} name={name} />;
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
