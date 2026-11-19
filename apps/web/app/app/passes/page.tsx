import { Suspense } from "react";
import { PassesHome } from "@/passes/PassesHome";

export default function Page() {
  // The tabs read ?tab= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense>
      <PassesHome />
    </Suspense>
  );
}
