/** What every tab of the form editor receives (Build, Logic, Settings, Share, Results). */
import type { FormDef } from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";

export interface TabProps {
  /** The working copy (autosaved sealed to the owner). */
  def: FormDef;
  /** Change the working copy. Same `coalesce` key within ~1 s = one undo step (typing). */
  update: (fn: (d: FormDef) => FormDef, coalesce?: string) => void;
  account: Account;
  /** Signed-in API session token (Bearer). */
  token: () => Promise<string>;
  /** The last published definition, or null if never published. */
  published: FormDef | null;
  /** The owner's @name (without @). */
  ownerName: string;
  /** Publish the working copy now (signs and uploads); resolves to the published definition. */
  publish: () => Promise<FormDef | null>;
}
