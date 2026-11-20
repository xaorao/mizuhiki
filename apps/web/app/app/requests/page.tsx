import type { Metadata } from "next";
import { RequestsHome } from "@/requests/RequestsHome";

export const metadata: Metadata = { title: "File requests" };

export default function Page() {
  return <RequestsHome />;
}
