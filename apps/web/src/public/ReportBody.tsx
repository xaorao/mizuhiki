"use client";
/** Report a public page (spec 5.16): a reason, optional words, sent to us. Used on the page and in Legal. */
import { useState } from "react";
import { Button, TextArea, useToast } from "@mizuhiki/ui";
import { api } from "@/lib/api";
import s from "./public.module.css";

const REASONS = [
  { id: "impersonation", label: "Pretending to be someone else" },
  { id: "scam", label: "A scam or fraud" },
  { id: "abuse", label: "Harassment or hate" },
  { id: "illegal", label: "Something illegal" },
  { id: "other", label: "Something else" },
] as const;

export function ReportBody({ name, onDone }: { name: string; onDone: () => void }) {
  const toast = useToast();
  const [reason, setReason] = useState<(typeof REASONS)[number]["id"] | null>(null);
  const [detail, setDetail] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className={s.report}
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason) return;
        setBusy(true);
        api
          .post("/reports", { name, reason, detail })
          .then(() => {
            toast.show("Thank you. We will look at this page.");
            onDone();
          })
          .catch(() => toast.show("The report was not sent. Try again.", { tone: "error" }))
          .finally(() => setBusy(false));
      }}
    >
      <p>
        Tell us what is wrong with @{name}. Sealed items cannot be read by anyone at Mizuhiki; we can only take down the
        public page.
      </p>
      <div role="radiogroup" aria-label="Reason" className={s.reasons}>
        {REASONS.map((r) => (
          <button key={r.id} type="button" role="radio" aria-checked={reason === r.id} onClick={() => setReason(r.id)}>
            {r.label}
          </button>
        ))}
      </div>
      <TextArea
        label="Anything else (optional)"
        value={detail}
        maxLength={1000}
        counter
        onChange={(e) => setDetail(e.target.value)}
      />
      <Button type="submit" variant="cord" full busy={busy} disabled={!reason}>
        Send report
      </Button>
    </form>
  );
}
