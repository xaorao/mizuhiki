import { Suspense } from "react";
import { ShopHome } from "@/shop/seller/ShopHome";

export default function Page() {
  // The tabs read ?tab= with useSearchParams, which needs a Suspense boundary.
  return (
    <Suspense>
      <ShopHome />
    </Suspense>
  );
}
