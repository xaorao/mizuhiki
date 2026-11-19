import type { Metadata } from "next";
import { JoinPage } from "@/rooms/invite/JoinPage";

export const metadata: Metadata = {
  title: "Room invite",
  description: "An invite to a private Mizuhiki room. It opens on your device with the key in your link.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <JoinPage id={id} />;
}
