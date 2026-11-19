import type { Metadata } from "next";
import { InvoicePublic } from "@/invoices/InvoicePublic";

export const metadata: Metadata = {
  title: "Invoice · Mizuhiki",
  description: "A sealed invoice. It opens on your device with the key in your link.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoicePublic id={id} />;
}
