import type { Metadata } from "next";
import { Onboarding } from "@/onboarding/Onboarding";

export const metadata: Metadata = { title: "Claim your page" };

export default async function Page({ searchParams }: { searchParams: Promise<{ name?: string }> }) {
  const { name } = await searchParams;
  return <Onboarding initialName={typeof name === "string" ? name : ""} />;
}
