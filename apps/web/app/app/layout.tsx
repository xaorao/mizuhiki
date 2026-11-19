import type { Metadata } from "next";
import type { ReactNode } from "react";
import { OwnerShell } from "@/owner/OwnerShell";

export const metadata: Metadata = { title: "My page", robots: { index: false } };

export default function Layout({ children }: { children: ReactNode }) {
  return <OwnerShell>{children}</OwnerShell>;
}
