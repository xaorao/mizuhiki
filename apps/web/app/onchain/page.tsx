import type { Metadata } from "next";
import { OnChain } from "@/onchain/OnChain";

export const metadata: Metadata = {
  title: "Proof on QoreChain · Mizuhiki",
  description:
    "Mizuhiki's contracts, post-quantum keys and signatures, read from the QoreChain test network by your browser.",
};

export default function Page() {
  return <OnChain />;
}
