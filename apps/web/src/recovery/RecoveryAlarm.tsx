"use client";
/**
 * The cancel alert (spec 5.13, QoreX): on every owner screen, a recovery of
 * this account that the owner did not start as a test is shown until it ends,
 * with a way to cancel it.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@mizuhiki/ui";
import { useOwner } from "@/owner/OwnerProvider";
import { loadMine, strangerRequests } from "./engine";
import { useRecoveryEvents } from "./useRecoveryEvents";
import s from "./recovery.module.css";

export function RecoveryAlarm() {
  const owner = useOwner();
  const [n, setN] = useState(0);
  const check = useCallback(async () => {
    try {
      setN(strangerRequests(await loadMine({ ...owner.account, token: await owner.token() })).length);
    } catch {
      // A failed check shows nothing new; the Spare key page shows the same list with its own errors.
    }
  }, [owner]);
  useEffect(() => {
    void check();
  }, [check]);
  useRecoveryEvents(() => void check());
  if (n === 0) return null;
  return (
    <div className={s.bar} role="alert">
      <Icon name="alert" size={18} />
      <span>
        <b>Someone is recovering your account on another device.</b> If it isn&rsquo;t you, cancel it now.
      </span>
      <Link href="/app/spare-key">Review and cancel</Link>
    </div>
  );
}
