"use client";
/** The share step right after Send (Dropbox's pattern): link, QR, and "Send to @name" for Mizuhiki payers. */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Button, CopyValue, Icon, Oops, Sheet, useToast } from "@mizuhiki/ui";
import type { Account } from "@/account/AccountProvider";
import { numberLabel, type PrivateCopy } from "./model";
import { notifyPayer } from "./useInvoices";
import s from "./invoices.module.css";

export function ShareSheet({
  account,
  copy,
  link,
  onClose,
  reminder = false,
}: {
  account: Account;
  copy: PrivateCopy;
  link: string;
  onClose: () => void;
  reminder?: boolean;
}) {
  const toast = useToast();
  const [qr, setQr] = useState<string | null>(null);
  const [sent, setSent] = useState<"idle" | "busy" | "done" | "failed">("idle");
  const doc = copy.doc;
  useEffect(() => {
    void QRCode.toDataURL(link, { margin: 1, width: 440, errorCorrectionLevel: "M" }).then(setQr, () => setQr(null));
  }, [link]);

  const notify = async () => {
    setSent("busy");
    try {
      await notifyPayer(account, copy, reminder);
      setSent("done");
      toast.show(reminder ? "Reminder sent, sealed" : "Sent to their inbox, sealed");
    } catch {
      setSent("failed");
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title={reminder ? `Remind about ${numberLabel(doc.number)}` : `Invoice ${numberLabel(doc.number)} is ready`}
    >
      <div className={s.share}>
        <p className={s.warnLine}>
          <Icon name="link" size={15} /> Anyone with this link can read this invoice. The key is in the link itself;
          Mizuhiki never sees it.
        </p>
        <CopyValue
          value={link}
          label="Invoice link"
          onCopied={(ok) =>
            toast.show(ok ? "Link copied and ready to share" : "Copy is not allowed here", ok ? {} : { tone: "error" })
          }
        />
        {qr ? <img className={s.qr} src={qr} alt={`QR code for invoice ${numberLabel(doc.number)}`} /> : null}
        {doc.billTo.address && doc.billTo.kind !== "link" ? (
          <>
            <Button
              variant="cord"
              icon="send"
              full
              busy={sent === "busy"}
              disabled={sent === "done"}
              onClick={() => void notify()}
            >
              {sent === "done"
                ? "Sent"
                : `${reminder ? "Send a reminder to" : "Send to"} ${doc.billTo.name ? `@${doc.billTo.name}` : "their Mizuhiki inbox"}`}
            </Button>
            {sent === "failed" ? (
              <Oops title="Not delivered">
                They may not have Mizuhiki set up. Share the link instead. Nothing else changed.
              </Oops>
            ) : null}
          </>
        ) : null}
        <Button variant="ghost" full onClick={onClose}>
          Done
        </Button>
      </div>
    </Sheet>
  );
}
