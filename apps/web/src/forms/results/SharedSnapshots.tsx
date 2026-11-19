"use client";
/**
 * The owner's shared snapshots of this form: when each was made, Copy link
 * (the link key comes from the owner's sealed "formsnaps" note, so it works on
 * any of the owner's devices) and Delete with an inline confirm.
 */
import { useState } from "react";
import { Button, ButtonLink, Icon, Panel, Skeleton, useToast } from "@mizuhiki/ui";
import { localStamp } from "./aggregate";
import { snapshotLink, type SeedMap, type SnapshotRow } from "./snapshot";
import s from "../results.module.css";

function Row({
  row,
  seed,
  onDelete,
}: {
  row: SnapshotRow;
  seed: string | undefined;
  onDelete: (hash: string) => Promise<void>;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const link = seed ? snapshotLink(row.hash, row.formId, seed) : null;
  const copy = () => {
    if (!link) return;
    navigator.clipboard.writeText(link).then(
      () => toast.show("Link copied. Anyone with it can read this snapshot.", { tone: "ok" }),
      () => toast.show("Copy did not work. Open the snapshot and copy the address bar.", { tone: "error" }),
    );
  };
  const remove = async () => {
    setBusy(true);
    setFailure(null);
    try {
      await onDelete(row.hash);
    } catch {
      setFailure("It could not be deleted. The link still works; try again.");
      setBusy(false);
    }
  };
  return (
    <li className={s.snapRow}>
      <span className={s.snapIcon}>
        <Icon name="link" size={18} />
      </span>
      <span className={s.snapText}>
        <b>{row.title || "Untitled form"}</b>
        <small>
          Shared {localStamp(row.createdAt)} · <code className={s.mono}>{row.hash.slice(0, 10)}…</code>
        </small>
      </span>
      {confirm ? (
        <span className={s.snapConfirm} role="group" aria-label="Confirm delete">
          <span>Delete it? The link stops working for everyone.</span>
          <Button variant="ghost" size="sm" onClick={() => setConfirm(false)} disabled={busy}>
            Keep
          </Button>
          <Button variant="danger" size="sm" icon="trash" busy={busy} onClick={() => void remove()}>
            Delete
          </Button>
        </span>
      ) : (
        <span className={s.snapActions}>
          {link ? (
            <>
              <Button variant="line" size="sm" icon="copy" onClick={copy}>
                Copy link
              </Button>
              <ButtonLink variant="ghost" size="sm" icon="eye" href={link} target="_blank" rel="noreferrer">
                Open
              </ButtonLink>
            </>
          ) : (
            <small className={s.note}>Its key is not in your sealed notes, so the link cannot be shown again.</small>
          )}
          <Button variant="ghost" size="sm" icon="trash" onClick={() => setConfirm(true)}>
            Delete
          </Button>
        </span>
      )}
      {failure ? <p className={s.fileErr}>{failure}</p> : null}
    </li>
  );
}

export function SharedSnapshots({
  rows,
  seeds,
  failed,
  onDelete,
}: {
  rows: SnapshotRow[] | null;
  seeds: SeedMap;
  failed: boolean;
  onDelete: (hash: string) => Promise<void>;
}) {
  if (rows && rows.length === 0 && !failed) return null;
  return (
    <Panel
      title="Shared snapshots"
      action={
        <span className={s.blind}>
          <Icon name="shield" size={14} /> Signed by you
        </span>
      }
    >
      {failed ? (
        <p className={s.quiet}>Your shared snapshots could not be listed. Refresh to try again.</p>
      ) : rows === null ? (
        <Skeleton lines={2} />
      ) : (
        <>
          <p className={s.note}>
            Anyone with one of these links can read that snapshot until you delete it. Deleting stops the link at once.
          </p>
          <ul className={s.snapList}>
            {rows.map((r) => (
              <Row key={r.hash} row={r} seed={seeds[r.hash]} onDelete={onDelete} />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}
