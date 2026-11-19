import { PassDetail } from "@/passes/PassDetail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <PassDetail id={id} />;
}
