"use client";
/**
 * "Add a reader" on one inbox item (spec 5.8, 5.12): re-seal it, on this
 * device, to someone holding an active pass that covers this kind of item.
 */
import { useEffect, useState } from "react";
import { Button, ChoiceCard, EmptyState, LockLine, Sheet, Skeleton, useToast } from "@mizuhiki/ui";
import { nameOf } from "@/rooms/engine";
import type { InboxRow } from "@/inbox/model";
import { addItemToPass, ownedPasses, type PassView, type Tokened } from "./engine";
import { covers, scopeLine } from "./model";
import s from "./passes.module.css";
import { failureText } from "@/lib/failure";

export function AddReaderSheet({
  row,
  tokened,
  onClose,
}: {
  row: InboxRow;
  tokened: () => Promise<Tokened>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [passes, setPasses] = useState<(PassView & { who: string; outside: boolean })[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const life = { alive: true };
    void (async () => {
      try {
        const { passes: all } = await ownedPasses(await tokened());
        const t = Date.parse(row.at);
        const list = await Promise.all(
          all
            .filter((p) => covers(p, row))
            .map(async (p) => {
              const sc = p.invite.body.scope;
              const n = await nameOf(p.holder).catch(() => null);
              const outside = sc.kind === "period" && (t < Date.parse(sc.from) || t >= Date.parse(sc.until));
              return { ...p, who: n ? `@${n}` : `${p.holder.slice(0, 10)}…`, outside };
            }),
        );
        if (life.alive) setPasses(list);
      } catch (e) {
        if (life.alive) setError(failureText(e, "Your passes could not be loaded."));
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [row, tokened]);

  const chosen = passes?.find((p) => p.id === picked) ?? null;
  const add = async () => {
    if (!chosen || !row.envelope) return;
    setBusy(true);
    setError(null);
    try {
      await addItemToPass(await tokened(), chosen, {
        hash: row.envelope,
        kind: row.kind,
        ref: row.ref,
        at: row.at,
        envelope: row.envelope,
      });
      toast.show(`Sealed to ${chosen.who}. They keep it even if the pass ends.`);
      onClose();
    } catch (e) {
      setError(failureText(e, "It was not shared. Nothing changed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="Add a reader" dismissable={!busy}>
      <div className={s.form}>
        {passes === null && !error ? (
          <Skeleton lines={2} />
        ) : passes && passes.length === 0 ? (
          <EmptyState title="No pass covers this" face="normal">
            Make a pass for a period or a form first. Then this item can be sealed to its holder.
          </EmptyState>
        ) : (
          <div className={s.form} role="radiogroup" aria-label="Choose a pass">
            {(passes ?? []).map((p) => (
              <ChoiceCard
                key={p.id}
                selected={picked === p.id}
                onSelect={() => setPicked(p.id)}
                title={p.who}
                detail={`${scopeLine(p.invite.body.scope)}${p.outside ? " · this item is outside its period" : ""}`}
                tone="matcha"
              />
            ))}
          </div>
        )}
        {chosen?.outside ? (
          <p className={s.hint}>
            This item is dated outside the pass&rsquo;s period. Sharing it lets {chosen.who} read this one item as well.
          </p>
        ) : null}
        <LockLine>
          Sealed on this device to their key. Removing the pass later does not take back what they opened.
        </LockLine>
        {error ? (
          <p className={s.err} role="alert">
            {error}
          </p>
        ) : null}
        <div className={s.actions}>
          <Button variant="quiet" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="cord" icon="lock" busy={busy} disabled={!chosen} onClick={() => void add()}>
            {busy ? "Sealing" : "Seal to them"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
