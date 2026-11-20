"use client";
/**
 * What a visitor sees when a page, form, request or product could not be checked because QoreChain did not answer
 * (offline, the endpoint down). It is not a mismatch: nothing is wrong with the page, it just cannot be trusted yet,
 * so nothing is shown or sent until the check succeeds.
 */
import { Button, Musubi } from "@mizuhiki/ui";
import s from "./unreachable.module.css";

export function ChainUnreachable({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <div className={s.stage}>
      <div className={s.card} role="alert">
        <Musubi face="sleepy" size={110} />
        <h1>QoreChain could not be reached</h1>
        <p>
          This {what} is checked against QoreChain before anything is shown or sent, and the check could not finish.
          Nothing has left your device. Check your connection, then try again.
        </p>
        <Button variant="cord" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}
