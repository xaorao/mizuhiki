"use client";
/** Receipt (Gumroad 3.3): the button text (max 26) and a custom message; the preview pane shows the receipt live. */
import { Panel, TextArea, TextField } from "@mizuhiki/ui";
import type { EditorProps } from "./editorTypes";
import { ReceiptPreview } from "./ProductPreview";
import s from "./seller.module.css";

export function ReceiptTab({ draft, patch, name, displayName }: EditorProps) {
  const r = draft.def.receipt;
  return (
    <div className={s.tabStack}>
      <Panel title="Receipt" kicker="りょうしゅう">
        <div className={s.stack}>
          <TextField
            label="Button text"
            value={r.button}
            maxLength={26}
            counter
            onChange={(e) => patch({ receipt: { ...r, button: e.target.value.slice(0, 26) } }, "rb")}
            onBlur={() => !r.button.trim() && patch({ receipt: { ...r, button: "View content" } })}
            error={r.button.trim() ? undefined : "Give the button a few words, like View content."}
            hint="The button on the receipt and the product page that opens what they bought."
          />
          <TextArea
            label="Custom message"
            value={r.message}
            maxLength={1000}
            counter
            rows={5}
            placeholder="Add any extra information you would like on the receipt."
            onChange={(e) => patch({ receipt: { ...r, message: e.target.value } }, "rm")}
            hint="Public, like the product page. Put anything private in Content."
          />
        </div>
      </Panel>
      <div className={s.onlyPhone}>
        <ReceiptPreview def={draft.def} name={name} displayName={displayName} />
      </div>
    </div>
  );
}
