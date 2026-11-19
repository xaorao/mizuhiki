"use client";
/**
 * Runs inside the owner app frame: whenever the dashboard is open (and when an
 * order event arrives), paid orders are sealed to their buyers from this
 * device. Results are said once in a toast; a failure is not repeated while its
 * reason stays the same.
 */
import { useEffect, useRef } from "react";
import { useToast } from "@mizuhiki/ui";
import { useOwner } from "@/owner/OwnerProvider";
import { useDebounced, useRoomEvents } from "@/rooms/useRoom";
import { withToken } from "../engine";
import { deliverNow, summary, useOutcomes, type Outcome } from "./delivery";

export function AutoDeliver() {
  const owner = useOwner();
  const toast = useToast();
  const outcomes = useOutcomes();
  const seen = useRef(new Map<string, Outcome>());

  const run = useDebounced(() => {
    void owner
      .token()
      .then((t) => deliverNow(withToken(owner.account, t)))
      .catch(() => undefined);
  }, 600);

  useEffect(() => {
    run();
    // A live event can be missed (a dropped socket); check again every minute while the dashboard is open.
    const t = setInterval(run, 60_000);
    return () => clearInterval(t);
  }, [run]);
  useRoomEvents((kind) => {
    if (kind === "order") run();
  });

  useEffect(() => {
    const fresh: Outcome[] = [];
    for (const o of outcomes.values()) {
      const before = seen.current.get(o.ref);
      if (before?.at === o.at) continue;
      seen.current.set(o.ref, o);
      if (!o.ok && before && !before.ok && before.why === o.why) continue;
      fresh.push(o);
    }
    const line = summary(fresh);
    if (line) toast.show(line.text, { tone: line.tone, ms: line.tone === "error" ? 9000 : 5000 });
  }, [outcomes, toast]);

  return null;
}
