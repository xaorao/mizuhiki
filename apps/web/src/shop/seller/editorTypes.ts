/** What every tab of the product editor receives. */
import type { ProductDef } from "@mizuhiki/core";
import type { OwnerProduct, Tokened } from "../engine";
import type { EditorDraft } from "./model";

export interface EditorProps {
  draft: EditorDraft;
  /** Change the working copy. The same `coalesce` key within ~1 s is one undo step (typing). */
  update: (fn: (d: EditorDraft) => EditorDraft, coalesce?: string) => void;
  /** Shorthand: patch the product record being edited. */
  /** Merge into the latest product. Pass a function when the change depends on it (after an await, say). */
  patch: (p: Partial<ProductDef> | ((def: ProductDef) => Partial<ProductDef>), coalesce?: string) => void;
  tokened: () => Promise<Tokened>;
  /** The owner's @name, without @. */
  name: string;
  displayName: string;
  row: OwnerProduct;
  /** The server refused the link (another product of yours uses it). */
  slugError: string | null;
  /** Publish now; resolves true when it went live. */
  publish: () => Promise<boolean>;
  publishing: boolean;
}
