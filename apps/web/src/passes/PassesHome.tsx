"use client";
/**
 * Passes (spec 5.12): scoped, read-only access for an accountant or auditor.
 * Two lists, like QuickBooks' Manage users › Accountants and Bitwarden's
 * "Trusted emergency contacts" / "Designated as emergency contact": passes you
 * gave, and passes given to you.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Avatar, Button, Chip, EmptyState, Icon, Kicker, Oops, Skeleton, StatusChip, Tabs } from "@mizuhiki/ui";
import { useOwner } from "@/owner/OwnerProvider";
import { ApiFailure } from "@/lib/api";
import { nameOf } from "@/rooms/engine";
import { heldPasses, ownedPasses, type PassView } from "./engine";
import { chipOf, scopeLine } from "./model";
import { NewPassSheet } from "./NewPassSheet";
import { usePassEvents } from "./usePassEvents";
import s from "./passes.module.css";

type Tab = "given" | "mine";

export function PassesHome() {
  const owner = useOwner();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const [tab, setTabState] = useState<Tab>(params.get("tab") === "mine" ? "mine" : "given");
  const [given, setGiven] = useState<PassView[] | null>(null);
  const [mine, setMine] = useState<PassView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preset = params.get("new") === "room" && params.get("id") ? { what: "room" as const, id: params.get("id") ?? "" } : null;
  const [creating, setCreating] = useState(preset !== null);
  const [names, setNames] = useState<Record<string, string | null>>({});

  const load = useCallback(async () => {
    try {
      const t = { ...owner.account, token: await owner.token() };
      const [g, m] = await Promise.all([ownedPasses(t), heldPasses(t)]);
      setGiven(g.passes);
      setMine(m);
      setError(null);
      const who = [...new Set([...g.passes.map((p) => p.holder), ...m.map((p) => p.owner)])];
      const found = await Promise.all(who.map(async (a) => [a, await nameOf(a).catch(() => null)] as const));
      setNames(Object.fromEntries(found));
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Your passes could not be loaded. Nothing changed.");
    }
  }, [owner]);
  useEffect(() => {
    void load();
  }, [load]);
  usePassEvents(() => void load());

  const setTab = (t: Tab) => {
    setTabState(t);
    router.replace(t === "given" ? path : `${path}?tab=${t}`, { scroll: false });
  };
  const waitingForMe = (mine ?? []).filter((p) => p.status === "invited").length;
  const toConfirm = (given ?? []).filter((p) => p.status === "accepted").length;
  const label = (a: string) => (names[a] ? `@${names[a]}` : `${a.slice(0, 10)}…${a.slice(-4)}`);

  const list = tab === "given" ? given : mine;
  return (
    <div className={s.page}>
      <header className={s.top}>
        <div className={s.titleBlock}>
          <Kicker>あいかぎ</Kicker>
          <h1>Passes</h1>
          <p className={s.lede}>Give an accountant one quarter, not everything. Each pass reads only what it says, and you can revoke it any time.</p>
        </div>
        <Button variant="cord" icon="plus" className={s.newBtn} onClick={() => setCreating(true)}>
          New pass
        </Button>
      </header>
      <Tabs
        label="Passes"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "given", label: "Shared by me", badge: toConfirm || undefined },
          { value: "mine", label: "Shared with me", badge: waitingForMe || undefined },
        ]}
      />
      <div className={s.body} key={tab}>
        {error ? (
          <Oops title="Not loaded" action={<Button variant="line" icon="undo" onClick={() => void load()}>Try again</Button>}>
            {error}
          </Oops>
        ) : list === null ? (
          <Skeleton lines={3} />
        ) : list.length === 0 ? (
          <div className={s.emptyWrap}>
            {tab === "given" ? (
              <EmptyState
                title="No passes yet"
                face="normal"
                jp="ひとつだけ"
                action={
                  <Button variant="cord" icon="plus" onClick={() => setCreating(true)}>
                    New pass
                  </Button>
                }
              >
                A pass lets one person read one period, one room, one form or one product. They cannot change anything.
              </EmptyState>
            ) : (
              <EmptyState title="Nothing shared with you" face="sleepy" jp="まだだよ">
                When someone gives you a pass, it shows here for you to accept.
              </EmptyState>
            )}
          </div>
        ) : (
          <ul className={s.list}>
            {list.map((p) => {
              const other = tab === "given" ? p.holder : p.owner;
              const chip = chipOf(p, tab === "given" ? "owner" : "holder");
              return (
                <li key={p.id}>
                  <Link href={`/app/passes/${p.id}`} className={s.item}>
                    <Avatar name={names[other] ?? other.slice(4, 6)} size={44} tone={tab === "given" ? "matcha" : "sora"} />
                    <span className={s.itemText}>
                      <b>
                        {tab === "given" ? label(other) : `From ${label(other)}`}
                      </b>
                      <small>
                        {scopeLine(p.invite.body.scope)} · made {new Date(p.createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                      </small>
                    </span>
                    <span className={s.itemEnd}>
                      {tab === "given" && p.status === "active" && p.resealed ? <Chip tone="white" icon="lock">{p.resealed} copied</Chip> : null}
                      <StatusChip status={chip.status}>{chip.label}</StatusChip>
                      <Icon name="chev" size={18} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <NewPassSheet
        open={creating}
        preset={preset}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          router.push(`/app/passes/${p.id}`);
        }}
      />
    </div>
  );
}
