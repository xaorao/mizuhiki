import type { Metadata } from "next";
import { DesignSystem } from "./DesignSystem";

export const metadata: Metadata = { title: "Design system", robots: { index: false } };

export default function Page() {
  return <DesignSystem />;
}
