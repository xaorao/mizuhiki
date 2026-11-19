import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrderPage } from "@/shop/buyer/OrderPage";

export const metadata: Metadata = { title: "Your purchase", robots: { index: false } };

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<{ pay?: string | string[] }> };

export default async function Page({ params, searchParams }: Props) {
  const { ref } = await params;
  if (!/^[A-Za-z0-9_-]{22}$/.test(ref)) notFound();
  const { pay } = await searchParams;
  return <OrderPage orderRef={ref} manual={pay === "manual"} />;
}
