/**
 * Check-in reminders (spec 5.14, 5.17): for each armed "if I go quiet" capsule, read when it opens from
 * CapsuleVault; inside the warning time (30, 60 or 90 days before, by period), push the owner a
 * "Time to check in" at most once a day.
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { warnLeadSeconds } from "@mizuhiki/core";
import { chainNow, readCapsule } from "@mizuhiki/chain";
import { capsules, type Db } from "@mizuhiki/db";
import type { PushSender } from "./push";

export async function remindCheckIns(db: Db, push: PushSender, now = new Date()): Promise<number> {
  const due = await db
    .select()
    .from(capsules)
    .where(
      and(
        eq(capsules.state, "armed"),
        or(isNull(capsules.remindedAt), lt(capsules.remindedAt, new Date(now.getTime() - 24 * 3600_000))),
      ),
    );
  const quiet = due.filter((c) => (c.plan as { body?: { mode?: string } } | null)?.body?.mode === "if-quiet");
  if (quiet.length === 0) return 0;
  const t = await chainNow();
  const reminded = new Set<string>();
  let sent = 0;
  for (const c of quiet) {
    const chain = await readCapsule(`0x${c.id}`);
    if ((chain.status !== "armed" && chain.status !== "requested") || chain.opensAt === 0n) continue;
    if (Number(chain.opensAt - t) >= warnLeadSeconds(Number(chain.quietSeconds))) continue;
    // One reminder per owner per pass, however many capsules are close.
    if (!reminded.has(c.owner)) {
      sent += await push.send(c.owner, "checkin");
      reminded.add(c.owner);
    }
    await db.update(capsules).set({ remindedAt: now }).where(eq(capsules.id, c.id));
  }
  return sent;
}
