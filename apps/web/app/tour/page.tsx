import type { Metadata } from "next";
import { Tour } from "@/tour/Tour";

export const metadata: Metadata = {
  title: "Every feature, screen by screen · Mizuhiki",
  description:
    "Mizuhiki at work on the QoreChain test network: sealed messages, payments, a shop, invoices, forms, rooms, passes, capsules and proofs, one screen at a time.",
};

export default function Page() {
  return <Tour />;
}
