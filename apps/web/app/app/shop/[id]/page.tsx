import { Suspense } from "react";
import { ProductEditor } from "@/shop/seller/ProductEditor";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The editor reads ?tab= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense>
      <ProductEditor id={id} />
    </Suspense>
  );
}
