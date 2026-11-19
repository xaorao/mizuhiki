import type { Metadata } from "next";
import { RecoverPage } from "@/recovery/RecoverPage";

export const metadata: Metadata = { title: "Recover with your contacts" };

export default function Page() {
  return <RecoverPage />;
}
