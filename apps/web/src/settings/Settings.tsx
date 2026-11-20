"use client";
/**
 * Settings and account (spec 5.17): profile, names, security, notifications,
 * readers, data, legal and the QoreChain access window, on one page with a
 * section list (Linktree's settings layout, Bitwarden's re-auth before secrets).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Avatar,
  Button,
  ButtonLink,
  Chip,
  Kicker,
  LockLine,
  Oops,
  Sheet,
  Skeleton,
  StatusChip,
  TextField,
  Segmented,
  ToggleRow,
  useToast,
} from "@mizuhiki/ui";
import { DENOMS, fromBaseUnits } from "@mizuhiki/chain";
import {
  nameProblem,
  normalizeNameInput,
  passphraseProblem,
  unlockWithPassphrase,
  OPEN_END,
  PERIOD_KINDS,
} from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { useOwner } from "@/owner/OwnerProvider";
import { api } from "@/lib/api";
import { useContrast, type ContrastChoice } from "@/lib/contrast";
import { SITE_URL, pageUrl } from "@/lib/site";
import { downloadBytes } from "@/lib/download";
import { buildSpareKeySheet } from "@/lib/pdfs";
import { cardOf } from "@/lib/send";
import { lookupPerson, nameOf } from "@/rooms/engine";
import { createPass, ownedPasses, type PassView } from "@/passes/engine";
import { chipOf, personProblem, scopeLine } from "@/passes/model";
import { Confirm } from "@/shop/seller/bits";
import {
  claimSecondName,
  closeMyWindow,
  currentSubscription,
  deletePage,
  disablePush,
  enablePush,
  exportEverything,
  makePrimary,
  myNames,
  myWindow,
  notifySettings,
  pushSupport,
  releaseName,
  savePrefs,
  testPush,
  waitForNames,
  type ExportStep,
  type NameRow,
  type NotifySettings,
  type PushType,
  type Tokened,
} from "./engine";
import p from "@/passes/passes.module.css";
import s from "./settings.module.css";
import { failureText } from "@/lib/failure";

const SECTIONS = [
  { id: "profile", label: "Profile" },
  { id: "names", label: "Names" },
  { id: "security", label: "Security" },
  { id: "notifications", label: "Notifications" },
  { id: "readers", label: "Readers" },
  { id: "display", label: "Display" },
  { id: "data", label: "Data" },
  { id: "window", label: "QoreChain access" },
  { id: "legal", label: "Legal" },
] as const;

export function Settings() {
  const owner = useOwner();
  // Stable across owner refreshes (stats, publishing), so sections load once and never overwrite fresh edits.
  const { account, token } = owner;
  const tokened = useCallback(async (): Promise<Tokened> => ({ ...account, token: await token() }), [account, token]);
  return (
    <div className={p.page}>
      <header className={p.top}>
        <div className={p.titleBlock}>
          <Kicker>せってい</Kicker>
          <h1>Settings</h1>
          <p className={p.lede}>Your page, your names, your keys and what you are told about.</p>
        </div>
      </header>
      <div className={s.layout}>
        <nav className={s.toc} aria-label="Settings sections">
          {SECTIONS.map((x) => (
            <a key={x.id} href={`#${x.id}`}>
              {x.label}
            </a>
          ))}
        </nav>
        <div className={s.sections}>
          <ProfileSection />
          <NamesSection tokened={tokened} />
          <SecuritySection />
          <NotificationsSection tokened={tokened} />
          <ReadersSection tokened={tokened} />
          <DisplaySection />
          <DataSection tokened={tokened} />
          <WindowSection />
          <LegalSection />
        </div>
      </div>
    </div>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className={[p.panel, s.section].join(" ")} aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>{title}</h2>
      {children}
    </section>
  );
}

// ---- profile --------------------------------------------------------------------------------------

function ProfileSection() {
  const owner = useOwner();
  const m = owner.published;
  return (
    <Section id="profile" title="Profile">
      {m ? (
        <div className={s.profile}>
          <Avatar name={m.displayName || m.name} size={56} tone="peach" />
          <div>
            <b>{m.displayName || m.name}</b>
            <small>{m.bio || "No bio yet."}</small>
            <small>
              {m.socials.length} social {m.socials.length === 1 ? "link" : "links"} · Page in English
            </small>
          </div>
        </div>
      ) : owner.loadError ? (
        <Oops
          title="Not loaded"
          action={
            <Button variant="line" size="sm" icon="refresh" onClick={owner.reload}>
              Try again
            </Button>
          }
        >
          {owner.loadError}
        </Oops>
      ) : (
        <Skeleton lines={2} />
      )}
      <div className={p.actions}>
        <ButtonLink href="/app/design#profile" variant="line" icon="pen">
          Edit name, photo, bio and links
        </ButtonLink>
      </div>
    </Section>
  );
}

// ---- names ----------------------------------------------------------------------------------------

function NamesSection({ tokened }: { tokened: () => Promise<Tokened> }) {
  const owner = useOwner();
  const toast = useToast();
  const [data, setData] = useState<{ names: NameRow[]; pageName: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [releasing, setReleasing] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await myNames(await tokened()));
      setError(null);
    } catch (e) {
      setError(failureText(e, "Your names could not be loaded."));
    }
  }, [tokened]);
  useEffect(() => {
    void load();
  }, [load]);

  /** Make a name the page's address: set it primary on chain, then re-sign the page with it. */
  const moveTo = async (name: string) => {
    setBusy(name);
    try {
      await makePrimary(owner.account, name);
      const t = await tokened();
      await waitForNames(t, (r) => r.names.some((n) => n.name === name && n.primary));
      // Re-sign the live page with the new name; unpublished edits stay in the draft.
      await owner.renamePage(name);
      // Confirm with the server before saying it moved.
      await api.get(`/pages/${encodeURIComponent(name)}`);
      toast.show(`Your page now lives at @${name}. The old address says it moved.`);
      await load();
    } catch (e) {
      toast.show(failureText(e, "The name was not changed."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const release = async () => {
    if (!releasing) return;
    setBusy(releasing);
    try {
      await releaseName(owner.account, releasing);
      await waitForNames(await tokened(), (r) => !r.names.some((n) => n.name === releasing));
      toast.show(`@${releasing} is released. Anyone can claim it now.`);
      setReleasing(null);
      await load();
    } catch (e) {
      toast.show(failureText(e, "It was not released."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Section id="names" title="Names">
      <p>Names are recorded on QoreChain and belong to your key. Your page uses one of them as its address.</p>
      {error ? (
        <Oops
          title="Not loaded"
          action={
            <Button variant="line" size="sm" icon="refresh" onClick={() => void load()}>
              Try again
            </Button>
          }
        >
          {error}
        </Oops>
      ) : !data ? (
        <Skeleton lines={2} />
      ) : (
        <ul className={s.rows}>
          {data.names.map((n) => (
            <li key={n.name}>
              <span className={s.rowText}>
                <b>@{n.name}</b>
                <small>
                  {data.pageName === n.name ? "Your page's address" : n.primary ? "Main name on chain" : "Also yours"}
                </small>
              </span>
              <span className={s.rowEnd}>
                {data.pageName === n.name ? (
                  <StatusChip status="ok">Page address</StatusChip>
                ) : (
                  <>
                    <Button size="sm" variant="line" busy={busy === n.name} onClick={() => void moveTo(n.name)}>
                      Use for my page
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      aria-label={`Release @${n.name}`}
                      onClick={() => setReleasing(n.name)}
                    />
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className={p.actions}>
        <Button variant="line" icon="plus" onClick={() => setAdding(true)}>
          Claim another name
        </Button>
      </div>
      <ClaimSheet open={adding} onClose={() => setAdding(false)} tokened={tokened} onDone={load} />
      <Confirm
        open={releasing !== null}
        title={`Release @${releasing ?? ""}?`}
        confirm="Release"
        busy={busy === releasing}
        onClose={() => setReleasing(null)}
        onConfirm={() => void release()}
      >
        <p>
          It stops being yours on QoreChain and anyone can claim it. Links that used it stop pointing to you. Your page
          keeps its own address.
        </p>
      </Confirm>
    </Section>
  );
}

function ClaimSheet({
  open,
  onClose,
  tokened,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  tokened: () => Promise<Tokened>;
  onDone: () => Promise<void>;
}) {
  const owner = useOwner();
  const toast = useToast();
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [stage, setStage] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName("");
      setErr(null);
    }
  }, [open]);
  const claim = async () => {
    const n = normalizeNameInput(name);
    const problem = nameProblem(n);
    if (problem) return setErr(problem.message);
    setErr(null);
    try {
      const { available } = await api.get<{ available: boolean }>(`/names/${encodeURIComponent(n)}`);
      if (!available) return setErr(`@${n} is taken. Try another.`);
      setStage("Reserving it on QoreChain");
      await claimSecondName(owner.account, n, (st) =>
        setStage(st === "commit" ? "Reserving it on QoreChain" : st === "wait" ? "Waiting one block" : "Claiming it"),
      );
      setStage("Confirming");
      await waitForNames(await tokened(), (r) => r.names.some((x) => x.name === n));
      toast.show(`@${n} is yours.`);
      onClose();
      await onDone();
    } catch (e) {
      setErr(failureText(e, "The name was not claimed. Nothing was charged beyond network fees already shown."));
    } finally {
      setStage(null);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Claim another name" dismissable={stage === null}>
      <form
        className={p.form}
        onSubmit={(e) => {
          e.preventDefault();
          void claim();
        }}
      >
        <TextField
          label="New name"
          prefix="@"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={err ?? undefined}
          autoComplete="off"
          spellCheck={false}
          hint="3 to 30 letters, numbers, dots, dashes or underscores."
        />
        <div className={p.actions}>
          <Button variant="quiet" type="button" onClick={onClose} disabled={stage !== null}>
            Cancel
          </Button>
          <Button variant="cord" icon="check" type="submit" busy={stage !== null}>
            {stage ?? "Claim it"}
          </Button>
        </div>
        <LockLine>
          Two small transactions on QoreChain (reserve, then claim), so nobody can take the name in between.
        </LockLine>
      </form>
    </Sheet>
  );
}

// ---- security -------------------------------------------------------------------------------------

function SecuritySection() {
  const acct = useAccount();
  const owner = useOwner();
  const toast = useToast();
  const [mode, setMode] = useState<"pass" | "phrase" | "sheet" | null>(null);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const hasPasskey = acct.vault?.wraps.some((w) => w.kind === "passkey") ?? false;
  const reset = () => {
    setMode(null);
    setCurrent("");
    setNext("");
    setErr(null);
    setPhrase(null);
  };
  const verify = async () => {
    if (!acct.vault) throw new Error("There is no saved key on this device.");
    await unlockWithPassphrase(acct.vault, current).catch(() => {
      throw new Error("That passphrase is not right. Nothing was shown or changed.");
    });
  };
  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      await verify();
      if (mode === "pass") {
        const problem = passphraseProblem(next);
        if (problem) throw new Error(problem);
        await acct.changePassphrase(next);
        toast.show("Passphrase changed on this device.");
        reset();
      } else if (mode === "phrase") {
        setPhrase(owner.account.keys.phrase);
      } else if (mode === "sheet") {
        const name = owner.published?.name ?? "";
        const bytes = await buildSpareKeySheet({
          name,
          pageUrl: pageUrl(name),
          address: owner.account.owner.address,
          evm: owner.account.owner.evm,
          phrase: owner.account.keys.phrase,
          createdAt: new Date(),
        });
        downloadBytes(bytes, `mizuhiki-spare-key-${name}.pdf`);
        toast.show("Spare-key sheet saved.");
        reset();
      }
    } catch (e) {
      setErr(failureText(e, "That did not work."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section id="security" title="Security">
      <ul className={s.rows}>
        <li>
          <span className={s.rowText}>
            <b>Device passphrase</b>
            <small>Unlocks your key on this device only.</small>
          </span>
          <Button size="sm" variant="line" onClick={() => setMode("pass")}>
            Change
          </Button>
        </li>
        <li>
          <span className={s.rowText}>
            <b>Passkey</b>
            <small>
              {hasPasskey
                ? "This device can unlock with a passkey."
                : "Unlock with your fingerprint or face instead of typing."}
            </small>
          </span>
          {hasPasskey ? (
            <StatusChip status="ok">On</StatusChip>
          ) : (
            <Button
              size="sm"
              variant="line"
              busy={busy && mode === null}
              onClick={() => {
                setBusy(true);
                void acct
                  .addPasskey("Mizuhiki")
                  .then(() => toast.show("Passkey added on this device."))
                  .catch((e: unknown) => toast.show(failureText(e, "No passkey was added."), { tone: "error" }))
                  .finally(() => setBusy(false));
              }}
            >
              Add a passkey
            </Button>
          )}
        </li>
        <li>
          <span className={s.rowText}>
            <b>Recovery phrase</b>
            <small>Your 24 words. Shown only after your passphrase.</small>
          </span>
          <span className={s.rowEnd}>
            <Button size="sm" variant="line" onClick={() => setMode("phrase")}>
              Show
            </Button>
            <Button size="sm" variant="ghost" icon="download" onClick={() => setMode("sheet")}>
              Spare-key sheet
            </Button>
          </span>
        </li>
        <li>
          <span className={s.rowText}>
            <b>This device</b>
            <small>Unlocked in this tab. Locks itself after 15 minutes without use.</small>
          </span>
          <span className={s.rowEnd}>
            <Button size="sm" variant="line" icon="lock" onClick={acct.lock}>
              Lock now
            </Button>
            <Button size="sm" variant="ghost" icon="x" onClick={() => setForgetting(true)}>
              Forget this device
            </Button>
          </span>
        </li>
      </ul>
      <Link href="/app/spare-key" className={s.more}>
        Recovery contacts, test and offline reader are on the Spare key page →
      </Link>
      <Sheet
        open={mode !== null}
        onClose={reset}
        title={
          mode === "pass" ? "Change device passphrase" : mode === "phrase" ? "Your recovery phrase" : "Spare-key sheet"
        }
        dismissable={!busy}
      >
        {phrase ? (
          <div className={p.form}>
            <ol className={s.phrase} aria-label="Recovery phrase">
              {phrase.split(" ").map((w, i) => (
                <li key={`${w}${i}`}>{w}</li>
              ))}
            </ol>
            <LockLine>
              Anyone with these words can open everything. Never type them into a site you did not open yourself.
            </LockLine>
            <div className={p.actions}>
              <Button variant="cord" onClick={reset}>
                Hide
              </Button>
            </div>
          </div>
        ) : (
          <form
            className={p.form}
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <TextField
              label={mode === "pass" ? "Current passphrase" : "Device passphrase"}
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              error={mode !== "pass" ? (err ?? undefined) : undefined}
            />
            {mode === "pass" ? (
              <TextField
                label="New passphrase"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                error={err ?? (next ? passphraseProblem(next) : undefined)}
                hint="At least 10 characters."
              />
            ) : null}
            <div className={p.actions}>
              <Button variant="quiet" type="button" onClick={reset} disabled={busy}>
                Cancel
              </Button>
              <Button variant="cord" type="submit" busy={busy} disabled={!current || (mode === "pass" && !next)}>
                {mode === "pass" ? "Change passphrase" : mode === "phrase" ? "Show my words" : "Make the sheet"}
              </Button>
            </div>
          </form>
        )}
      </Sheet>
      <Confirm
        open={forgetting}
        title="Forget this device?"
        confirm="Forget this device"
        onClose={() => setForgetting(false)}
        onConfirm={() => void acct.forgetDevice("/login")}
      >
        <p>
          Your key is removed from this browser. Your page and everything sealed to you stay; open them again anywhere
          with your 24 words.
        </p>
      </Confirm>
    </Section>
  );
}

// ---- notifications --------------------------------------------------------------------------------

const PUSH_LABEL: Record<PushType, { title: string; detail: string }> = {
  items: { title: "New sealed items", detail: "Messages, files and form answers." },
  payments: { title: "Payments", detail: "Money that reached you through your page." },
  orders: { title: "Shop orders", detail: "Orders to deliver and their changes." },
  rooms: { title: "Rooms", detail: "Changes in rooms you are in." },
  access: { title: "Passes and capsules", detail: "Invites, requests and releases." },
  recovery: { title: "Spare key alarms", detail: "Someone recovering your account, or asking for your help." },
  checkin: { title: "Capsule check-in reminders", detail: 'Before an "if I go quiet" capsule opens.' },
};

function NotificationsSection({ tokened }: { tokened: () => Promise<Tokened> }) {
  const toast = useToast();
  const [data, setData] = useState<NotifySettings | null>(null);
  const [here, setHere] = useState<boolean | null>(null);
  const [support, setSupport] = useState<"ready" | "unsupported" | "denied">("ready");
  const [busy, setBusy] = useState(false);
  // A load that started before the person changed a toggle must not overwrite that change when it lands.
  const edits = useRef(0);
  const load = useCallback(async () => {
    setSupport(pushSupport());
    const seq = edits.current;
    const [d, sub] = await Promise.all([notifySettings(await tokened()), currentSubscription().catch(() => null)]);
    if (seq !== edits.current) return;
    setData(d);
    setHere(!!sub && d.browsers.some((b) => b.endpoint === sub.endpoint));
  }, [tokened]);
  useEffect(() => {
    void load().catch(() => setData(null));
  }, [load]);
  // Toggles save from the latest values, never a stale copy, and in order.
  const prefsRef = useRef<Record<PushType, boolean> | null>(null);
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    prefsRef.current = data?.prefs ?? null;
  }, [data]);
  const toggle = (k: PushType, on: boolean) => {
    const cur = prefsRef.current;
    if (!cur) return;
    const next = { ...cur, [k]: on };
    edits.current += 1;
    prefsRef.current = next;
    setData((d) => (d ? { ...d, prefs: next } : d));
    saving.current = saving.current.then(async () => {
      try {
        await savePrefs(await tokened(), next);
      } catch {
        toast.show("Not saved. Check your connection.", { tone: "error" });
        await load();
      }
    });
  };

  return (
    <Section id="notifications" title="Notifications">
      <p>A notification says only what kind of thing happened, never what it says. It is encrypted to this browser.</p>
      {!data ? (
        <Skeleton lines={3} />
      ) : !data.enabled ? (
        <p className={p.hint}>Notifications are not set up on this server.</p>
      ) : (
        <>
          <div className={s.pushBox}>
            <span className={s.rowText}>
              <b>This browser</b>
              <small>
                {support === "unsupported"
                  ? "This browser cannot show notifications."
                  : support === "denied"
                    ? "Notifications are blocked for this site in the browser's settings."
                    : here
                      ? "Notifications are on here."
                      : "Turn on to be told when something arrives."}
              </small>
            </span>
            {support === "ready" ? (
              here ? (
                <span className={s.rowEnd}>
                  <Button
                    size="sm"
                    variant="line"
                    onClick={() =>
                      void tokened()
                        .then(testPush)
                        .then((r) =>
                          toast.show(
                            r.delivered
                              ? "Test sent. It should appear in a moment."
                              : "Nothing was delivered. Try turning notifications off and on.",
                          ),
                        )
                    }
                  >
                    Send a test
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy}
                    onClick={() => {
                      setBusy(true);
                      void tokened()
                        .then(disablePush)
                        .then(load)
                        .finally(() => setBusy(false));
                    }}
                  >
                    Turn off here
                  </Button>
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="cord"
                  icon="bell"
                  busy={busy}
                  onClick={() => {
                    setBusy(true);
                    void tokened()
                      .then(enablePush)
                      .then(async () => {
                        toast.show("Notifications are on for this browser.");
                        await load();
                      })
                      .catch((e: unknown) =>
                        toast.show(failureText(e, "Notifications were not turned on."), {
                          tone: "error",
                        }),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  Turn on
                </Button>
              )
            ) : null}
          </div>
          <div className={s.toggles}>
            {(Object.keys(PUSH_LABEL) as PushType[]).map((k) => (
              <ToggleRow
                key={k}
                title={PUSH_LABEL[k].title}
                detail={PUSH_LABEL[k].detail}
                checked={data.prefs[k]}
                onChange={(on) => toggle(k, on)}
              />
            ))}
          </div>
          <p className={p.hint}>
            {data.browsers.length} {data.browsers.length === 1 ? "browser gets" : "browsers get"} your notifications.
            Email notifications are not offered.
          </p>
        </>
      )}
    </Section>
  );
}

// ---- readers --------------------------------------------------------------------------------------

function ReadersSection({ tokened }: { tokened: () => Promise<Tokened> }) {
  const router = useRouter();
  const toast = useToast();
  const [list, setList] = useState<PassView[] | null>(null);
  const [names, setNames] = useState<Record<string, string | null>>({});
  const [adding, setAdding] = useState(false);
  const [who, setWho] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const { passes } = await ownedPasses(await tokened());
    const live = passes.filter(
      (x) =>
        x.status !== "revoked" &&
        x.status !== "declined" &&
        x.status !== "expired" &&
        x.invite.body.scope.kind === "period",
    );
    setList(live);
    setNames(
      Object.fromEntries(
        await Promise.all(
          [...new Set(live.map((x) => x.holder))].map(async (a) => [a, await nameOf(a).catch(() => null)] as const),
        ),
      ),
    );
  }, [tokened]);
  useEffect(() => {
    void load().catch(() => setList([]));
  }, [load]);
  const add = async () => {
    const problem = personProblem(who);
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    try {
      const found = await lookupPerson(who);
      if (!found) throw new Error("No Mizuhiki account has that name.");
      await cardOf(found.address);
      const today = new Date(
        Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()),
      ).toISOString();
      const pass = await createPass(await tokened(), {
        holder: found.address,
        scope: { kind: "period", from: today, until: OPEN_END, kinds: [...PERIOD_KINDS] },
        expiresAt: null,
        note: "You are my default reader.",
      });
      toast.show(`Invited. Finish on the pass page once ${found.name ? `@${found.name}` : "they"} accept.`);
      setAdding(false);
      setWho("");
      router.push(`/app/passes/${pass.id}`);
    } catch (e) {
      setErr(failureText(e, "They were not invited."));
    } finally {
      setBusy(false);
    }
  };
  const label = (a: string) => {
    const n = names[a];
    return n ? `@${n}` : `${a.slice(0, 10)}…`;
  };
  const open = (list ?? []).filter(
    (x) =>
      x.invite.body.scope.kind === "period" &&
      "until" in x.invite.body.scope &&
      Date.parse(x.invite.body.scope.until) > Date.parse("2900-01-01"),
  );
  const periods = (list ?? []).filter((x) => !open.includes(x));
  return (
    <Section id="readers" title="Readers">
      <p>
        A default reader (an assistant, say) can read every new item sent to your page, from the day they start. They
        cannot change anything, and you can remove them any time.
      </p>
      {list === null ? (
        <Skeleton lines={2} />
      ) : (
        <>
          <ul className={s.rows}>
            {open.length === 0 ? <li className={p.hint}>No default readers.</li> : null}
            {open.map((x) => (
              <li key={x.id}>
                <span className={s.rowText}>
                  <b>{label(x.holder)}</b>
                  <small>Default reader · {scopeLine(x.invite.body.scope)}</small>
                </span>
                <span className={s.rowEnd}>
                  <StatusChip status={chipOf(x, "owner").status}>{chipOf(x, "owner").label}</StatusChip>
                  <ButtonLink size="sm" variant="ghost" href={`/app/passes/${x.id}`}>
                    Open
                  </ButtonLink>
                </span>
              </li>
            ))}
          </ul>
          {periods.length ? (
            <p className={p.hint}>
              Also {periods.length} period {periods.length === 1 ? "pass" : "passes"} (an accountant for a quarter,
              say). <Link href="/app/passes">See passes</Link>
            </p>
          ) : null}
          {adding ? (
            <form
              className={s.inline}
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
            >
              <TextField
                label="Their @name or address"
                hideLabel
                placeholder="@assistant"
                value={who}
                onChange={(e) => setWho(e.target.value)}
                error={err ?? undefined}
                autoComplete="off"
                spellCheck={false}
              />
              <Button type="submit" variant="cord" icon="send" busy={busy}>
                Invite
              </Button>
            </form>
          ) : (
            <div className={p.actions}>
              <Button variant="line" icon="plus" onClick={() => setAdding(true)}>
                Add a default reader
              </Button>
            </div>
          )}
          <LockLine>They accept, you compare six safety words, and only then is anything sealed to them.</LockLine>
        </>
      )}
    </Section>
  );
}

// ---- display --------------------------------------------------------------------------------------------

function DisplaySection() {
  const [choice, setChoice] = useContrast();
  return (
    <Section id="display" title="Display">
      <Segmented<ContrastChoice>
        label="High contrast"
        value={choice}
        onChange={setChoice}
        options={[
          { value: "device", label: "Follow this device" },
          { value: "on", label: "On" },
          { value: "off", label: "Off" },
        ]}
      />
      <p className={p.hint}>
        Black text on white with stronger lines, everywhere in Mizuhiki. Saved on this device only. With &ldquo;Follow
        this device&rdquo; it turns on when your system asks for more contrast.
      </p>
    </Section>
  );
}

// ---- data -----------------------------------------------------------------------------------------

function DataSection({ tokened }: { tokened: () => Promise<Tokened> }) {
  const owner = useOwner();
  const acct = useAccount();
  const toast = useToast();
  const [step, setStep] = useState<ExportStep | null>(null);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [countdown, setCountdown] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const doExport = async () => {
    setStep({ label: "Starting", done: 0, total: 1 });
    try {
      const { bytes, skipped } = await exportEverything(await tokened(), owner.published, setStep);
      const name = owner.published?.name ?? "account";
      downloadBytes(bytes, `mizuhiki-${name}-${new Date().toISOString().slice(0, 10)}.zip`, "application/zip");
      toast.show(
        skipped
          ? `Saved. ${skipped} ${skipped === 1 ? "item" : "items"} could not be opened here and were left out.`
          : "Saved. Everything was opened on this device.",
      );
    } catch (e) {
      toast.show(failureText(e, "The export did not finish."), { tone: "error" });
    } finally {
      setStep(null);
    }
  };

  // Delete with Undo: nothing is sent until 10 seconds pass. The interval only counts; the delete runs from the
  // effect below once the count reaches zero (a state updater must not have side effects).
  const startDelete = () => {
    setAsking(false);
    setCountdown(10);
    timer.current = setInterval(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
  };
  useEffect(() => {
    if (countdown !== 0) return;
    if (timer.current) clearInterval(timer.current);
    setCountdown(null);
    void tokened()
      .then(deletePage)
      // A full load to the landing page: nothing in memory survives, and it says what happened there.
      .then(() => acct.forgetDevice("/?left=deleted"))
      .catch((e: unknown) => toast.show(failureText(e, "It was not deleted."), { tone: "error" }));
  }, [countdown, tokened, acct, toast]);
  const undo = () => {
    if (timer.current) clearInterval(timer.current);
    setCountdown(null);
    toast.show("Nothing was deleted.");
  };
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current);
    },
    [],
  );

  return (
    <Section id="data" title="Data">
      <ul className={s.rows}>
        <li>
          <span className={s.rowText}>
            <b>Export everything</b>
            <small>
              Your page, inbox items with their files, invoices, rooms' messages and your lists, opened on this device
              into one zip.
            </small>
          </span>
          <Button size="sm" variant="line" icon="download" busy={step !== null} onClick={() => void doExport()}>
            {step ? `${step.label} ${step.total > 1 ? `${step.done + 1} of ${step.total}` : ""}` : "Export"}
          </Button>
        </li>
        <li>
          <span className={s.rowText}>
            <b>Delete my page</b>
            <small>
              Hides your page and removes everything Mizuhiki stores for you. Names, keys, payments and proofs on
              QoreChain stay.
            </small>
          </span>
          {countdown !== null ? (
            <span className={s.rowEnd}>
              <Chip tone="sakura" icon="clock">
                Deleting in {countdown}
              </Chip>
              <Button size="sm" variant="cord" icon="undo" onClick={undo}>
                Undo
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="danger" icon="trash" onClick={() => setAsking(true)}>
              Delete
            </Button>
          )}
        </li>
      </ul>
      <Sheet open={asking} onClose={() => setAsking(false)} title="Delete your page?">
        <div className={p.form}>
          <p>
            Your page at {SITE_URL.replace(/^https?:\/\//, "")}/@{owner.published?.name ?? ""} goes away, with every
            sealed item, invoice, form, product, pass and recovery piece stored for you. Rooms you share with others
            stay for them. QoreChain keeps your names, keys, payments and proofs; nobody can remove those.
          </p>
          <p>Export first if you want a copy.</p>
          <TextField
            label='Type "delete my page" to confirm'
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
          />
          <div className={p.actions}>
            <Button variant="quiet" onClick={() => setAsking(false)}>
              Keep it
            </Button>
            <Button
              variant="danger"
              icon="trash"
              disabled={typed.trim().toLowerCase() !== "delete my page"}
              onClick={startDelete}
            >
              Delete my page
            </Button>
          </div>
          <LockLine>You get 10 seconds to undo before anything is sent.</LockLine>
        </div>
      </Sheet>
    </Section>
  );
}

// ---- the QoreChain access window -------------------------------------------------------------------

function WindowSection() {
  const owner = useOwner();
  const toast = useToast();
  const [w, setW] = useState<Awaited<ReturnType<typeof myWindow>> | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setW(await myWindow(owner.account));
  }, [owner.account]);
  useEffect(() => {
    void load().catch(() => setW(null));
  }, [load]);
  return (
    <Section id="window" title="QoreChain access">
      <p>
        Actions on Mizuhiki&rsquo;s contracts (names, rooms, capsules, proofs) need a short access window on your
        account, opened with your post-quantum key. It limits how many actions and how much they can spend.
      </p>
      {w === null ? (
        <Skeleton lines={1} />
      ) : w.found && w.live ? (
        <div className={s.pushBox}>
          <span className={s.rowText}>
            <b>Open</b>
            <small>
              {w.remainingTxs.toString()} {w.remainingTxs === 1n ? "action" : "actions"} left · up to{" "}
              {fromBaseUnits(w.remainingValue, DENOMS.QOR.decimals)} QOR · closes on its own in{" "}
              {w.remainingBlocks.toString()} blocks (block {w.expiryHeight.toString()})
            </small>
          </span>
          <Button
            size="sm"
            variant="line"
            icon="x"
            busy={busy}
            onClick={() => {
              setBusy(true);
              void closeMyWindow(owner.account)
                .then(async () => {
                  toast.show("The access window is closed.");
                  await load();
                })
                .catch((e: unknown) => toast.show(failureText(e, "It was not closed."), { tone: "error" }))
                .finally(() => setBusy(false));
            }}
          >
            Close it now
          </Button>
        </div>
      ) : (
        <p className={p.hint}>No window is open. One opens by itself the next time an action needs it.</p>
      )}
    </Section>
  );
}

// ---- legal ----------------------------------------------------------------------------------------

function LegalSection() {
  return (
    <Section id="legal" title="Legal">
      <ul className={s.links}>
        <li>
          <Link href="/legal/privacy">Privacy: what we can and cannot see</Link>
        </li>
        <li>
          <Link href="/legal/terms">Terms of use</Link>
        </li>
        <li>
          <Link href="/legal/report">Report a page</Link>
        </li>
      </ul>
      <p className={p.hint}>Mizuhiki runs on QoreChain testnet. Test tokens have no value.</p>
    </Section>
  );
}
