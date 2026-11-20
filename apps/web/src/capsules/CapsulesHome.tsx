"use client";
/**
 * Capsules (spec 5.14): yours, the ones you guard, and the ones waiting for
 * you. States come from CapsuleVault and its clock: Armed, Request pending,
 * Opens now, Released, Expired, Cancelled.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Avatar,
  Button,
  EmptyState,
  Icon,
  Kicker,
  LockLine,
  Oops,
  Sheet,
  Skeleton,
  StatusChip,
  Tabs,
  useToast,
  type Status,
} from "@mizuhiki/ui";
import { durationText, planSentences, type FileFacts } from "@mizuhiki/core";
import type { CapsuleOnChain } from "@mizuhiki/chain";
import { useOwnerSession } from "@/owner/OwnerProvider";
import { nameOf, safetyWords } from "@/rooms/engine";
import { FileItem } from "@/inbox/Detail";
import {
  acceptGuarding,
  capsulesForMe,
  chainNow,
  chainState,
  declineGuarding,
  finalize,
  guardedCapsules,
  openCapsule,
  ownedCapsules,
  phaseOf,
  requestRelease,
  type CapsuleForMe,
  type GuardedCapsule,
  type Opened,
  type OwnedCapsule,
  type Phase,
  type Tokened,
} from "./engine";
import { useCapsuleEvents } from "./useCapsuleEvents";
import p from "@/passes/passes.module.css";
import s from "./capsules.module.css";
import { failureText } from "@/lib/failure";

type Tab = "mine" | "guard" | "for-me";
export const PHASE_CHIP: Record<Phase | "draft", { status: Status; label: string }> = {
  draft: { status: "neutral", label: "Draft" },
  none: { status: "neutral", label: "Not on chain" },
  armed: { status: "ok", label: "Armed" },
  requested: { status: "wait", label: "Request pending" },
  due: { status: "info", label: "Opens now" },
  released: { status: "info", label: "Released" },
  expired: { status: "neutral", label: "Expired" },
  cancelled: { status: "danger", label: "Cancelled" },
};
export const when = (sec: bigint | number) =>
  new Date(Number(sec) * 1000).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
/** "in 3 days" / "in 2 h 5 min", from the chain's clock. */
export function countdown(to: bigint, now: bigint): string {
  const s = Number(to - now);
  if (s <= 0) return "now";
  if (s >= 2 * 86400) return `in ${Math.floor(s / 86400)} days`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `in ${h} h ${m} min` : `in ${Math.max(1, m)} min`;
}

export interface Live {
  chain: CapsuleOnChain;
  now: bigint;
}

export function CapsulesHome() {
  const owner = useOwnerSession();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const q = params.get("tab");
  const [tab, setTabState] = useState<Tab>(q === "guard" || q === "for-me" ? q : "mine");
  const [mine, setMine] = useState<OwnedCapsule[] | null>(null);
  const [guard, setGuard] = useState<GuardedCapsule[] | null>(null);
  const [forMe, setForMe] = useState<CapsuleForMe[] | null>(null);
  const [live, setLive] = useState<Record<string, Live>>({});
  const [names, setNames] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);

  const tokened = useCallback(
    async (): Promise<Tokened> => ({ ...owner.account, token: await owner.token() }),
    [owner],
  );
  const load = useCallback(async () => {
    try {
      const t = await tokened();
      const [m, g, f] = await Promise.all([ownedCapsules(t), guardedCapsules(t), capsulesForMe(t)]);
      setMine(m);
      setGuard(g);
      setForMe(f);
      setError(null);
      const armed = [
        ...m.filter((c) => c.state !== "draft").map((c) => c.id),
        ...g.filter((c) => c.state !== "draft").map((c) => c.id),
        ...f.map((c) => c.id),
      ];
      const now = await chainNow();
      const states = await Promise.all(
        [...new Set(armed)].map(async (id) => [id, { chain: await chainState(id), now }] as const),
      );
      setLive(Object.fromEntries(states));
      const who = [...new Set([...g.map((c) => c.owner), ...f.map((c) => c.owner)])];
      setNames(
        Object.fromEntries(await Promise.all(who.map(async (a) => [a, await nameOf(a).catch(() => null)] as const))),
      );
    } catch (e) {
      setError(failureText(e, "Your capsules could not be loaded. Nothing changed."));
    }
  }, [tokened]);
  useEffect(() => {
    void load();
  }, [load]);
  useCapsuleEvents(() => void load());

  const setTab = (t: Tab) => {
    setTabState(t);
    router.replace(t === "mine" ? path : `${path}?tab=${t}`, { scroll: false });
  };
  const label = (a: string) => (names[a] ? `@${names[a]}` : `${a.slice(0, 10)}…`);
  const guardBadge = (guard ?? []).filter((c) => c.status === "invited").length;
  const forMeBadge = (forMe ?? []).filter((c) => {
    const l = live[c.id];
    return l && phaseOf(l.chain, l.now) === "released";
  }).length;

  return (
    <div className={p.page}>
      <header className={p.top}>
        <div className={p.titleBlock}>
          <Kicker>たいむかぷせる</Kicker>
          <h1>Capsules</h1>
          <p className={p.lede}>
            Sealed files and words that open for the right people at the right time: on a date, for family after a wait
            you can stop, or if you go quiet.
          </p>
        </div>
        <Link href="/app/capsules/new" className={s.newLink}>
          <Icon name="plus" size={20} /> New capsule
        </Link>
      </header>
      <Tabs
        label="Capsules"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "mine", label: "Yours" },
          { value: "guard", label: "You guard", badge: guardBadge || undefined },
          { value: "for-me", label: "For you", badge: forMeBadge || undefined },
        ]}
      />
      <div className={p.body} key={tab}>
        {error ? (
          <Oops
            title="Not loaded"
            action={
              <Button variant="line" icon="undo" onClick={() => void load()}>
                Try again
              </Button>
            }
          >
            {error}
          </Oops>
        ) : mine === null || guard === null || forMe === null ? (
          <Skeleton lines={4} />
        ) : tab === "mine" ? (
          <MineList list={mine} live={live} />
        ) : tab === "guard" ? (
          <GuardList list={guard} live={live} label={label} tokened={tokened} reload={load} />
        ) : (
          <ForMeList list={forMe} live={live} label={label} tokened={tokened} reload={load} />
        )}
      </div>
    </div>
  );
}

function phaseLine(l: Live | undefined, mode: string | undefined): string {
  if (!l) return "";
  const ph = phaseOf(l.chain, l.now);
  if (ph === "armed" && l.chain.opensAt) return `Opens ${countdown(l.chain.opensAt, l.now)} · ${when(l.chain.opensAt)}`;
  if (ph === "armed" && mode === "after-wait")
    return `Waits ${durationText(Number(l.chain.waitSeconds))} after a guardian asks`;
  if (ph === "requested") return `Requested · opens ${countdown(l.chain.opensAt, l.now)} unless rejected`;
  if (ph === "due") return "The time has come. It opens when someone records it.";
  if (ph === "released")
    return `Released ${when(l.chain.releasedAt)} · collect until ${when(l.chain.releasedAt + l.chain.accessSeconds)}`;
  if (ph === "expired") return `The time to collect ended ${when(l.chain.releasedAt + l.chain.accessSeconds)}`;
  return "";
}

function MineList({ list, live }: { list: OwnedCapsule[]; live: Record<string, Live> }) {
  if (list.length === 0)
    return (
      <div className={p.emptyWrap}>
        <EmptyState
          title="No capsules yet"
          face="normal"
          jp="みらいへ"
          action={
            <Link href="/app/capsules/new" className={s.newLink}>
              <Icon name="plus" size={20} /> New capsule
            </Link>
          }
        >
          Leave files and a message for someone, opened on a date, after a wait you can stop, or if you stop checking
          in.
        </EmptyState>
      </div>
    );
  return (
    <ul className={p.list}>
      {list.map((c) => {
        const l = live[c.id];
        const ph: Phase | "draft" =
          c.state === "draft" ? "draft" : c.state === "cancelled" ? "cancelled" : l ? phaseOf(l.chain, l.now) : "armed";
        const chip = PHASE_CHIP[ph];
        const waiting = c.guardians.filter((g) => g.status === "accepted").length;
        return (
          <li key={c.id}>
            <Link href={`/app/capsules/${c.id}`} className={p.item}>
              <span className={s.capIcon} aria-hidden="true">
                <Icon name="hour" size={22} />
              </span>
              <span className={p.itemText}>
                <b>{c.label}</b>
                <small>
                  {c.state === "draft"
                    ? waiting
                      ? `${waiting} ${waiting === 1 ? "guardian is" : "guardians are"} waiting for your words check`
                      : `${c.guardians.length} ${c.guardians.length === 1 ? "guardian" : "guardians"} · not armed yet`
                    : phaseLine(l, c.plan?.body.mode) || `${c.plan?.body.recipients.length ?? 0} recipients`}
                </small>
              </span>
              <span className={p.itemEnd}>
                <StatusChip status={chip.status}>{chip.label}</StatusChip>
                <Icon name="chev" size={18} />
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function GuardList({
  list,
  live,
  label,
  tokened,
  reload,
}: {
  list: GuardedCapsule[];
  live: Record<string, Live>;
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const owner = useOwnerSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [myWords, setMyWords] = useState<string | null>(null);
  const [asking, setAsking] = useState<GuardedCapsule | null>(null);
  useEffect(() => {
    if (!list.some((c) => c.status === "accepted")) return;
    const life = { alive: true };
    safetyWords(owner.account.owner.address)
      .then((w) => life.alive && setMyWords(w))
      .catch(() => life.alive && setMyWords(""));
    return () => {
      life.alive = false;
    };
  }, [list, owner.account.owner.address]);
  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      toast.show(ok);
      await reload();
    } catch (e) {
      toast.show(failureText(e, "That did not work. Nothing changed."), {
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };
  if (list.length === 0)
    return (
      <div className={p.emptyWrap}>
        <EmptyState title="You guard no capsules" face="sleepy" jp="まだだよ">
          When someone asks you to keep a piece of a capsule&rsquo;s key, it shows here.
        </EmptyState>
      </div>
    );
  return (
    <>
      <ul className={p.list}>
        {list.map((c) => {
          const l = live[c.id];
          const ph: Phase | "draft" =
            c.state === "cancelled"
              ? "cancelled"
              : c.state === "draft"
                ? "draft"
                : l
                  ? phaseOf(l.chain, l.now)
                  : "armed";
          const mode = c.plan?.body.mode;
          const handed = c.plan ? c.released.filter((r) => r.version === c.plan?.body.version).length : 0;
          return (
            <li key={c.id} className={s.row}>
              <Avatar name={label(c.owner).replace("@", "")} size={40} tone="butter" />
              <span className={p.itemText}>
                <b>{c.label}</b>
                <small>
                  From {label(c.owner)} ·{" "}
                  {c.status === "invited"
                    ? "Asks you to keep a piece of its key."
                    : c.status === "accepted"
                      ? "Accepted. They will compare your safety words with you."
                      : c.status === "declined"
                        ? "You said no."
                        : ph === "released"
                          ? `${handed} of ${c.plan?.body.recipients.length ?? 0} recipients have your piece`
                          : phaseLine(l, mode) || "Your piece is sealed. Alone it opens nothing."}
                </small>
              </span>
              <span className={p.itemEnd}>
                {c.status === "invited" ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      busy={busy === `d${c.id}`}
                      onClick={() =>
                        void act(
                          `d${c.id}`,
                          async () => declineGuarding(await tokened(), c.id),
                          "Declined. They were told.",
                        )
                      }
                    >
                      Decline
                    </Button>
                    <Button
                      size="sm"
                      variant="cord"
                      icon="check"
                      busy={busy === `a${c.id}`}
                      onClick={() =>
                        void act(
                          `a${c.id}`,
                          async () => acceptGuarding(await tokened(), c),
                          `Accepted. ${label(c.owner)} will compare safety words with you.`,
                        )
                      }
                    >
                      Accept
                    </Button>
                  </>
                ) : c.status === "confirmed" && ph === "armed" && mode === "after-wait" ? (
                  <Button size="sm" variant="line" icon="key" onClick={() => setAsking(c)}>
                    Request access
                  </Button>
                ) : (
                  <StatusChip status={PHASE_CHIP[ph].status}>
                    {c.status === "declined" ? "Declined" : PHASE_CHIP[ph].label}
                  </StatusChip>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {myWords !== null ? (
        <section className={p.panel}>
          <h2>Your safety words</h2>
          <p>Read these to the person who asked you. They confirm you only if every word matches.</p>
          {myWords ? (
            <ul className={p.words} aria-label="Your safety words">
              {myWords.split(" ").map((w, i) => (
                <li key={`${w}${i}`}>{w}</li>
              ))}
            </ul>
          ) : (
            <Oops title="Your key could not be read">Check your connection and reload.</Oops>
          )}
        </section>
      ) : null}
      <LockLine>
        When a capsule opens, your device hands your piece to each recipient by itself while Mizuhiki is open. It checks
        the plan against QoreChain first.
      </LockLine>
      {asking ? (
        <Sheet open onClose={() => setAsking(null)} title={`Request ${asking.label}`} dismissable={busy !== "req"}>
          <div className={p.form}>
            <p>
              Asking starts a {durationText(Number(live[asking.id]?.chain.waitSeconds ?? 0))} wait recorded on
              QoreChain. {label(asking.owner)} is told and can say no or open it at once. If they do nothing, it opens
              when the wait ends.
            </p>
            <div className={p.actions}>
              <Button variant="quiet" onClick={() => setAsking(null)} disabled={busy === "req"}>
                Not now
              </Button>
              <Button
                variant="cord"
                icon="key"
                busy={busy === "req"}
                onClick={() =>
                  void act(
                    "req",
                    () => requestRelease(owner.account, asking.id),
                    "Requested. The wait has started on QoreChain.",
                  ).then(() => setAsking(null))
                }
              >
                {busy === "req" ? "Signing on QoreChain" : "Request access"}
              </Button>
            </div>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}

function ForMeList({
  list,
  live,
  label,
  tokened,
  reload,
}: {
  list: CapsuleForMe[];
  live: Record<string, Live>;
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const owner = useOwnerSession();
  const toast = useToast();
  const [opened, setOpened] = useState<{ c: CapsuleForMe; o: Opened } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (list.length === 0)
    return (
      <div className={p.emptyWrap}>
        <EmptyState title="Nothing waiting for you" face="sleepy" jp="まだだよ">
          When someone names you in a capsule, it shows here with when it opens.
        </EmptyState>
      </div>
    );
  const open = async (c: CapsuleForMe) => {
    setBusy(c.id);
    try {
      const l = live[c.id];
      if (l && phaseOf(l.chain, l.now) === "due") await finalize(owner.account, c.id);
      setOpened({ c, o: await openCapsule(await tokened(), c) });
    } catch (e) {
      toast.show(failureText(e, "It could not be opened yet."), { tone: "error" });
      await reload();
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <ul className={p.list}>
        {list.map((c) => {
          const l = live[c.id];
          const ph: Phase = c.state === "cancelled" ? "cancelled" : l ? phaseOf(l.chain, l.now) : "armed";
          const plan = c.plan.body;
          const have = c.pieces.filter((x) => x.version === plan.version).length;
          const can = ph === "released" || ph === "due";
          return (
            <li key={c.id} className={s.row}>
              <span className={s.capIcon} aria-hidden="true">
                <Icon name="hour" size={22} />
              </span>
              <span className={p.itemText}>
                <b>{c.label}</b>
                <small>
                  From {label(c.owner)} ·{" "}
                  {ph === "released"
                    ? `${have} of ${plan.threshold} guardian ${plan.threshold === 1 ? "piece" : "pieces"} here`
                    : phaseLine(l, plan.mode) || "Sealed until it opens"}
                </small>
              </span>
              <span className={p.itemEnd}>
                {can ? (
                  <Button size="sm" variant="cord" icon="key" busy={busy === c.id} onClick={() => void open(c)}>
                    Open
                  </Button>
                ) : (
                  <StatusChip status={PHASE_CHIP[ph].status}>{PHASE_CHIP[ph].label}</StatusChip>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {opened ? (
        <Sheet open onClose={() => setOpened(null)} title={opened.c.label} wide>
          <div className={s.opened}>
            <Kicker>ひらいた</Kicker>
            <p className={s.from}>From {label(opened.o.from)}</p>
            {opened.o.message ? <p className={s.message}>{opened.o.message}</p> : null}
            {opened.o.files.length ? (
              <ul className={p.files}>
                {opened.o.files.map((f: FileFacts) => (
                  <FileItem key={f.fileId} f={f} />
                ))}
              </ul>
            ) : null}
            <ul className={s.sentences}>
              {planSentences({
                ...opened.c.plan.body,
                guardians: opened.c.plan.body.guardians.map(label),
                recipients: ["you"],
              })
                .slice(2, 3)
                .map((x) => (
                  <li key={x}>{x}</li>
                ))}
            </ul>
            <LockLine>Opened on this device with pieces only you could rebuild. Mizuhiki held sealed copies.</LockLine>
          </div>
        </Sheet>
      ) : null}
    </>
  );
}
