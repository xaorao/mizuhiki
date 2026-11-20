import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Legal, type LegalDoc } from "@/legal/Legal";

const TITLES: Record<LegalDoc, string> = { privacy: "Privacy", terms: "Terms of use", report: "Report a page" };

export async function generateMetadata({ params }: { params: Promise<{ doc: string }> }): Promise<Metadata> {
  const { doc } = await params;
  return { title: doc in TITLES ? TITLES[doc as LegalDoc] : "Not found" };
}

export default async function Page({ params }: { params: Promise<{ doc: string }> }) {
  const { doc } = await params;
  if (!(doc in TITLES)) notFound();
  return <Legal doc={doc as LegalDoc} />;
}
