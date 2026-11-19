import { RoomsScreen } from "@/rooms/RoomsScreen";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const { id } = await params;
  const q = await searchParams;
  return <RoomsScreen roomId={id} isNew={q.new === "1"} />;
}
