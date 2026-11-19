import type { Metadata } from "next";
import { LibraryPage } from "@/shop/buyer/LibraryPage";

export const metadata: Metadata = { title: "Library", robots: { index: false } };

export default function Page() {
  return <LibraryPage />;
}
