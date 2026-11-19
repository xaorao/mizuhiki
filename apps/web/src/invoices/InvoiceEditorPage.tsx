"use client";
/** Loads a draft (or starts a new invoice) and hands it to the editor. Sent invoices open in the list. */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Oops, Skeleton } from "@mizuhiki/ui";
import { useAccount } from "@/account/AccountProvider";
import { useOwner } from "@/owner/OwnerProvider";
import { useInvoices } from "./useInvoices";
import { InvoiceEditor } from "./InvoiceEditor";
import s from "./invoices.module.css";

export function InvoiceEditorPage({ id }: { id: string }) {
  const acct = useAccount();
  const owner = useOwner();
  const router = useRouter();
  const account = acct.account;
  if (!account) throw new Error("Invoices need an unlocked account");
  const inv = useInvoices(account, owner.token);
  const found = inv.items?.find((i) => i.rec.id === id);
  useEffect(() => {
    if (found && found.rec.state !== "draft") router.replace("/app/invoices");
  }, [found, router]);
  const m = owner.draft?.manifest;
  if (inv.error)
    return (
      <div className={s.listPage}>
        <Oops title="Not loaded">{inv.error}</Oops>
      </div>
    );
  if (inv.items === null || !m)
    return (
      <div className={s.listPage}>
        <Skeleton lines={6} />
      </div>
    );
  if (id !== "new" && !found)
    return (
      <div className={s.listPage}>
        <Oops title="No such draft">It may have been sent or deleted. Nothing changed.</Oops>
      </div>
    );
  if (found && !found.copy)
    return (
      <div className={s.listPage}>
        <Oops title="Not opened">{found.error}</Oops>
      </div>
    );
  return (
    <InvoiceEditor
      account={account}
      token={owner.token}
      owner={{ name: m.name || null, displayName: m.displayName }}
      initial={found?.copy ?? null}
      nextNumber={inv.nextNumber()}
    />
  );
}
