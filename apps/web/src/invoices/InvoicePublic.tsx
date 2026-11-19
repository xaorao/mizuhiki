"use client";
/**
 * The payer's invoice page (spec 5.6). The key is in the link's fragment, which
 * browsers never send to a server. This page checks the owner's signature over
 * the sealed invoice against the owner's ML-DSA key on QoreChain, opens the
 * invoice here, then offers Pay with amount and reference locked. Paid comes
 * from the chain.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Icon, Musubi, Oops, Skeleton, StatusChip, Wordmark } from "@mizuhiki/ui";
import { verifyRecord, type Block, type Signed } from "@mizuhiki/core";
import { DENOMS, explorerTx, pqKeyViaEvm } from "@mizuhiki/chain";
import { api, ApiFailure } from "@/lib/api";
import { PaySheet } from "@/public/PaySheet";
import { InvoiceView } from "./InvoiceView";
import { numberLabel, openWithLink, paidUnits, parseFragment, statusOf, totals, type InvoiceDoc } from "./model";
import s from "./invoices.module.css";

interface Served {
  id: string;
  owner: string;
  ownerName: string | null;
  envelope: string;
  sig: Signed<{ id: string; envelope: string }>;
  state: "sent" | "cancelled";
  sentAt: string | null;
  payments: { txHash: string; from: string; denom: string; amount: string; at: string }[];
}

type Load =
  { s: "loading" } | { s: "error"; title: string; detail: string } | { s: "ok"; served: Served; doc: InvoiceDoc };

export function InvoicePublic({ id }: { id: string }) {
  const [load, setLoad] = useState<Load>({ s: "loading" });
  const [paying, setPaying] = useState(false);
  const [justPaid, setJustPaid] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const frag = parseFragment(window.location.hash);
      if (!frag) {
        setLoad({
          s: "error",
          title: "This link is missing its key",
          detail:
            "Invoice links carry their key after the # sign. Ask the sender for the full link. Nothing was opened.",
        });
        return;
      }
      try {
        const served = await api.get<Served>(`/invoices/${id}`);
        // Check the owner's signature against their key on chain before trusting anything.
        const pq = await pqKeyViaEvm(served.owner);
        if (!pq.registered || !pq.publicKey || !pq.possessionProven) throw new Error("sig");
        const body = verifyRecord(served.sig, { kind: "invoice", signer: served.owner, pqPublicKey: pq.publicKey });
        if (body.id !== id || body.envelope !== served.envelope) throw new Error("sig");
        const env = await api.bytes(`/blobs/${served.envelope}`);
        const { sha256Hex } = await import("@mizuhiki/core");
        if (sha256Hex(env) !== served.envelope) throw new Error("sig");
        const doc = openWithLink(id, frag.number, frag.seed, env);
        // The money goes to whoever signed it; an invoice naming someone else is refused.
        if (doc.from.address !== served.owner) throw new Error("sig");
        setLoad({ s: "ok", served, doc });
        void api.post(`/invoices/${id}/viewed`, {}).catch(() => undefined);
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 404)
          setLoad({
            s: "error",
            title: "There is no invoice at this link",
            detail: "Check the link with the sender. Nothing was opened.",
          });
        else if ((e as Error).message === "sig")
          setLoad({
            s: "error",
            title: "This invoice could not be verified",
            detail: "It does not match its sender's key on QoreChain, so do not pay it. Nothing was opened.",
          });
        else
          setLoad({
            s: "error",
            title: "This invoice could not be opened",
            detail: "The link's key does not open it, or the network could not be reached. Nothing was paid.",
          });
      }
    })();
  }, [id]);

  const view = useMemo(() => {
    if (load.s !== "ok") return null;
    const payments =
      justPaid && !load.served.payments.some((p) => p.txHash === justPaid)
        ? [
            ...load.served.payments,
            {
              txHash: justPaid,
              from: "",
              denom: DENOMS[load.doc.token].denom,
              amount: totals(load.doc).total.toString(),
              at: new Date().toISOString(),
            },
          ]
        : load.served.payments;
    const status = statusOf(load.doc, {
      state: load.served.state,
      payments,
      recordedPaidAt: null,
      sentAt: load.served.sentAt,
    });
    return { status, payments, total: totals(load.doc).total, paid: paidUnits(load.doc, payments) };
  }, [load, justPaid]);

  return (
    <div className={s.payerStage}>
      <header className={s.payerBar}>
        <Wordmark size={22} href="/" />
      </header>
      <main className={s.payerMain}>
        {load.s === "loading" ? (
          <div className={s.paper}>
            <p className={s.kicker}>Checking the sender&apos;s key on QoreChain and opening the invoice here…</p>
            <Skeleton lines={6} />
          </div>
        ) : load.s === "error" ? (
          <div className={s.paper}>
            <Musubi face="worried" size={110} />
            <h1 className={s.errTitle}>{load.title}</h1>
            <p className={s.muted}>{load.detail}</p>
          </div>
        ) : (
          <>
            <p className={s.warnLine}>
              <Icon name="link" size={15} /> Anyone with this link can read this invoice. It was opened on this device;
              Mizuhiki cannot read it.
            </p>
            <p className={s.verified}>
              <Icon name="shield" size={14} /> Signed by{" "}
              {load.served.ownerName ? `@${load.served.ownerName}` : "its sender"}&apos;s post-quantum key, checked on
              QoreChain just now
            </p>
            <InvoiceView doc={load.doc} status={view?.status} sentAt={load.served.sentAt} />
            {load.served.state === "cancelled" ? (
              <Oops title="This invoice was cancelled">The sender cancelled it. Do not pay it.</Oops>
            ) : view?.status === "paid" ? (
              <div className={s.paidBox}>
                <StatusChip status="ok">Paid on QoreChain</StatusChip>
                {view.payments.map((p) => (
                  <a key={p.txHash} href={explorerTx(p.txHash)} target="_blank" rel="noreferrer" className={s.mono}>
                    {p.txHash.slice(0, 18)}… <Icon name="link" size={13} />
                  </a>
                ))}
              </div>
            ) : (
              <Button variant="cord" size="lg" full icon="coin" onClick={() => setPaying(true)}>
                Pay {numberLabel(load.doc.number)}
              </Button>
            )}
          </>
        )}
      </main>
      {load.s === "ok" ? (
        <PaySheet
          open={paying}
          onClose={() => setPaying(false)}
          block={invoiceBlock(load.doc)}
          owner={{
            name: load.served.ownerName ?? "",
            displayName: load.doc.from.business || load.doc.from.displayName,
            address: load.served.owner,
            card: null,
          }}
          invoice={{
            id,
            number: load.doc.number,
            total: totals(load.doc).total - (view?.paid ?? 0n),
            token: load.doc.token,
          }}
          onPaid={(r) => setJustPaid(r.txHash)}
        />
      ) : null}
    </div>
  );
}

/** The pay settings an invoice implies: its one token, nothing else to choose. */
function invoiceBlock(doc: InvoiceDoc): Extract<Block, { type: "pay" }> {
  return {
    id: `inv-${doc.id}`,
    type: "pay",
    on: true,
    archived: false,
    title: `Invoice ${numberLabel(doc.number)}`,
    subtitle: "",
    tokens: [doc.token],
    presets: [],
    tip: false,
    thanks: "",
  };
}
