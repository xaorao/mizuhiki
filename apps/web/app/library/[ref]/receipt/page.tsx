import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReceiptPage } from "@/shop/buyer/ReceiptPage";

export const metadata: Metadata = { title: "Receipt", robots: { index: false } };

type Props = { params: Promise<{ ref: string }> };

export default async function Page({ params }: Props) {
  const { ref } = await params;
  if (!/^[A-Za-z0-9_-]{22}$/.test(ref)) notFound();
  return <ReceiptPage orderRef={ref} />;
}
