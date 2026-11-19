import type { Metadata } from "next";
import { OfflineReader } from "@/recovery/OfflineReader";

export const metadata: Metadata = { title: "Read with an offline key" };

export default function Page() {
  return <OfflineReader />;
}
