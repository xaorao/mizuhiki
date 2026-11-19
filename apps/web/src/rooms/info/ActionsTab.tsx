"use client";
/**
 * Recent actions (Telegram's admin log, open to every member here because the
 * log is part of why the room can be trusted): who added, removed, changed
 * roles or settings, with the QoreChain record behind each key change.
 */
import type { CSSProperties } from "react";
import { EmptyState, Icon } from "@mizuhiki/ui";
import { explorerTx } from "@mizuhiki/chain";
import type { ActionEntry } from "../derive";
import { pillString } from "../people";
import { whenLabel } from "./model";
import s from "./info.module.css";

export function ActionsTab({
  actions,
  names,
  me,
}: {
  actions: ActionEntry[];
  names: Record<string, string | null>;
  me: string;
}) {
  if (actions.length === 0)
    return (
      <EmptyState title="Nothing has changed yet" face="sleepy">
        Who joins, leaves, is removed or becomes an admin is listed here, with the QoreChain record behind every room
        key change.
      </EmptyState>
    );
  return (
    <>
      <p className={s.help}>
        Signed by the person who made each change and checked on this device. Key changes link to their record on
        QoreChain.
      </p>
      <ol className={s.log}>
        {actions.map((a, i) => (
          <li
            key={`${a.key}:${i}`}
            className={a.txHash ? s.keyed : undefined}
            style={{ "--i": Math.min(i, 14) } as CSSProperties}
          >
            <p className={s.logText}>{pillString(a.text, names, me)}</p>
            <p className={s.logMeta}>
              <time dateTime={a.at}>{whenLabel(a.at)}</time>
              <span>Key {a.epoch}</span>
              {a.txHash ? (
                <a className={s.chainLink} href={explorerTx(a.txHash)} target="_blank" rel="noopener noreferrer">
                  <Icon name="link" size={14} />
                  On chain
                  <span className="sr-only"> (opens the QoreChain explorer)</span>
                </a>
              ) : null}
            </p>
          </li>
        ))}
      </ol>
    </>
  );
}
