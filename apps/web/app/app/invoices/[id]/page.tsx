import { InvoiceEditorPage } from "@/invoices/InvoiceEditorPage";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <InvoiceEditorPage id={id} />;
}
