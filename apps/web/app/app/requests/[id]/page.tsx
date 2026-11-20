import type { Metadata } from "next";
import { RequestDetail } from "@/requests/RequestDetail";

export const metadata: Metadata = { title: "File request" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <RequestDetail id={id} />;
}
