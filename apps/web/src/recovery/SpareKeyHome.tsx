"use client";
/**
 * "Your spare key" (spec 5.13): a ring over three checks (sheet saved,
 * contacts holding pieces, a test passed), the sheet, recovery contacts
 * (Bitwarden invite, accept, confirm with safety words; QoreX's 2-of-3 pieces),
 * a test run, recoveries in progress with Cancel, the offline reader, and the
 * people this account helps.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Avatar,
  Button,
  Chip,
  EmptyState,
  Icon,
  Kicker,
  LockLine,
  Oops,
  ProgressRing,
  Segmented,
  Sheet,
  Skeleton,
  StatusChip,
  Tabs,
  TextArea,
  TextField,
  useToast,
  type Status,
} from "@mizuhiki/ui";
import { unlockWithPassphrase } from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { useOwner } from "@/owner/OwnerProvider";
import { markChecklist } from "@/editor/checklist";
import { SITE_URL } from "@/lib/site";
import { downloadBytes } from "@/lib/download";
import { buildSpareKeySheet } from "@/lib/pdfs";
import { cardOf } from "@/lib/send";
import { lookupPerson, nameOf, safetyWords } from "@/rooms/engine";
import { personProblem } from "@/passes/model";
import { Confirm } from "@/shop/seller/bits";
import {
  acceptHelp,
  answerRequest,
  dismissRequest,
  cancelRequest,
  checkTest,
  confirmContact,
  copyOlderToOffline,
  declineHelp,
  disableOffline,
  enableOffline,
  inviteContact,
  loadHelping,
  loadMine,
  markSheet,
  pieceState,
  removeContact,
  requestWords,
  sealPieces,
  startTest,
  strangerRequests,
  type ContactRow,
  type Helping,
  type Mine,
  type RequestRow,
  type TestRun,
  type Tokened,
} from "./engine";
import { useRecoveryEvents } from "./useRecoveryEvents";
import p from "@/passes/passes.module.css";
import s from "./recovery.module.css";
import { failureText } from "@/lib/failure";

type Tab = "mine" | "helping";
const fmt = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const short = (a: string) => `${a.slice(0, 10)}…${a.slice(-4)}`;

const CONTACT_CHIP: Record<string, { status: Status; label: string }> = {
  invited: { status: "wait", label: "Invited" },
  accepted: { status: "info", label: "Check their words" },
  confirmed: { status: "ok", label: "Holds a piece" },
  declined: { status: "neutral", label: "Declined" },
};

export function SpareKeyHome() {
  const owner = useOwner();
  const params = useSearchParams();
  const router = useRouter();
  const path = usePathname();
  const [tab, setTabState] = useState<Tab>(params.get("tab") === "helping" ? "helping" : "mine");
  const [mine, setMine] = useState<Mine | null>(null);
  const [helping, setHelping] = useState<Helping | null>(null);
  const [names, setNames] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);

  // Stable across owner refreshes, so loaders do not rerun on every draft or stats change.
  const { account, token } = owner;
  const tokened = useCallback(async (): Promise<Tokened> => ({ ...account, token: await token() }), [account, token]);
  const load = useCallback(async () => {
    try {
      const t = await tokened();
      const [m, h] = await Promise.all([loadMine(t), loadHelping(t)]);
      setMine(m);
      setHelping(h);
      setError(null);
      const who = [...new Set([...m.contacts.map((c) => c.contact), ...h.owners.map((o) => o.owner)])];
      const found = await Promise.all(who.map(async (a) => [a, await nameOf(a).catch(() => null)] as const));
      setNames(Object.fromEntries(found));
    } catch (e) {
      setError(failureText(e, "Your spare key could not be loaded. Nothing changed."));
    }
  }, [tokened]);
  useEffect(() => {
    void load();
  }, [load]);
  useRecoveryEvents(() => void load());

  const label = (a: string) => (names[a] ? `@${names[a]}` : short(a));
  const setTab = (t: Tab) => {
    setTabState(t);
    router.replace(t === "mine" ? path : `${path}?tab=${t}`, { scroll: false });
  };
  const waiting =
    (helping?.owners.filter((o) => o.status === "invited").length ?? 0) +
    (helping?.requests.filter((r) => !r.answeredByMe).length ?? 0);

  return (
    <div className={p.page}>
      <header className={p.top}>
        <div className={p.titleBlock}>
          <Kicker>あいかぎ</Kicker>
          <h1>Spare key</h1>
          <p className={p.lede}>
            Ways back in if you lose your phrase. Mizuhiki cannot reset it for you, so set these up now.
          </p>
        </div>
      </header>
      <Tabs
        label="Spare key"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "mine", label: "Your spare key" },
          { value: "helping", label: "People you help", badge: waiting || undefined },
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
        ) : !mine || !helping ? (
          <Skeleton lines={5} />
        ) : tab === "mine" ? (
          <MineView m={mine} label={label} tokened={tokened} reload={load} />
        ) : (
          <HelpingView h={helping} label={label} tokened={tokened} reload={load} />
        )}
      </div>
    </div>
  );
}

// ---- your spare key ------------------------------------------------------------------------------

function MineView({
  m,
  label,
  tokened,
  reload,
}: {
  m: Mine;
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const { holders } = pieceState(m);
  const contactsDone = holders.length >= m.settings.threshold && m.settings.version > 0;
  const checks = [
    {
      done: !!m.settings.sheetSavedAt,
      title: "Saved my sheet",
      detail: m.settings.sheetSavedAt
        ? `Saved ${fmt(m.settings.sheetSavedAt)}`
        : "The 24 words on paper, kept somewhere safe.",
    },
    {
      done: contactsDone,
      title: "Added recovery contacts",
      detail: contactsDone
        ? `${holders.length} people hold a piece; any ${m.settings.threshold} can help.`
        : "Make sure at least two people can help you.",
    },
    {
      done: !!m.settings.testedAt,
      title: "Tested my recovery",
      detail: m.settings.testedAt
        ? `Passed ${fmt(m.settings.testedAt)}`
        : "A safe dry run: your contacts answer, nothing is revealed.",
    },
  ];
  const done = checks.filter((c) => c.done).length;
  const strangers = strangerRequests(m);
  return (
    <>
      {strangers.length ? <Alarm requests={strangers} label={label} tokened={tokened} reload={reload} /> : null}
      <section className={[p.panel, s.ringPanel].join(" ")} aria-label="Spare key status">
        <ProgressRing done={done} total={3} size={84} />
        <div className={s.ringText}>
          <h2>{done === 3 ? "Your spare key is ready" : `${done} of 3 done`}</h2>
          <ul className={s.checks}>
            {checks.map((c) => (
              <li key={c.title} className={c.done ? s.checkDone : ""}>
                <span className={s.tick} aria-hidden="true">
                  {c.done ? <Icon name="check" size={14} /> : null}
                </span>
                <span>
                  <b>{c.title}</b>
                  <small>{c.detail}</small>
                </span>
                <span className="sr-only">{c.done ? "done" : "not done"}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      <SheetPanel m={m} tokened={tokened} reload={reload} />
      <ContactsPanel m={m} label={label} tokened={tokened} reload={reload} />
      <TestPanel m={m} label={label} tokened={tokened} reload={reload} />
      <OfflinePanel m={m} tokened={tokened} reload={reload} />
      <p className={s.honest}>
        This follows the same 2-of-3 pattern QoreX uses for its wallet: pieces sealed to each contact, a 48-hour wait
        and a cancel alert. If you lose your sheet and enough contacts, your sealed items cannot be opened by anyone.
      </p>
    </>
  );
}

/** A recovery someone else started: shown loudly, with Cancel. */
function Alarm({
  requests,
  label,
  tokened,
  reload,
}: {
  requests: RequestRow[];
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <section className={s.alarm} role="alert">
      <Icon name="alert" size={22} />
      <div>
        <h2>Someone is recovering your account on another device</h2>
        {requests.map((r) => (
          <div key={r.id} className={s.alarmRow}>
            <p>
              Started {fmt(r.createdAt)}. {r.answered.length} of {r.threshold} contacts answered
              {r.answered.length ? ` (${r.answered.map(label).join(", ")})` : ""}.
              {r.releaseAt
                ? ` Pieces are released ${fmt(r.releaseAt)} unless you cancel.`
                : " Nothing is released until enough contacts answer and 48 hours pass."}
            </p>
            <p className={s.words}>
              Their one-time key words: <b>{requestWords(r)}</b>
            </p>
            <Button
              variant="danger"
              icon="x"
              busy={busy === r.id}
              onClick={() => {
                setBusy(r.id);
                void tokened()
                  .then((t) => cancelRequest(t, r.id))
                  .then(async () => {
                    toast.show("Cancelled. Nothing is released to that device.");
                    await reload();
                  })
                  .catch((e: unknown) => toast.show(failureText(e, "It was not cancelled."), { tone: "error" }))
                  .finally(() => setBusy(null));
              }}
            >
              It wasn&rsquo;t me, cancel it
            </Button>
          </div>
        ))}
        <p className={s.small}>If it was you on a new device, leave it: the pieces are released after the wait.</p>
      </div>
    </section>
  );
}

function SheetPanel({ m, tokened, reload }: { m: Mine; tokened: () => Promise<Tokened>; reload: () => Promise<void> }) {
  const owner = useOwner();
  const acct = useAccount();
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setErr(null);
    setBusy(true);
    try {
      // Re-check the device passphrase before the phrase is written out.
      if (!acct.vault) throw new Error("There is no saved key on this device.");
      await unlockWithPassphrase(acct.vault, pass).catch(() => {
        throw new Error("That passphrase is not right. Nothing was shown.");
      });
      const name = owner.published?.name ?? "";
      const bytes = await buildSpareKeySheet({
        name,
        pageUrl: `${SITE_URL}/@${name}`,
        address: owner.account.owner.address,
        evm: owner.account.owner.evm,
        phrase: owner.account.keys.phrase,
        createdAt: new Date(),
      });
      downloadBytes(bytes, `mizuhiki-spare-key-${name}.pdf`);
      await markSheet(await tokened(), "sheet");
      // The same sheet ticks the setup checklist on the editor.
      owner.edit((x) => markChecklist(x, "spareKey", "done"));
      toast.show("Sheet saved. Print it, or keep it somewhere offline.");
      setAsking(false);
      setPass("");
      await reload();
    } catch (e) {
      setErr(failureText(e, "The sheet was not made."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className={p.panel}>
      <h2>Spare-key sheet</h2>
      <p>
        Your page, your address and your 24 words on one page. Without it, no one can open your sealed items, including
        you.
      </p>
      <div className={p.actions}>
        <Button variant={m.settings.sheetSavedAt ? "line" : "cord"} icon="download" onClick={() => setAsking(true)}>
          {m.settings.sheetSavedAt ? "Download it again" : "Download the sheet"}
        </Button>
      </div>
      <Sheet open={asking} onClose={() => setAsking(false)} title="Confirm it is you" dismissable={!busy}>
        <form
          className={p.form}
          onSubmit={(e) => {
            e.preventDefault();
            void download();
          }}
        >
          <p>The sheet shows your recovery phrase. Type this device&rsquo;s passphrase first.</p>
          <TextField
            label="Device passphrase"
            type="password"
            autoComplete="current-password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            error={err ?? undefined}
          />
          <div className={p.actions}>
            <Button variant="quiet" type="button" onClick={() => setAsking(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="cord" icon="download" type="submit" busy={busy} disabled={!pass}>
              Make the sheet
            </Button>
          </div>
          <LockLine>Made in this browser. The phrase never leaves your device.</LockLine>
        </form>
      </Sheet>
    </section>
  );
}

function ContactsPanel({
  m,
  label,
  tokened,
  reload,
}: {
  m: Mine;
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [checking, setChecking] = useState<ContactRow | null>(null);
  const [removing, setRemoving] = useState<ContactRow | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirmed, needsSeal, holders } = pieceState(m);
  const [threshold, setThreshold] = useState(
    Math.min(Math.max(2, m.settings.threshold), Math.max(2, confirmed.length)),
  );
  const [sealing, setSealing] = useState<{ done: number; total: number } | null>(null);
  const list = m.contacts.filter((c) => c.status !== "removed");

  const seal = async () => {
    setSealing({ done: 0, total: confirmed.length });
    try {
      await sealPieces(await tokened(), m, threshold, (done, total) => setSealing({ done, total }));
      toast.show(`Pieces sealed. Any ${threshold} of ${confirmed.length} contacts can help you.`);
      await reload();
    } catch (e) {
      toast.show(failureText(e, "The pieces were not sealed. Nothing changed."), { tone: "error" });
    } finally {
      setSealing(null);
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await removeContact(await tokened(), removing.contact);
      toast.show(`${label(removing.contact)} is no longer a recovery contact.`);
      setRemoving(null);
      await reload();
    } catch (e) {
      toast.show(failureText(e, "Not removed. Nothing changed."), { tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={p.panel}>
      <h2>Recovery contacts</h2>
      <p>
        People you trust each hold one sealed piece of your phrase. One piece alone reveals nothing; any{" "}
        {m.settings.version > 0 ? m.settings.threshold : 2} together can bring your account back on a new device.
      </p>
      {list.length === 0 ? (
        <EmptyState title="No contacts yet" face="normal" jp="たよりになる人">
          Make sure at least two people can help you. They need a Mizuhiki account.
        </EmptyState>
      ) : (
        <ul className={p.list}>
          {list.map((c) => {
            const stale = c.status === "confirmed" && !(c.piece && c.pieceVersion === m.settings.version);
            const chip = stale
              ? { status: "wait" as Status, label: "Needs a new piece" }
              : (CONTACT_CHIP[c.status] ?? { status: "neutral" as Status, label: c.status });
            return (
              <li key={c.contact} className={s.contactRow}>
                <Avatar name={label(c.contact).replace("@", "")} size={40} tone="sakura" />
                <span className={p.itemText}>
                  <b>{label(c.contact)}</b>
                  <small>
                    {c.status === "invited"
                      ? `Invited ${fmt(c.createdAt)}`
                      : c.status === "accepted"
                        ? "Accepted. Compare their safety words to finish."
                        : c.status === "declined"
                          ? "They said no."
                          : `Since ${fmt(c.updatedAt)}`}
                  </small>
                </span>
                <span className={p.itemEnd}>
                  <StatusChip status={chip.status}>{chip.label}</StatusChip>
                  {c.status === "accepted" ? (
                    <Button size="sm" variant="cord" icon="check" onClick={() => setChecking(c)}>
                      Check words
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="trash"
                    aria-label={`Remove ${label(c.contact)}`}
                    onClick={() => setRemoving(c)}
                  />
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {needsSeal ? (
        <div className={s.sealBox}>
          <p>
            <b>{holders.length ? "Your contacts changed." : `${confirmed.length} contacts are ready.`}</b> Seal a new
            set of pieces so each of them holds one.
          </p>
          <Segmented
            label="Pieces needed to recover"
            value={String(threshold)}
            onChange={(v) => setThreshold(Number(v))}
            options={Array.from({ length: confirmed.length - 1 }, (_, i) => ({
              value: String(i + 2),
              label: `Any ${i + 2} of ${confirmed.length}`,
            }))}
          />
          <Button variant="cord" icon="lock" busy={sealing !== null} onClick={() => void seal()}>
            {sealing
              ? `Sealing piece ${Math.min(sealing.done + 1, sealing.total)} of ${sealing.total}`
              : "Seal the pieces"}
          </Button>
          <LockLine>Split and sealed on this device. Mizuhiki only keeps sealed copies.</LockLine>
        </div>
      ) : null}
      <div className={p.actions}>
        {/* Red only for the next unfinished step: the sheet comes first, then the first contact. */}
        <Button
          variant={list.length || !m.settings.sheetSavedAt ? "line" : "cord"}
          icon="plus"
          onClick={() => setAdding(true)}
        >
          Add a contact
        </Button>
      </div>
      <AddContactSheet open={adding} onClose={() => setAdding(false)} tokened={tokened} onAdded={reload} />
      {checking ? (
        <CheckWordsSheet
          c={checking}
          label={label}
          tokened={tokened}
          onClose={() => setChecking(null)}
          onDone={reload}
        />
      ) : null}
      <Confirm
        open={removing !== null}
        title={`Remove ${removing ? label(removing.contact) : ""}?`}
        confirm="Remove"
        busy={busy}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
      >
        <p>
          Their piece is deleted from Mizuhiki, and you will seal a new set for the others. Your phrase itself cannot
          change, so if they kept a copy of their old piece, it still fits with {Math.max(1, m.settings.threshold - 1)}{" "}
          other old {m.settings.threshold - 1 === 1 ? "piece" : "pieces"}. If you no longer trust them, move to a new
          account.
        </p>
      </Confirm>
    </section>
  );
}

function AddContactSheet({
  open,
  onClose,
  tokened,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  tokened: () => Promise<Tokened>;
  onAdded: () => Promise<void>;
}) {
  const owner = useOwner();
  const toast = useToast();
  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setWho("");
      setNote("");
      setErr(null);
    }
  }, [open]);
  const add = async () => {
    const problem = personProblem(who);
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    try {
      const found = await lookupPerson(who);
      if (!found) throw new Error("No Mizuhiki account has that name. Check the spelling, or use their qor1… address.");
      if (found.address === owner.account.owner.address)
        throw new Error("A recovery contact is someone else. Your own sheet already covers you.");
      await cardOf(found.address);
      await inviteContact(await tokened(), found.address, note);
      toast.show(
        `Invited ${found.name ? `@${found.name}` : short(found.address)}. They accept from their Spare key page.`,
      );
      onClose();
      await onAdded();
    } catch (e) {
      setErr(failureText(e, "They were not invited. Nothing changed."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add a recovery contact" dismissable={!busy}>
      <form
        className={p.form}
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <TextField
          label="Their @name or address"
          placeholder="@kenji"
          value={who}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setWho(e.target.value)}
          error={err ?? undefined}
          hint="Someone you trust who is easy to reach by phone or in person."
        />
        <TextArea
          label="A note for them (optional)"
          rows={2}
          maxLength={300}
          counter
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="If I ever lose my phone, I may call you to help me back in."
        />
        <div className={p.actions}>
          <Button variant="quiet" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="cord" icon="send" type="submit" busy={busy}>
            {busy ? "Signing the invite" : "Send invite"}
          </Button>
        </div>
        <p className={p.hint}>
          Nothing is shared yet. After they accept, you compare six safety words, then seal their piece.
        </p>
      </form>
    </Sheet>
  );
}

function CheckWordsSheet({
  c,
  label,
  tokened,
  onClose,
  onDone,
}: {
  c: ContactRow;
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const toast = useToast();
  const [words, setWords] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const life = { alive: true };
    safetyWords(c.contact)
      .then((w) => life.alive && setWords(w))
      .catch((e: unknown) => life.alive && setErr(failureText(e, "Their key could not be read from QoreChain.")));
    return () => {
      life.alive = false;
    };
  }, [c.contact]);
  const confirm = async () => {
    setBusy(true);
    try {
      await confirmContact(await tokened(), c.contact);
      toast.show(`${label(c.contact)} is confirmed.`);
      onClose();
      await onDone();
    } catch (e) {
      setErr(failureText(e, "Not confirmed. Nothing changed."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet open onClose={onClose} title={`Check it is really ${label(c.contact)}`} dismissable={!busy}>
      <div className={p.form}>
        <p>
          Ask {label(c.contact)} to read the six safety words on their Spare key page, on a call or in person. Confirm
          only if every word matches, in order.
        </p>
        {err ? (
          <Oops title="Not checked">{err}</Oops>
        ) : words === null ? (
          <Skeleton lines={1} />
        ) : (
          <ul className={p.words} aria-label="Safety words">
            {words.split(/\s+/).map((w, i) => (
              <li key={`${w}${i}`}>{w}</li>
            ))}
          </ul>
        )}
        <div className={p.actions}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            They don&rsquo;t match
          </Button>
          <Button variant="cord" icon="check" busy={busy} disabled={!words} onClick={() => void confirm()}>
            They match, confirm
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

function TestPanel({
  m,
  label,
  tokened,
  reload,
}: {
  m: Mine;
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const [run, setRun] = useState<TestRun | null>(null);
  const [state, setState] = useState<{ answered: string[]; result: "waiting" | "passed" | "failed" } | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = m.settings.version > 0 && pieceState(m).holders.length >= m.settings.threshold;

  const [checkErr, setCheckErr] = useState<string | null>(null);
  // Once a run has passed (the server then marks it done), it is never re-checked.
  const passed = useRef(false);
  const check = useCallback(async () => {
    if (!run || passed.current) return;
    try {
      const r = await checkTest(await tokened(), run);
      setCheckErr(null);
      setState({ answered: r.request.answered, result: r.result });
      if (r.result === "passed") {
        passed.current = true;
        toast.show("Recovery works. Your contacts' pieces rebuild your phrase.");
        await reload();
      }
    } catch (e) {
      // Checked again on the next tick or event; said plainly meanwhile.
      setCheckErr(failureText(e, "The test could not be checked. Trying again."));
    }
  }, [run, tokened, toast, reload]);
  useRecoveryEvents(() => void check());
  useEffect(() => {
    if (!run || state?.result === "passed" || state?.result === "failed") return;
    const h = setInterval(() => void check(), 5000);
    return () => clearInterval(h);
  }, [run, state?.result, check]);

  return (
    <section className={p.panel}>
      <h2>Test my recovery</h2>
      <p>
        A safe dry run. Your contacts answer as they would for real; this device checks their pieces rebuild your
        phrase. Nothing is shown to anyone, and there is no wait.
      </p>
      {run ? (
        <div className={s.testBox} aria-live="polite">
          <p>Ask your contacts to open Spare key › People you help, and compare these words with you:</p>
          <ul className={p.words} aria-label="Test words">
            {run.words.split(" ").map((w, i) => (
              <li key={`${w}${i}`}>{w}</li>
            ))}
          </ul>
          <p>
            <b>
              {state?.answered.length ?? 0} of {m.settings.threshold}
            </b>{" "}
            answered{state?.answered.length ? `: ${state.answered.map(label).join(", ")}` : ""}.
          </p>
          {checkErr ? <p className={p.err}>{checkErr}</p> : null}
          {state?.result === "passed" ? (
            <StatusChip status="ok">Passed</StatusChip>
          ) : state?.result === "failed" ? (
            <Oops title="The pieces did not rebuild your phrase">Seal a new set of pieces, then test again.</Oops>
          ) : (
            <StatusChip status="wait">Waiting for contacts</StatusChip>
          )}
        </div>
      ) : null}
      <div className={p.actions}>
        <Button
          variant={m.settings.testedAt ? "line" : "cord"}
          icon="shield"
          busy={busy}
          disabled={!ready}
          onClick={() => {
            setBusy(true);
            void tokened()
              .then(startTest)
              .then((r) => {
                passed.current = false;
                setRun(r);
                setState({ answered: [], result: "waiting" });
              })
              .catch((e: unknown) => toast.show(failureText(e, "The test did not start."), { tone: "error" }))
              .finally(() => setBusy(false));
          }}
        >
          {run ? "Start a new test" : "Start a test"}
        </Button>
      </div>
      {!ready ? <p className={p.hint}>Seal pieces with at least two contacts first.</p> : null}
    </section>
  );
}

function OfflinePanel({
  m,
  tokened,
  reload,
}: {
  m: Mine;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const owner = useOwner();
  const toast = useToast();
  const [words, setWords] = useState<string | null>(null);
  const [busy, setBusy] = useState<"on" | "off" | "copy" | "sheet" | null>(null);
  const [copying, setCopying] = useState<{ done: number; total: number } | null>(null);
  const [off, setOff] = useState(false);
  const key = m.settings.offlineKey;

  const turnOn = async () => {
    setBusy("on");
    try {
      const r = await enableOffline(await tokened());
      await owner.publishPassKeys();
      setWords(r.words);
      await reload();
    } catch (e) {
      toast.show(failureText(e, "The offline reader was not turned on."), { tone: "error" });
    } finally {
      setBusy(null);
    }
  };
  const sheet = async () => {
    if (!words) return;
    setBusy("sheet");
    try {
      const name = owner.published?.name ?? "";
      const bytes = await buildSpareKeySheet({
        name,
        pageUrl: `${SITE_URL}/@${name}`,
        address: owner.account.owner.address,
        evm: owner.account.owner.evm,
        phrase: words,
        createdAt: new Date(),
        variant: "offline",
      });
      downloadBytes(bytes, `mizuhiki-offline-reader-${name}.pdf`);
      await markSheet(await tokened(), "offlineSheet");
      toast.show("Offline reader sheet saved.");
      setWords(null);
      await reload();
    } finally {
      setBusy(null);
    }
  };
  const copy = async () => {
    if (!key) return;
    setBusy("copy");
    try {
      const n = await copyOlderToOffline(await tokened(), key, (done, total) => setCopying({ done, total }));
      toast.show(
        n
          ? `${n} older ${n === 1 ? "item" : "items"} sealed to the offline reader.`
          : "Older items are already covered.",
      );
    } catch (e) {
      toast.show(failureText(e, "Nothing was copied."), { tone: "error" });
    } finally {
      setBusy(null);
      setCopying(null);
    }
  };
  const turnOff = async () => {
    setBusy("off");
    try {
      await disableOffline(await tokened());
      await owner.publishPassKeys();
      toast.show("The offline reader is off. New items are no longer sealed to it.");
      setOff(false);
      await reload();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className={p.panel}>
      <h2>Offline reader</h2>
      <p>
        A second key, printed on its own sheet and kept offline. Items sent to you are sealed to it too, so with it you
        can read them even if this device and your phrase are gone. It cannot sign in, pay or change anything.
      </p>
      {words ? (
        <div className={s.testBox}>
          <p>
            <b>Your offline reader key.</b> It is shown once. Save the sheet now.
          </p>
          <ol className={s.wordGrid} aria-label="Offline reader words">
            {words.split(" ").map((w, i) => (
              <li key={`${w}${i}`}>{w}</li>
            ))}
          </ol>
          <Button variant="cord" icon="download" busy={busy === "sheet"} onClick={() => void sheet()}>
            Save the offline reader sheet
          </Button>
        </div>
      ) : key ? (
        <>
          <div className={p.covered}>
            <Chip tone="matcha" icon="lock">
              On since {fmt(key.since)}
            </Chip>
            {m.settings.offlineSheetSavedAt ? (
              <Chip tone="white" icon="check">
                Sheet saved
              </Chip>
            ) : (
              <StatusChip status="wait">Sheet not saved</StatusChip>
            )}
          </div>
          <div className={p.actions}>
            <Button variant="line" icon="lock" busy={busy === "copy"} onClick={() => void copy()}>
              {copying ? `Sealing ${copying.done} of ${copying.total}` : "Seal older items to it"}
            </Button>
            <Button variant="ghost" icon="x" onClick={() => setOff(true)}>
              Turn off
            </Button>
          </div>
        </>
      ) : (
        <div className={p.actions}>
          <Button variant="line" icon="key" busy={busy === "on"} onClick={() => void turnOn()}>
            Make an offline reader
          </Button>
        </div>
      )}
      <Confirm
        open={off}
        title="Turn off the offline reader?"
        confirm="Turn off"
        busy={busy === "off"}
        onClose={() => setOff(false)}
        onConfirm={() => void turnOff()}
      >
        <p>
          New items stop being sealed to it and its copies are deleted from Mizuhiki. Anyone holding the sheet can still
          open copies they already downloaded.
        </p>
      </Confirm>
    </section>
  );
}

// ---- people you help ------------------------------------------------------------------------------

function HelpingView({
  h,
  label,
  tokened,
  reload,
}: {
  h: Helping;
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const owner = useOwner();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [answering, setAnswering] = useState<RequestRow | null>(null);
  const [myWords, setMyWords] = useState<string | null>(null);
  useEffect(() => {
    if (!h.owners.some((o) => o.status === "accepted")) return;
    const life = { alive: true };
    safetyWords(owner.account.owner.address)
      .then((w) => life.alive && setMyWords(w))
      .catch(() => life.alive && setMyWords(""));
    return () => {
      life.alive = false;
    };
  }, [h.owners, owner.account.owner.address]);

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

  if (h.owners.length === 0)
    return (
      <div className={p.emptyWrap}>
        <EmptyState title="You are nobody's recovery contact yet" face="sleepy" jp="まだだよ">
          When someone asks you to hold a piece of their spare key, it shows here.
        </EmptyState>
      </div>
    );
  return (
    <>
      {h.requests.length ? (
        <section className={s.alarm}>
          <Icon name="key" size={22} />
          <div>
            <h2>Recovery requests</h2>
            {h.requests.map((r) => (
              <div key={r.id} className={s.alarmRow}>
                <p>
                  <b>{label(r.owner)}</b>{" "}
                  {r.test ? "is testing their recovery." : "is getting back into their account on a new device."}{" "}
                  {r.answered.length} of {r.threshold} answered.
                </p>
                {r.answeredByMe ? (
                  <StatusChip status="ok">You answered</StatusChip>
                ) : (
                  <Button variant="cord" icon="key" onClick={() => setAnswering(r)}>
                    Help {label(r.owner)}
                  </Button>
                )}
              </div>
            ))}
          </div>
        </section>
      ) : null}
      <ul className={p.list}>
        {h.owners.map((o) => (
          <li key={o.owner} className={s.contactRow}>
            <Avatar name={label(o.owner).replace("@", "")} size={40} tone="sora" />
            <span className={p.itemText}>
              <b>{label(o.owner)}</b>
              <small>
                {o.status === "invited"
                  ? o.invite.body.note || "Asks you to hold a piece of their spare key."
                  : o.status === "accepted"
                    ? "Accepted. They will compare your safety words with you."
                    : o.status === "declined"
                      ? "You said no."
                      : o.piece
                        ? "You hold a sealed piece. Alone it reveals nothing."
                        : "Confirmed. They have not sealed your piece yet."}
              </small>
            </span>
            <span className={p.itemEnd}>
              {o.status === "invited" ? (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    busy={busy === `d${o.owner}`}
                    onClick={() =>
                      void act(
                        `d${o.owner}`,
                        async () => declineHelp(await tokened(), o.owner),
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
                    busy={busy === `a${o.owner}`}
                    onClick={() =>
                      void act(
                        `a${o.owner}`,
                        async () => acceptHelp(await tokened(), o.owner),
                        `Accepted. ${label(o.owner)} will compare safety words with you.`,
                      )
                    }
                  >
                    Accept
                  </Button>
                </>
              ) : (
                <StatusChip status={o.piece ? "ok" : o.status === "declined" ? "neutral" : "wait"}>
                  {o.piece ? "Holding a piece" : o.status === "declined" ? "Declined" : "Waiting"}
                </StatusChip>
              )}
            </span>
          </li>
        ))}
      </ul>
      {myWords !== null ? (
        <section className={p.panel}>
          <h2>Your safety words</h2>
          <p>
            Read these to the person who asked you, on a call or in person. They confirm you only if every word matches.
          </p>
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
      {answering ? (
        <AnswerSheet
          r={answering}
          who={label(answering.owner)}
          onClose={() => setAnswering(null)}
          onAnswer={async () => {
            await answerRequest(await tokened(), h, answering);
            toast.show(`Your piece is sealed to ${label(answering.owner)}'s new device.`);
            setAnswering(null);
            await reload();
          }}
          onDismiss={async () => {
            const r = await dismissRequest(await tokened(), answering);
            toast.show(
              r.status === "cancelled"
                ? "Request turned down. Too few contacts are left for it, so it is cancelled."
                : "Request turned down. You won't be asked about it again.",
            );
            setAnswering(null);
            await reload();
          }}
        />
      ) : null}
    </>
  );
}

function AnswerSheet({
  r,
  who,
  onClose,
  onAnswer,
  onDismiss,
}: {
  r: RequestRow;
  who: string;
  onClose: () => void;
  onAnswer: () => Promise<void>;
  /** The words differ, or nobody asked: turn the request down. */
  onDismiss: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet open onClose={onClose} title={`Help ${who}`} dismissable={!busy}>
      <div className={p.form}>
        <p>
          <b>Call {who} first</b>, on a number you already know, and ask them to read the words on their new device.
          Send your piece only if every word matches. Someone pretending to be them would show different words.
        </p>
        <ul className={p.words} aria-label="Words on their new device">
          {requestWords(r)
            .split(" ")
            .map((w, i) => (
              <li key={`${w}${i}`}>{w}</li>
            ))}
        </ul>
        {r.test ? (
          <p className={p.hint}>This is a test they started. Nothing is revealed to anyone.</p>
        ) : (
          <p className={p.hint}>
            After enough contacts answer, {who} waits 48 hours, and can cancel if it was not them.
          </p>
        )}
        {err ? (
          <p className={p.err} role="alert">
            {err}
          </p>
        ) : null}
        <div className={p.actions}>
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setErr(null);
              void onDismiss()
                .catch((e: unknown) => setErr(failureText(e, "Nothing changed. Try again.")))
                .finally(() => setBusy(false));
            }}
          >
            The words differ, turn it down
          </Button>
          <Button
            variant="cord"
            icon="lock"
            busy={busy}
            onClick={() => {
              setBusy(true);
              setErr(null);
              void onAnswer()
                .catch((e: unknown) => setErr(failureText(e, "Your piece was not sent. Nothing changed.")))
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Sealing your piece" : "They match, send my piece"}
          </Button>
        </div>
        <LockLine>
          Your piece is opened and re-sealed on this device. You never see it, and Mizuhiki cannot read it.
        </LockLine>
      </div>
    </Sheet>
  );
}
