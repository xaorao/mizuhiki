"use client";
/**
 * The seller's Shop (spec 5.11): Gumroad's Products table, every sale with
 * its delivery state, and discount codes, under one set of tabs.
 */
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ButtonLink, Chip, Kicker, Tabs } from "@mizuhiki/ui";
import { useOwner } from "@/owner/OwnerProvider";
import { listSales, withToken } from "../engine";
import { canDeliver } from "./model";
import { useOutcomes } from "./delivery";
import { ProductsTab } from "./ProductsTab";
import { SalesTab } from "./SalesTab";
import { DiscountsTab } from "./DiscountsTab";
import s from "./seller.module.css";

type Tab = "products" | "sales" | "discounts";
const isTab = (t: string | null): t is Tab => t === "products" || t === "sales" || t === "discounts";

export function ShopHome() {
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const q = params.get("tab");
  const [tab, setTabState] = useState<Tab>(isTab(q) ? q : "products");
  const [waiting, setWaiting] = useState(0);
  const owner = useOwner();
  const outcomes = useOutcomes();
  // The Sales badge: paid orders not sealed yet (refreshed after every delivery pass).
  useEffect(() => {
    let alive = true;
    void owner
      .token()
      .then((t) => listSales(withToken(owner.account, t)))
      .then((os) => alive && setWaiting(os.filter(canDeliver).length))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [owner, outcomes]);
  const setTab = (t: Tab) => {
    setTabState(t);
    router.replace(t === "products" ? path : `${path}?tab=${t}`, { scroll: false });
  };
  return (
    <div className={s.page}>
      <header className={s.top}>
        <div className={s.titleBlock}>
          <Kicker>おみせ</Kicker>
          <h1>Shop</h1>
        </div>
        <Chip icon="lock" tone="white">
          Each buyer gets their own sealed copy
        </Chip>
        <ButtonLink href="/app/shop/new" variant="cord" icon="plus" className={s.newBtn}>
          New product
        </ButtonLink>
      </header>
      <Tabs
        label="Shop sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "products", label: "Products" },
          { value: "sales", label: "Sales", badge: waiting || undefined },
          { value: "discounts", label: "Discounts" },
        ]}
      />
      <div className={s.tabBody}>
        {tab === "products" ? <ProductsTab /> : null}
        {tab === "sales" ? <SalesTab onWaiting={setWaiting} /> : null}
        {tab === "discounts" ? <DiscountsTab /> : null}
      </div>
    </div>
  );
}
