"use client";
/**
 * Products (Gumroad's products table): Name with thumbnail and link, Sales,
 * Revenue, Price, Status, a totals row and a row menu. Names come from the
 * working copy sealed to the owner, so drafts read right too.
 */
import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button, ButtonLink, EmptyState, Oops, Skeleton, StatusChip, useToast } from "@mizuhiki/ui";
import { formatAmount, KIND_INFO } from "@mizuhiki/core";
import { useOwner } from "@/owner/OwnerProvider";
import { SITE_URL } from "@/lib/site";
import { deleteProduct, setProductStatus } from "../engine";
import { priceLabel, productPath, sumByToken } from "./model";
import { useProducts, type ProductRow } from "./useProducts";
import { Confirm, RowMenu, Thumb } from "./bits";
import s from "./seller.module.css";
import { failureText } from "@/lib/failure";

export function ProductsTab() {
  const { rows, error, reload, tokened } = useProducts();
  const owner = useOwner();
  const router = useRouter();
  const toast = useToast();
  const name = owner.published?.name ?? owner.draft?.manifest.name ?? "";
  const [busy, setBusy] = useState<string | null>(null);
  const [del, setDel] = useState<ProductRow | null>(null);
  const [delError, setDelError] = useState<string | null>(null);

  const status = async (r: ProductRow, to: "published" | "unpublished") => {
    setBusy(r.p.id);
    try {
      await setProductStatus(await tokened(), r.p.id, to);
      toast.show(
        to === "published"
          ? "Published. The link is live again."
          : "Unpublished. The link now says it is not available.",
      );
      await reload();
    } catch (e) {
      toast.show(failureText(e, "That did not work. Nothing changed."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!del) return;
    setBusy(del.p.id);
    setDelError(null);
    try {
      await deleteProduct(await tokened(), del.p.id);
      toast.show("Product deleted");
      setDel(null);
      await reload();
    } catch (e) {
      setDelError(failureText(e, "It was not deleted. Nothing changed."));
    } finally {
      setBusy(null);
    }
  };

  const copy = (link: string) =>
    navigator.clipboard.writeText(link).then(
      () => toast.show("Link copied and ready to share"),
      () => toast.show("Copy is not allowed here. Open the product and copy the address.", { tone: "error" }),
    );

  if (error)
    return (
      <Oops
        title="Not loaded"
        action={
          <Button variant="line" icon="undo" onClick={() => void reload()}>
            Try again
          </Button>
        }
      >
        {error}
      </Oops>
    );
  if (!rows)
    return (
      <div className={s.tableWrap} aria-busy="true">
        <div className={s.skelRows}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} lines={1} avatar />
          ))}
        </div>
      </div>
    );
  if (rows.length === 0)
    return (
      <div className={s.emptyWrap}>
        <EmptyState
          title="We've never met an idea we didn't like."
          face="normal"
          jp="がんばって"
          action={
            <ButtonLink href="/app/shop/new" variant="cord" icon="plus">
              New product
            </ButtonLink>
          }
        >
          Your first product does not need to be perfect. Put it out there and see if it sticks. Every buyer gets their
          own sealed copy.
        </EmptyState>
      </div>
    );

  const totals = {
    sales: rows.reduce((n, r) => n + r.p.sales, 0),
    revenue: sumByToken(
      rows.filter((r) => r.def).map((r) => ({ amount: r.p.revenue, token: r.def?.price.token ?? "fUSD" })),
    ),
  };

  return (
    <>
      <div className={s.tableWrap}>
        <table className={s.table}>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col" className={s.num}>
                Sales
              </th>
              <th scope="col" className={s.num}>
                Revenue
              </th>
              <th scope="col" className={s.num}>
                Price
              </th>
              <th scope="col">Status</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className={s.stagger}>
            {rows.map((r) => {
              const def = r.def;
              const link = name && def ? `${SITE_URL}${productPath(name, r.p.slug)}` : null;
              const live = r.p.status === "published";
              return (
                <tr key={r.p.id}>
                  <td>
                    <div className={s.nameCell}>
                      {def ? <Thumb def={def} /> : null}
                      <span className={s.nameText}>
                        <Link href={`/app/shop/${r.p.id}`} className={s.rowLink}>
                          {def?.title || "A product that does not open here"}
                        </Link>
                        <small>
                          {def ? KIND_INFO[def.kind].label : "Its working copy is sealed to another key"}
                          {link && live ? (
                            <>
                              {" · "}
                              <a href={link} target="_blank" rel="noopener" className={s.subLink}>
                                {productPath(name, r.p.slug)}
                              </a>
                            </>
                          ) : null}
                        </small>
                      </span>
                    </div>
                  </td>
                  <td className={s.num} data-label="Sales">
                    {r.p.sales}
                  </td>
                  <td className={s.num} data-label="Revenue">
                    {def ? formatAmount(r.p.revenue, def.price.token) : "—"}
                  </td>
                  <td className={s.num} data-label="Price">
                    {def ? priceLabel(def) : "—"}
                  </td>
                  <td data-label="Status">
                    {r.p.status === "published" ? (
                      r.changed ? (
                        <StatusChip status="wait">Changes not published</StatusChip>
                      ) : (
                        <StatusChip status="ok">Published</StatusChip>
                      )
                    ) : r.p.status === "unpublished" ? (
                      <StatusChip status="neutral">Unpublished</StatusChip>
                    ) : (
                      <StatusChip status="neutral">Draft</StatusChip>
                    )}
                  </td>
                  <td className={s.menuCell}>
                    <RowMenu
                      label={`Actions for ${def?.title ?? "this product"}`}
                      items={[
                        { label: "Edit", icon: "pen", onSelect: () => router.push(`/app/shop/${r.p.id}`) },
                        ...(link && live
                          ? [{ label: "Copy link", icon: "link" as const, onSelect: () => void copy(link) }]
                          : []),
                        ...(r.p.status === "published"
                          ? [
                              {
                                label: "Unpublish",
                                icon: "eye" as const,
                                disabled: busy === r.p.id,
                                onSelect: () => void status(r, "unpublished"),
                              },
                            ]
                          : r.p.record
                            ? [
                                {
                                  label: "Publish",
                                  icon: "send" as const,
                                  disabled: busy === r.p.id,
                                  onSelect: () => void status(r, "published"),
                                },
                              ]
                            : [
                                {
                                  label: "Publish from the editor",
                                  icon: "send" as const,
                                  onSelect: () => router.push(`/app/shop/${r.p.id}`),
                                },
                              ]),
                        {
                          label: "Delete",
                          icon: "trash",
                          danger: true,
                          onSelect: () => (setDelError(null), setDel(r)),
                        },
                      ]}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Totals</th>
              <td className={s.num} data-label="Sales">
                {totals.sales}
              </td>
              <td className={s.num} data-label="Revenue">
                {totals.revenue}
              </td>
              <td colSpan={3} />
            </tr>
          </tfoot>
        </table>
      </div>
      <p className={s.footNote}>
        Revenue counts paid and delivered orders, read from QoreChain. Money lands in your wallet straight away; there
        is no payout to wait for.
      </p>
      <Confirm
        open={del !== null}
        title="Delete this product?"
        confirm="Delete"
        busy={busy === del?.p.id}
        onClose={() => setDel(null)}
        onConfirm={() => void remove()}
      >
        <p>
          &ldquo;{del?.def?.title ?? "This product"}&rdquo; and its sealed working copy are removed from Mizuhiki. If
          anyone bought it, it cannot be deleted; unpublish it instead so buyers keep their copies.
        </p>
        {delError ? <Oops title="Not deleted">{delError}</Oops> : null}
      </Confirm>
    </>
  );
}
