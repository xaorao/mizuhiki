import { Suspense } from "react";
import { SpareKeyHome } from "@/recovery/SpareKeyHome";

export default function Page() {
  // The tabs read ?tab= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense>
      <SpareKeyHome />
    </Suspense>
  );
}
