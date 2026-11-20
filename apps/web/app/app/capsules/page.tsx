import { Suspense } from "react";
import { CapsulesHome } from "@/capsules/CapsulesHome";

export default function Page() {
  // The tabs read ?tab= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense>
      <CapsulesHome />
    </Suspense>
  );
}
