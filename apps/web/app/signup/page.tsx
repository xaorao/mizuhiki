import type { Metadata } from "next";
import { Onboarding } from "@/onboarding/Onboarding";

export const metadata: Metadata = { title: "Claim your page" };

export default async function Page({ searchParams }: { searchParams: Promise<{ name?: string; next?: string }> }) {
  const { name, next } = await searchParams;
  return (
    <Onboarding
      initialName={typeof name === "string" ? name : ""}
      next={typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : undefined}
    />
  );
}
