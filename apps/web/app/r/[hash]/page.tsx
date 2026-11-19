import type { Metadata } from "next";
import { SnapshotView } from "@/forms/results/SnapshotView";

export const metadata: Metadata = {
  title: "Results snapshot",
  description: "A shared snapshot of form results. It opens on your device with the key in your link.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function Page({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  return <SnapshotView hash={hash} />;
}
