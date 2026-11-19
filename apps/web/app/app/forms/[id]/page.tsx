import { Suspense } from "react";
import { FormEditor } from "@/forms/FormEditor";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // The editor reads ?tab= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense>
      <FormEditor id={id} />
    </Suspense>
  );
}
