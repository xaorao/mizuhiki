import type { Metadata } from "next";
import { CheckDocument } from "@/proof/CheckDocument";

export const metadata: Metadata = {
  title: "Check a document · Mizuhiki",
  description:
    "See whether a document was anchored on QoreChain. The file is checked on your device and never uploaded.",
};

export default function Page() {
  return <CheckDocument />;
}
