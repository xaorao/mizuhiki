import type { Metadata } from "next";
import { Login } from "@/account/Login";

export const metadata: Metadata = { title: "Log in" };

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return <Login next={typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/app"} />;
}
