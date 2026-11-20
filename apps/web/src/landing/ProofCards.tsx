"use client";
/**
 * Proof (spec 5.1 section 12): real transactions of the demo account @aria
 * and a CapsuleVault check-in on the QoreChain test network. Each card reads
 * its transaction from QoreChain in the visitor's browser (block, result) and
 * links to the explorer; the text never claims more than the chain shows.
 */
import { useEffect, useState } from "react";
import { chainRest, explorerTx } from "@mizuhiki/chain";
import { Icon } from "@mizuhiki/ui";
import s from "./landing.module.css";

interface Proof {
  label: string;
  title: string;
  detail: string;
  hash: string;
}

/** Verified with the QoreChain MCP (get_transaction, get_pq_status) when recorded. */
export const PROOFS: Proof[] = [
  {
    label: "Signing key registered for @aria",
    title: "ML-DSA-87",
    detail: "The post-quantum key that signs @aria's page, now on QoreChain.",
    hash: "0821042CA8C9B4F860B2A0509ABB9AD9C68F0B0ED45C699DD5017765DFE72928",
  },
  {
    label: "Sealing key registered, hybrid-signed",
    title: "ML-KEM-1024",
    detail: "The key visitors seal to. The transaction carries a verified ML-DSA-87 signature.",
    hash: "FB32F67622C7F7B37CDD58FB068341AAD092856387FCD02716A7063AA3BC95DE",
  },
  {
    label: "Page name claimed on MizuhikiRegistry",
    title: "@aria",
    detail: "The name points to the account and its key card, for any browser to check.",
    hash: "A0F0603CC6741E2CEED20C6097E2D9F9243AD0A658150D5DE9DDC59F290A6BCA",
  },
  {
    label: "Capsule check-in, checked by a contract",
    title: "CapsuleVault",
    detail: "An owner's check-in, authorised by an ML-DSA-87 signature the contract verified.",
    hash: "7A3EEC123F59CD3E89B0D8501216EDB7BD85E01A06E91172B07AE4FC92F205AF",
  },
];

type Live =
  { state: "loading" } | { state: "ok"; height: string; time: string } | { state: "failed" } | { state: "offline" };

function useTx(hash: string): Live {
  const [live, setLive] = useState<Live>({ state: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    fetch(`${chainRest()}/cosmos/tx/v1beta1/txs/${hash}`, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { tx_response?: { height: string; code: number; timestamp: string } };
        const t = j.tx_response;
        if (!t) throw new Error("missing");
        setLive(t.code === 0 ? { state: "ok", height: t.height, time: t.timestamp } : { state: "failed" });
      })
      .catch(() => {
        if (!ctl.signal.aborted) setLive({ state: "offline" });
      });
    return () => ctl.abort();
  }, [hash]);
  return live;
}

function Card({ p }: { p: Proof }) {
  const live = useTx(p.hash);
  return (
    <a className={s.pf2} href={explorerTx(p.hash)} target="_blank" rel="noreferrer">
      <small>{p.label}</small>
      <b>{p.title}</b>
      <span className={s.pfDetail}>{p.detail}</span>
      <span className={s.pfLive} data-state={live.state}>
        {live.state === "loading" ? (
          "Reading QoreChain…"
        ) : live.state === "ok" ? (
          <>
            <Icon name="check" size={14} /> Confirmed in block {Number(live.height).toLocaleString("en-US")}
          </>
        ) : live.state === "failed" ? (
          "QoreChain reports this transaction failed"
        ) : (
          "Could not reach QoreChain just now. Open it on the explorer."
        )}
      </span>
      <code>
        tx {p.hash.slice(0, 16)}… <Icon name="share" size={12} />
      </code>
    </a>
  );
}

export function ProofCards() {
  return (
    <div className={s.proof}>
      {PROOFS.map((p) => (
        <Card key={p.hash} p={p} />
      ))}
    </div>
  );
}
