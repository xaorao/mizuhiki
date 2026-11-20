import type { Metadata } from "next";
import { Landing } from "@/landing/Landing";

export const metadata: Metadata = {
  title: { absolute: "Mizuhiki · one link for everything private" },
  description:
    "Get paid, receive files, collect forms and sell from one page. Everything people send is sealed on their device with post-quantum keys before it leaves, so only you can open it.",
};

export default function Page() {
  return <Landing />;
}
