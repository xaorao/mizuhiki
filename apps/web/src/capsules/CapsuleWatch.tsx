"use client";
/**
 * Runs while the dashboard is open (spec 5.14): as a guardian, hand pieces to
 * recipients of capsules QoreChain has released (after checking each plan
 * against the chain); as an owner, show a check-in bar when an "if I go quiet"
 * capsule is within its warning time.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Icon, useToast } from "@mizuhiki/ui";
import { warnLeadSeconds } from "@mizuhiki/core";
import { useOwnerSession } from "@/owner/OwnerProvider";
import {
  READ_CONCURRENCY,
  chainNow,
  chainState,
  checkIn,
  guardedCapsules,
  guardianPass,
  mapLimited,
  ownedCapsules,
} from "./engine";
import { useCapsuleEvents } from "./useCapsuleEvents";
import s from "./capsules.module.css";
import { failureText } from "@/lib/failure";

export function CapsuleWatch() {
  const owner = useOwnerSession();
  const toast = useToast();
  const [quiet, setQuiet] = useState<{ opensAt: bigint } | null>(null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const pass = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      const t = { ...owner.account, token: await owner.token() };
      await guardianPass(t, await guardedCapsules(t), {
        onHanded: (_id, n) =>
          toast.show(
            `Your capsule ${n === 1 ? "piece was" : "pieces were"} handed to ${n === 1 ? "its recipient" : "their recipients"}.`,
          ),
      });
      const mine = (await ownedCapsules(t)).filter((c) => c.state === "armed" && c.plan?.body.mode === "if-quiet");
      let soonest: { opensAt: bigint } | null = null;
      if (mine.length) {
        const now = await chainNow();
        const states = await mapLimited(mine, READ_CONCURRENCY, (c) => chainState(c.id));
        for (const chain of states) {
          if ((chain.status !== "armed" && chain.status !== "requested") || chain.opensAt === 0n) continue;
          if (
            Number(chain.opensAt - now) < warnLeadSeconds(Number(chain.quietSeconds)) &&
            (!soonest || chain.opensAt < soonest.opensAt)
          )
            soonest = { opensAt: chain.opensAt };
        }
      }
      setQuiet(soonest);
    } catch {
      // Tried again on the next tick or event; the Capsules page shows errors.
    } finally {
      running.current = false;
    }
  }, [owner, toast]);
  useEffect(() => {
    void pass();
    const h = setInterval(() => void pass(), 60_000);
    return () => clearInterval(h);
  }, [pass]);
  useCapsuleEvents(() => void pass());

  if (!quiet) return null;
  const days = Math.max(0, Math.ceil(Number(quiet.opensAt - BigInt(Math.floor(Date.now() / 1000))) / 86400));
  return (
    <div className={s.bar} role="status">
      <Icon name="hour" size={18} />
      <span>
        <b>Check in.</b> A capsule opens in {days} {days === 1 ? "day" : "days"} if you stay quiet.{" "}
        <Link href="/app/capsules">See capsules</Link>
      </span>
      <Button
        size="sm"
        variant="cord"
        icon="check"
        busy={busy}
        onClick={() => {
          setBusy(true);
          void checkIn(owner.account)
            .then(() => {
              toast.show("Checked in. The quiet clock starts again.");
              setQuiet(null);
            })
            .catch((e: unknown) => toast.show(failureText(e, "Not checked in."), { tone: "error" }))
            .finally(() => setBusy(false));
        }}
      >
        I&rsquo;m here
      </Button>
    </div>
  );
}
