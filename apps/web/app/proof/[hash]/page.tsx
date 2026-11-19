import type { Metadata } from "next";
import { Certificate } from "@/proof/Certificate";

interface Props {
  params: Promise<{ hash: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { hash } = await params;
  return {
    title: "Proof of existence · Mizuhiki",
    description: `Certificate for the document fingerprint ${hash.slice(0, 12)}…, read live from QoreChain.`,
    robots: { index: false },
  };
}

export default async function Page({ params }: Props) {
  const { hash } = await params;
  return <Certificate hash={hash.toLowerCase()} />;
}
