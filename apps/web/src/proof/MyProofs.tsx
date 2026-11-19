"use client";
/** The owner's proofs: anchor any document from this device, and every anchor you made, with its certificate. */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Chip, EmptyState, Icon, Oops, Panel, Skeleton } from "@mizuhiki/ui";
import { useAccount } from "@/account/AccountProvider";
import { useOwner } from "@/owner/OwnerProvider";
import { api, ApiFailure } from "@/lib/api";
import { HashDrop, type Hashed } from "./HashDrop";
import { ProveSheet } from "./ProveSheet";
import { certificatePath, readLabels, type ProofLabel } from "./proof";
import { fmtBytes } from "@/public/MessageSheet";
import s from "./proof.module.css";

interface ProofRow {
  contentHash: string;
  kind: string;
  txHash: string;
  block: string;
  at: string | null;
}

export function MyProofs() {
  const acct = useAccount();
  const owner = useOwner();
  const account = acct.account;
  if (!account) throw new Error("Proofs need an unlocked account");
  const [rows, setRows] = useState<ProofRow[] | null>(null);
  const [labels, setLabels] = useState<Record<string, ProofLabel>>({});
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Hashed | null>(null);

  const load = useCallback(async () => {
    try {
      const t = await owner.token();
      const [r, l] = await Promise.all([
        api.get<{ proofs: ProofRow[] }>(`/proofs?by=${account.owner.address}`),
        readLabels(account, t),
      ]);
      setRows(r.proofs);
      setLabels(l);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Your proofs could not be loaded. Nothing changed.");
    }
  }, [account, owner]);

  useEffect(() => {
    void load();
  }, [load]);

  // The indexer picks the new anchor up within seconds; poll briefly after anchoring.
  const refreshSoon = () => {
    let n = 0;
    const tick = () => {
      n++;
      void load();
      if (n < 6) setTimeout(tick, 3000);
    };
    setTimeout(tick, 1500);
  };

  return (
    <div className={s.page}>
      <header className={s.top}>
        <h1>Proofs</h1>
        <Chip icon="lock" tone="white">
          Only fingerprints go on chain
        </Chip>
      </header>
      <Panel title="Prove a document existed" kicker="The file never leaves this device">
        <HashDrop label="Drop a file, or tap to pick one" onHashed={setTarget} />
      </Panel>
      <Panel title="Your anchors">
        {error ? (
          <Oops title="Not loaded" action={<button onClick={() => void load()}>Try again</button>}>
            {error}
          </Oops>
        ) : rows === null ? (
          <Skeleton lines={3} />
        ) : rows.length === 0 ? (
          <EmptyState title="No proofs yet" face="sleepy">
            Anchor a contract, a design or an invoice above. You can also do it from any file in your inbox.
          </EmptyState>
        ) : (
          <ul className={s.list}>
            {rows.map((r) => {
              const l = labels[r.contentHash];
              return (
                <li key={r.contentHash}>
                  <Link href={certificatePath(r.contentHash)} className={s.item} target="_blank">
                    <span className={s.itemIcon}>
                      <Icon name="check" size={18} />
                    </span>
                    <span className={s.itemText}>
                      <b>{l ? l.name : "Unlabelled document"}</b>
                      <small>
                        {[l ? fmtBytes(l.size) : "", l?.note ?? "", `${r.contentHash.slice(0, 12)}…`]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </span>
                    <span className={s.itemWhen}>
                      {r.at
                        ? new Date(r.at).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })
                        : `Block ${r.block}`}
                      <Icon name="arrow" size={14} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {target ? (
        <ProveSheet account={account} target={target} onClose={() => setTarget(null)} onDone={refreshSoon} />
      ) : null}
    </div>
  );
}
