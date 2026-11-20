"use client";
/** The seller's products with their working copies opened on this device. */
import { useCallback, useEffect, useState } from "react";
import type { ProductDef } from "@mizuhiki/core";
import { useOwnerSession } from "@/owner/OwnerProvider";
import { ApiFailure } from "@/lib/api";
import { listMyProducts, openDraft, withToken, type OwnerProduct, type Tokened } from "../engine";
import { fingerprint, type EditorDraft } from "./model";

export interface ProductRow {
  p: OwnerProduct;
  /** The working copy when it opens here, else the published record. */
  def: ProductDef | null;
  draft: EditorDraft | null;
  /** The working copy differs from what buyers see. */
  changed: boolean;
}

export function useProducts() {
  const owner = useOwnerSession();
  const [rows, setRows] = useState<ProductRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokened = useCallback(async (): Promise<Tokened> => withToken(owner.account, await owner.token()), [owner]);

  const reload = useCallback(async () => {
    setError(null);
    try {
      const a = await tokened();
      const list = await listMyProducts(a);
      const opened = await Promise.all(
        list.map(async (p): Promise<ProductRow> => {
          const d: EditorDraft | null = await openDraft(a, p).catch(() => null);
          const def = d?.def ?? p.record?.body ?? null;
          return {
            p,
            def,
            draft: d,
            changed: !!p.record && !!d && d.publishedFp !== undefined && fingerprint(d) !== d.publishedFp,
          };
        }),
      );
      setRows(opened);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Your products could not be loaded. Nothing changed.");
    }
  }, [tokened]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { rows, error, reload, tokened };
}
