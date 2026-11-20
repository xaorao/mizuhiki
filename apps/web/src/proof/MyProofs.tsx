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
import type { AnchorRecord } from "@mizuhiki/chain";
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
  // Anchors made here, read back from QoreChain, shown until the indexer's list includes them.
  const [made, setMade] = useState<ProofRow[]>([]);

  /** Loads the list and labels; returns the anchors the server listed (empty on failure). */
  const load = useCallback(async (): Promise<ProofRow[]> => {
    try {
      const t = await owner.token();
      const [r, l] = await Promise.all([
        api.get<{ proofs: ProofRow[] }>(`/proofs?by=${account.owner.address}`),
        readLabels(account, t),
      ]);
      setRows(r.proofs);
      setLabels(l);
      setError(null);
      return r.proofs;
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Your proofs could not be loaded. Nothing changed.");
      return [];
    }
  }, [account, owner]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown =
    rows === null ? null : [...made.filter((m) => !rows.some((r) => r.contentHash === m.contentHash)), ...rows];

  // Show the new anchor at once from the chain record, then keep loading until the indexer has it too.
  const onAnchored = (r: { record: AnchorRecord; txHash: string | null; note: string }) => {
    const hash = r.record.contentHash.replace(/^0x/, "");
    const row: ProofRow = {
      contentHash: hash,
      kind: r.record.kind,
      txHash: r.txHash ?? "",
      block: r.record.blockNumber.toString(),
      at: r.record.at.toISOString(),
    };
    setMade((m) => [row, ...m.filter((x) => x.contentHash !== hash)]);
    if (target)
      setLabels((l) =>
        hash in l
          ? l
          : {
              ...l,
              [hash]: {
                v: 1,
                hash,
                name: target.file.name,
                size: target.file.size,
                type: target.file.type,
                note: r.note.trim(),
                kind: r.record.kind as ProofLabel["kind"],
              },
            },
      );
    let n = 0;
    const tick = async () => {
      n++;
      const listed = await load();
      if (n < 40 && !listed.some((p) => p.contentHash === hash)) setTimeout(() => void tick(), 3000);
    };
    setTimeout(() => void tick(), 1500);
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
        ) : shown === null ? (
          <Skeleton lines={3} />
        ) : shown.length === 0 ? (
          <EmptyState title="No proofs yet" face="sleepy">
            Anchor a contract, a design or an invoice above. You can also do it from any file in your inbox.
          </EmptyState>
        ) : (
          <ul className={s.list}>
            {shown.map((r) => {
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
        <ProveSheet account={account} target={target} onClose={() => setTarget(null)} onDone={onAnchored} />
      ) : null}
    </div>
  );
}
