"use client";
/**
 * One capsule (spec 5.14): Google's stepper with collapsing check lines (What
 * and who, When, Guardians, Confirm your plan) and, once armed, its live state
 * from CapsuleVault with the owner's controls: Approve now / Reject a pending
 * request, Check in, edit recipients and guardians, Cancel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Avatar,
  Button,
  Icon,
  Kicker,
  LockLine,
  Oops,
  SealMoment,
  Segmented,
  Sheet,
  Skeleton,
  StatusChip,
  TextArea,
  TextField,
  ToggleRow,
  useToast,
  type SealStep,
} from "@mizuhiki/ui";
import {
  ACCESS_PRESETS,
  QUIET_PRESETS,
  WAIT_PRESETS,
  durationText,
  planSentences,
  warnLeadSeconds,
  type CapsuleMode,
} from "@mizuhiki/core";
import { useOwnerSession } from "@/owner/OwnerProvider";
import { cardOf } from "@/lib/send";
import { lookupPerson, nameOf, safetyWords } from "@/rooms/engine";
import { personProblem } from "@/passes/model";
import { fmtBytes } from "@/public/MessageSheet";
import { Confirm } from "@/shop/seller/bits";
import {
  addFile,
  approveNow,
  arm,
  armProblems,
  cancel,
  chainNow,
  chainState,
  checkIn,
  confirmGuardian,
  deleteDraft,
  inviteGuardian,
  newDraft,
  openDraft,
  ownedCapsules,
  phaseOf,
  reject,
  removeGuardian,
  saveDraft,
  type ArmStep,
  type CapsuleDraft,
  type OwnedCapsule,
  type Tokened,
} from "./engine";
import { PHASE_CHIP, countdown, when, type Live } from "./CapsulesHome";
import { useCapsuleEvents } from "./useCapsuleEvents";
import p from "@/passes/passes.module.css";
import s from "./capsules.module.css";
import { failureText } from "@/lib/failure";

const MODES: { value: CapsuleMode; label: string }[] = [
  { value: "at-time", label: "At a set time" },
  { value: "after-wait", label: "For family after a wait" },
  { value: "if-quiet", label: "If I go quiet" },
];

export function CapsuleEditor({ id: given }: { id: string | null }) {
  const owner = useOwnerSession();
  // A new capsule gets its id on the first save; from then on this editor loads it like any other.
  const [id, setId] = useState<string | null>(given);
  const [draft, setDraft] = useState<CapsuleDraft | null>(null);
  const [row, setRow] = useState<OwnedCapsule | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [names, setNames] = useState<Record<string, string | null>>({});
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const tokened = useCallback(
    async (): Promise<Tokened> => ({ ...owner.account, token: await owner.token() }),
    [owner],
  );

  const load = useCallback(async () => {
    try {
      if (!id) {
        setDraft((d) => d ?? newDraft());
        return;
      }
      const t = await tokened();
      const r = (await ownedCapsules(t)).find((c) => c.id === id);
      if (!r) throw new Error("This capsule does not exist, or is not yours.");
      setRow(r);
      setDraft((d) => d ?? null);
      const d = await openDraft(owner.account, r.id, r.draftEnvelope);
      setDraft((cur) => (cur && cur.id === d.id ? cur : d));
      if (r.state !== "draft") setLive({ chain: await chainState(r.id), now: await chainNow() });
      const who = [
        ...new Set([...r.guardians.map((g) => g.guardian), ...(r.plan?.body.recipients.map((x) => x.address) ?? [])]),
      ];
      setNames(
        Object.fromEntries(await Promise.all(who.map(async (a) => [a, await nameOf(a).catch(() => null)] as const))),
      );
      setError(null);
    } catch (e) {
      setError(failureText(e, "This capsule could not be opened."));
    }
  }, [id, tokened, owner.account]);
  useEffect(() => {
    void load();
  }, [load]);
  useCapsuleEvents(() => void load());

  // Autosave the sealed working copy, a moment after the last change.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The newest working copy, moved at once by every change: a step that awaits (a name lookup, say) and then saves
  // must not save an older copy over edits made meanwhile.
  const latest = useRef<CapsuleDraft | null>(null);
  latest.current = draft;
  const change = (fn: (d: CapsuleDraft) => CapsuleDraft) => {
    // Computed outside the state updater, which must stay free of side effects (the autosave timer).
    const cur = latest.current;
    if (!cur) return;
    const next = fn(cur);
    latest.current = next;
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setSave("saving");
      void tokened()
        .then((t) => saveDraft(t, next))
        .then(() => {
          setSave("saved");
          // Give the new capsule its own address in place: no navigation, so nothing reloads or remounts.
          if (!id) {
            window.history.replaceState(null, "", `/app/capsules/${next.id}`);
            setId(next.id);
          }
        })
        .catch(() => setSave("failed"));
    }, 700);
  };
  const flush = async (d: CapsuleDraft) => {
    if (timer.current) clearTimeout(timer.current);
    const newest = latest.current && latest.current.id === d.id ? latest.current : d;
    await saveDraft(await tokened(), newest);
    setSave("saved");
  };

  const label = (a: string) => (names[a] ? `@${names[a]}` : `${a.slice(0, 10)}…`);
  if (error)
    return (
      <div className={p.page}>
        <Back />
        <Oops title="Not opened">{error}</Oops>
      </div>
    );
  if (!draft)
    return (
      <div className={p.page}>
        <Back />
        <Skeleton lines={6} />
      </div>
    );
  const armed = row?.state === "armed";
  const ph =
    row?.state === "cancelled" ? "cancelled" : live ? phaseOf(live.chain, live.now) : armed ? "armed" : "draft";
  const chip = PHASE_CHIP[ph];
  return (
    <div className={p.page}>
      <Back />
      <header className={p.top}>
        <span className={[s.capIcon, s.headIcon].join(" ")} aria-hidden="true">
          <Icon name="hour" size={22} />
        </span>
        <div className={p.titleBlock}>
          <Kicker>たいむかぷせる</Kicker>
          <h1>{draft.label.trim() || "New capsule"}</h1>
          <p className={p.lede}>
            {save === "saving"
              ? "Saving, sealed…"
              : save === "saved"
                ? "Saved, sealed to you"
                : save === "failed"
                  ? "Not saved. Check your connection."
                  : "Only you can read this working copy."}
          </p>
        </div>
        <span className={p.newBtn}>
          <StatusChip status={chip.status}>{chip.label}</StatusChip>
        </span>
      </header>
      {row && row.state !== "draft" ? (
        live ? (
          <StatusPanel row={row} live={live} label={label} tokened={tokened} reload={load} />
        ) : (
          <section className={p.panel} aria-label="Reading the capsule from QoreChain">
            <Skeleton lines={3} />
          </section>
        )
      ) : null}
      {row?.state === "cancelled" || ph === "released" || ph === "expired" ? null : (
        <Stepper
          draft={draft}
          row={row}
          armed={armed}
          label={label}
          change={change}
          flush={flush}
          tokened={tokened}
          reload={load}
          setNames={setNames}
        />
      )}
    </div>
  );
}

function Back() {
  return (
    <Link href="/app/capsules" className={p.back}>
      <Icon name="back" size={16} /> All capsules
    </Link>
  );
}

// ---- armed: live state and controls -----------------------------------------------------------------

function StatusPanel({
  row,
  live,
  label,
  tokened,
  reload,
}: {
  row: OwnedCapsule;
  live: Live;
  label: (a: string) => string;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const owner = useOwnerSession();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const plan = row.plan?.body;
  const ph = phaseOf(live.chain, live.now);
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
  if (!plan) return null;
  const quietWarn =
    plan.mode === "if-quiet" &&
    live.chain.opensAt !== 0n &&
    Number(live.chain.opensAt - live.now) < warnLeadSeconds(plan.quietSeconds);
  const handed = new Set(row.releases.map((r) => `${r.guardian}|${r.recipient}`));
  return (
    <section className={[p.panel, s.statusPanel].join(" ")} aria-label="Capsule state">
      {ph === "requested" ? (
        <>
          <h2>A guardian asked to open it</h2>
          <p className={s.big}>
            <Icon name="clock" size={22} /> Opens {countdown(live.chain.opensAt, live.now)}
          </p>
          <p>
            {live.chain.requestedBy ? "A guardian" : "Someone"} asked on {when(live.chain.requestedAt)}. Unless you say
            no, it opens {when(live.chain.opensAt)}. Saying no keeps them as a guardian.
          </p>
          <div className={p.actions}>
            <Button
              variant="ghost"
              icon="x"
              busy={busy === "reject"}
              onClick={() =>
                void act("reject", () => reject(owner.account, row.id), "Rejected. It stays sealed and armed.")
              }
            >
              Reject
            </Button>
            <Button
              variant="cord"
              icon="check"
              busy={busy === "approve"}
              onClick={() =>
                void act(
                  "approve",
                  () => approveNow(owner.account, row.id),
                  "Released now. Guardians hand over their pieces.",
                )
              }
            >
              Approve now
            </Button>
          </div>
        </>
      ) : ph === "armed" || ph === "due" ? (
        <>
          <h2>{ph === "due" ? "The time has come" : "Armed"}</h2>
          {live.chain.opensAt ? (
            <p className={s.big}>
              <Icon name="clock" size={22} /> Opens {countdown(live.chain.opensAt, live.now)}
            </p>
          ) : null}
          <ul className={s.sentences}>
            {planSentences({
              ...plan,
              guardians: plan.guardians.map(label),
              recipients: plan.recipients.map((r) => label(r.address)),
            }).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          {plan.mode === "if-quiet" ? (
            <div className={quietWarn ? s.bar : p.covered}>
              <span>
                {quietWarn ? <b>Check in soon. </b> : null}
                Last check-in: {live.chain.lastCheckIn ? when(live.chain.lastCheckIn) : "when you armed it"}.
              </span>
              <Button
                size="sm"
                variant="cord"
                icon="check"
                busy={busy === "in"}
                onClick={() =>
                  void act("in", () => checkIn(owner.account), "Checked in. The quiet clock starts again.")
                }
              >
                I&rsquo;m here, check in
              </Button>
            </div>
          ) : null}
        </>
      ) : ph === "released" ? (
        <>
          <h2>Released {when(live.chain.releasedAt)}</h2>
          <p>Recipients can collect it until {when(live.chain.releasedAt + live.chain.accessSeconds)}.</p>
          <ul className={p.list}>
            {plan.recipients.map((r) => {
              const n = plan.guardians.filter((g) => handed.has(`${g}|${r.address}`)).length;
              return (
                <li key={r.address} className={s.row}>
                  <Avatar name={label(r.address).replace("@", "")} size={36} tone="matcha" />
                  <span className={p.itemText}>
                    <b>{label(r.address)}</b>
                    <small>
                      {n} of {plan.threshold} needed {plan.threshold === 1 ? "piece" : "pieces"} handed over
                    </small>
                  </span>
                  <StatusChip status={n >= plan.threshold ? "ok" : "wait"}>
                    {n >= plan.threshold ? "Can open" : "Waiting for guardians"}
                  </StatusChip>
                </li>
              );
            })}
          </ul>
        </>
      ) : ph === "expired" ? (
        <>
          <h2>Expired</h2>
          <p>
            The time to collect ended {when(live.chain.releasedAt + live.chain.accessSeconds)}. Guardians no longer hand
            over pieces.
          </p>
        </>
      ) : null}
      {ph === "armed" || ph === "requested" || ph === "due" ? (
        <div className={p.actions}>
          <Button variant="danger" icon="x" onClick={() => setCancelling(true)}>
            Cancel capsule
          </Button>
        </div>
      ) : null}
      {row.armedTx ? (
        <LockLine>
          Recorded on QoreChain. Its state there decides when it opens; Mizuhiki cannot open it early.
        </LockLine>
      ) : null}
      <Confirm
        open={cancelling}
        title="Cancel this capsule?"
        confirm="Cancel capsule"
        busy={busy === "cancel"}
        onClose={() => setCancelling(false)}
        onConfirm={() =>
          void act(
            "cancel",
            async () => cancel(await tokened(), row.id),
            "Cancelled on QoreChain. It will never open.",
          ).then(() => setCancelling(false))
        }
      >
        <p>
          It is recorded as cancelled on QoreChain and will never open. Guardians and recipients see that it was
          cancelled. This cannot be undone; you can make a new capsule.
        </p>
      </Confirm>
    </section>
  );
}

// ---- the stepper ------------------------------------------------------------------------------------

function Stepper({
  draft,
  row,
  armed,
  label,
  change,
  flush,
  tokened,
  reload,
  setNames,
}: {
  draft: CapsuleDraft;
  row: OwnedCapsule | null;
  armed: boolean;
  label: (a: string) => string;
  change: (fn: (d: CapsuleDraft) => CapsuleDraft) => void;
  flush: (d: CapsuleDraft) => Promise<void>;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
  setNames: (fn: (n: Record<string, string | null>) => Record<string, string | null>) => void;
}) {
  const [open, setOpen] = useState<number>(armed ? -1 : 0);
  const guardians = (row?.guardians ?? []).filter((g) => g.status !== "removed" && g.status !== "declined");
  const confirmed = guardians.filter((g) => g.status === "confirmed").map((g) => g.guardian);
  const whoDone =
    !!draft.label.trim() &&
    draft.recipients.length > 0 &&
    draft.recipients.every((r) => r.message.trim() || r.files.length);
  const whenDone = draft.mode !== "at-time" || (!!draft.releaseAt && Date.parse(draft.releaseAt) > Date.now());
  const guardDone = confirmed.length > 0 && guardians.length === confirmed.length;
  const steps = [
    {
      title: "What and who",
      done: whoDone,
      summary: whoDone
        ? `${draft.files.length} ${draft.files.length === 1 ? "file" : "files"} for ${draft.recipients.map((r) => (r.name ? `@${r.name}` : "someone")).join(", ")}`
        : "Files, a message, and the people they are for",
    },
    {
      title: "When",
      done: whenDone,
      summary:
        draft.mode === "at-time"
          ? draft.releaseAt
            ? `Opens ${new Date(draft.releaseAt).toLocaleString("en-GB", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" })}`
            : "Choose a date and time"
          : draft.mode === "after-wait"
            ? `A guardian asks, then ${durationText(draft.waitSeconds)} to say no`
            : `After ${durationText(draft.quietSeconds)} without a check-in`,
    },
    {
      title: "Guardians",
      done: guardDone,
      summary: guardDone
        ? `${confirmed.length} confirmed · any ${Math.min(draft.threshold, confirmed.length)} hand over the key`
        : "People who keep the key's pieces and hand them over",
    },
    {
      title: "Confirm your plan",
      done: armed,
      summary: armed ? "Armed on QoreChain" : "Read it in plain words, then arm it",
    },
  ];
  const go = (i: number) => {
    void flush(draft).catch(() => undefined);
    setOpen((o) => (o === i ? -1 : i));
  };
  return (
    <ol className={s.steps}>
      {steps.map((st, i) => (
        <li key={st.title} className={s.step}>
          <button type="button" className={s.stepHead} aria-expanded={open === i} onClick={() => go(i)}>
            <span className={[s.num, st.done ? s.numDone : open === i ? s.numNow : ""].join(" ")}>
              {st.done ? <Icon name="check" size={16} /> : i + 1}
            </span>
            <span>
              <b>{st.title}</b>
              <small>{st.summary}</small>
            </span>
            <Icon name="chev" size={18} />
          </button>
          {open === i ? (
            <div className={s.stepBody}>
              {i === 0 ? <WhatWho draft={draft} change={change} setNames={setNames} /> : null}
              {i === 1 ? <When draft={draft} change={change} armed={armed} /> : null}
              {i === 2 ? (
                <Guardians
                  draft={draft}
                  row={row}
                  label={label}
                  change={change}
                  flush={flush}
                  tokened={tokened}
                  reload={reload}
                  setNames={setNames}
                />
              ) : null}
              {i === 3 ? (
                <ConfirmPlan
                  draft={draft}
                  row={row}
                  confirmed={confirmed}
                  label={label}
                  flush={flush}
                  tokened={tokened}
                  reload={reload}
                />
              ) : null}
              {i < 3 ? (
                <div className={p.actions}>
                  <Button variant="cord" iconRight="arrow" onClick={() => go(i + 1)}>
                    Next
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

function WhatWho({
  draft,
  change,
  setNames,
}: {
  draft: CapsuleDraft;
  change: (fn: (d: CapsuleDraft) => CapsuleDraft) => void;
  setNames: (fn: (n: Record<string, string | null>) => Record<string, string | null>) => void;
}) {
  const owner = useOwnerSession();
  const [who, setWho] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [up, setUp] = useState<{ name: string; p: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const addRecipient = async () => {
    const problem = personProblem(who);
    if (problem) return setErr(problem);
    setBusy(true);
    setErr(null);
    try {
      const found = await lookupPerson(who);
      if (!found)
        throw new Error(
          "No Mizuhiki account has that name. Recipients need an account so the capsule can be sealed to them.",
        );
      if (found.address === owner.account.owner.address) throw new Error("A capsule is for someone else.");
      if (draft.recipients.some((r) => r.address === found.address)) throw new Error("They are already a recipient.");
      if (draft.recipients.length >= 10) throw new Error("A capsule can have up to 10 recipients.");
      await cardOf(found.address);
      setNames((n) => ({ ...n, [found.address]: found.name }));
      change((d) => ({
        ...d,
        recipients: [
          ...d.recipients,
          { address: found.address, name: found.name, message: "", files: d.files.map((f) => f.fileId) },
        ],
      }));
      setWho("");
    } catch (e) {
      setErr(failureText(e, "They were not added."));
    } finally {
      setBusy(false);
    }
  };
  const addFiles = async (files: FileList | null) => {
    for (const f of Array.from(files ?? [])) {
      setUp({ name: f.name, p: 0 });
      try {
        const facts = await addFile(f, (x) => setUp({ name: f.name, p: x }));
        change((d) => ({
          ...d,
          files: [...d.files, facts],
          recipients: d.recipients.map((r) => ({ ...r, files: [...r.files, facts.fileId] })),
        }));
      } catch (e) {
        setErr(failureText(e, `${f.name} was not added.`));
      }
    }
    setUp(null);
  };
  return (
    <>
      <TextField
        label="Name of the capsule"
        placeholder="For my family"
        maxLength={80}
        value={draft.label}
        onChange={(e) => change((d) => ({ ...d, label: e.target.value }))}
        hint="Guardians and recipients see this name before it opens. Everything else stays sealed."
      />
      <fieldset className={p.fieldset}>
        <legend className={p.legend}>Files</legend>
        {draft.files.length ? (
          <ul className={p.files}>
            {draft.files.map((f) => (
              <li key={f.fileId} className={s.recipientHead}>
                <Icon name="file" size={18} />
                <b>{f.name}</b>
                <small>{fmtBytes(f.size)}</small>
                <Button
                  size="sm"
                  variant="ghost"
                  icon="trash"
                  aria-label={`Remove ${f.name}`}
                  onClick={() =>
                    change((d) => ({
                      ...d,
                      files: d.files.filter((x) => x.fileId !== f.fileId),
                      recipients: d.recipients.map((r) => ({ ...r, files: r.files.filter((x) => x !== f.fileId) })),
                    }))
                  }
                />
              </li>
            ))}
          </ul>
        ) : (
          <p className={p.hint}>No files yet. A message alone is fine too.</p>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label="Add files"
          onChange={(e) => void addFiles(e.target.files)}
        />
        <div className={p.chips}>
          <Button variant="line" icon="upload" busy={up !== null} onClick={() => fileInput.current?.click()}>
            {up ? `Sealing ${up.name} ${Math.round(up.p * 100)}%` : "Add files"}
          </Button>
        </div>
        <LockLine>Each file is encrypted on this device before it uploads.</LockLine>
      </fieldset>
      <fieldset className={p.fieldset}>
        <legend className={p.legend}>Who it is for</legend>
        <form
          className={s.recipientHead}
          onSubmit={(e) => {
            e.preventDefault();
            void addRecipient();
          }}
        >
          <TextField
            label="Their @name or address"
            hideLabel
            placeholder="@hana"
            value={who}
            onChange={(e) => setWho(e.target.value)}
            error={err ?? undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" variant="line" icon="plus" busy={busy}>
            Add
          </Button>
        </form>
        {draft.recipients.map((r) => (
          <div key={r.address} className={s.recipient}>
            <div className={s.recipientHead}>
              <Avatar name={r.name ?? r.address.slice(4, 6)} size={32} tone="matcha" />
              <b>{r.name ? `@${r.name}` : `${r.address.slice(0, 12)}…`}</b>
              <Button
                size="sm"
                variant="ghost"
                icon="trash"
                aria-label={`Remove ${r.name ?? "recipient"}`}
                onClick={() =>
                  change((d) => ({ ...d, recipients: d.recipients.filter((x) => x.address !== r.address) }))
                }
              />
            </div>
            {draft.files.length ? (
              <div className={s.fileChips} role="group" aria-label={`Files for ${r.name ?? "this recipient"}`}>
                {draft.files.map((f) => {
                  const on = r.files.includes(f.fileId);
                  return (
                    <button
                      key={f.fileId}
                      type="button"
                      className={p.pick}
                      aria-pressed={on}
                      onClick={() =>
                        change((d) => ({
                          ...d,
                          recipients: d.recipients.map((x) =>
                            x.address === r.address
                              ? { ...x, files: on ? x.files.filter((y) => y !== f.fileId) : [...x.files, f.fileId] }
                              : x,
                          ),
                        }))
                      }
                    >
                      {on ? <Icon name="check" size={14} /> : null}
                      {f.name}
                    </button>
                  );
                })}
              </div>
            ) : null}
            <TextArea
              label={`A message for ${r.name ? `@${r.name}` : "them"} (optional)`}
              rows={3}
              maxLength={2000}
              counter
              value={r.message}
              placeholder={`${r.name ?? "Hana"}, if you are reading this, the documents below are for you.`}
              onChange={(e) =>
                change((d) => ({
                  ...d,
                  recipients: d.recipients.map((x) =>
                    x.address === r.address ? { ...x, message: e.target.value } : x,
                  ),
                }))
              }
            />
          </div>
        ))}
        {draft.recipients.length > 1 ? (
          <p className={p.hint}>
            Each recipient opens only their own files and message. They can see who else is named.
          </p>
        ) : null}
      </fieldset>
    </>
  );
}

function When({
  draft,
  change,
  armed,
}: {
  draft: CapsuleDraft;
  change: (fn: (d: CapsuleDraft) => CapsuleDraft) => void;
  armed: boolean;
}) {
  const local = draft.releaseAt
    ? new Date(Date.parse(draft.releaseAt) - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
    : "";
  return (
    <>
      {armed ? (
        <LockLine>
          The timing is recorded on QoreChain and cannot change. To change it, cancel this capsule and make a new one.
        </LockLine>
      ) : null}
      <fieldset className={p.fieldset} disabled={armed}>
        <legend className={p.legend}>How it opens</legend>
        <Segmented
          label="How it opens"
          value={draft.mode}
          onChange={(v) => change((d) => ({ ...d, mode: v }))}
          options={MODES}
        />
        {draft.mode === "at-time" ? (
          <TextField
            label="Opens on"
            type="datetime-local"
            value={local}
            onChange={(e) =>
              change((d) => ({ ...d, releaseAt: e.target.value ? new Date(e.target.value).toISOString() : null }))
            }
            hint="In your time zone. QoreChain's clock decides the moment."
          />
        ) : draft.mode === "after-wait" ? (
          <>
            <p className={p.hint}>
              A guardian asks to open it. You then have this long to say no; if you do nothing, it opens.
            </p>
            <div className={p.chips} role="radiogroup" aria-label="Wait">
              {WAIT_PRESETS.map((w) => (
                <button
                  key={w.days}
                  type="button"
                  role="radio"
                  aria-checked={draft.waitSeconds === w.seconds}
                  className={p.pick}
                  onClick={() => change((d) => ({ ...d, waitSeconds: w.seconds }))}
                >
                  {w.label}
                  {w.days === 14 ? " (suggested)" : ""}
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <p className={p.hint}>
              If you don&rsquo;t check in for this long, it opens. We remind you from{" "}
              {durationText(warnLeadSeconds(draft.quietSeconds))} before, every time you open Mizuhiki.
            </p>
            <div className={p.chips} role="radiogroup" aria-label="Quiet period">
              {QUIET_PRESETS.map((q) => (
                <button
                  key={q.months}
                  type="button"
                  role="radio"
                  aria-checked={draft.quietSeconds === q.seconds}
                  className={p.pick}
                  onClick={() => change((d) => ({ ...d, quietSeconds: q.seconds }))}
                >
                  {q.label}
                  {q.months === 12 ? " (suggested)" : ""}
                </button>
              ))}
            </div>
          </>
        )}
      </fieldset>
      <fieldset className={p.fieldset} disabled={armed}>
        <legend className={p.legend}>How long they can collect it</legend>
        <div className={p.chips} role="radiogroup" aria-label="Collection window">
          {ACCESS_PRESETS.map((a) => (
            <button
              key={a.seconds}
              type="button"
              role="radio"
              aria-checked={draft.accessSeconds === a.seconds}
              className={p.pick}
              onClick={() => change((d) => ({ ...d, accessSeconds: a.seconds }))}
            >
              {a.label}
            </button>
          ))}
        </div>
      </fieldset>
      <ToggleRow
        title="Delete the sealed copies when that time ends"
        detail="Off: they stay until you delete them. On: after the window, no one can collect them, including recipients who have not yet."
        checked={draft.deleteAfter}
        onChange={(on) => change((d) => ({ ...d, deleteAfter: on }))}
      />
    </>
  );
}

function Guardians({
  draft,
  row,
  label,
  change,
  flush,
  tokened,
  reload,
  setNames,
}: {
  draft: CapsuleDraft;
  row: OwnedCapsule | null;
  label: (a: string) => string;
  change: (fn: (d: CapsuleDraft) => CapsuleDraft) => void;
  flush: (d: CapsuleDraft) => Promise<void>;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
  setNames: (fn: (n: Record<string, string | null>) => Record<string, string | null>) => void;
}) {
  const owner = useOwnerSession();
  const toast = useToast();
  const [who, setWho] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [words, setWords] = useState<string | null>(null);
  const list = (row?.guardians ?? []).filter((g) => g.status !== "removed");
  const live = list.filter((g) => g.status !== "declined");
  const confirmedN = live.filter((g) => g.status === "confirmed").length;

  useEffect(() => {
    if (!checking) return;
    setWords(null);
    const life = { alive: true };
    safetyWords(checking)
      .then((w) => life.alive && setWords(w))
      .catch(() => life.alive && setWords(""));
    return () => {
      life.alive = false;
    };
  }, [checking]);

  const invite = async () => {
    const problem = personProblem(who);
    if (problem) return setErr(problem);
    if (!draft.label.trim()) return setErr("Name the capsule first (step 1), so they know what they are guarding.");
    setBusy("invite");
    setErr(null);
    try {
      const found = await lookupPerson(who);
      if (!found) throw new Error("No Mizuhiki account has that name. Guardians need an account.");
      if (found.address === owner.account.owner.address) throw new Error("You cannot be your own guardian.");
      await cardOf(found.address);
      await flush(draft);
      await inviteGuardian(await tokened(), draft, found.address);
      setNames((n) => ({ ...n, [found.address]: found.name }));
      toast.show(`Invited ${found.name ? `@${found.name}` : "them"}. They accept from Capsules › You guard.`);
      setWho("");
      await reload();
    } catch (e) {
      setErr(failureText(e, "They were not invited."));
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <p>
        Guardians keep pieces of the key. They cannot open the capsule; they hand their pieces to the recipients when
        QoreChain says it is open. Pick people who will still be around.
      </p>
      <form
        className={s.recipientHead}
        onSubmit={(e) => {
          e.preventDefault();
          void invite();
        }}
      >
        <TextField
          label="Guardian's @name or address"
          hideLabel
          placeholder="@kenji"
          value={who}
          onChange={(e) => setWho(e.target.value)}
          error={err ?? undefined}
          autoComplete="off"
          spellCheck={false}
        />
        <Button type="submit" variant="line" icon="send" busy={busy === "invite"}>
          Invite
        </Button>
      </form>
      {list.map((g) => (
        <div key={g.guardian} className={s.recipientHead}>
          <Avatar name={label(g.guardian).replace("@", "")} size={32} tone="butter" />
          <b>{label(g.guardian)}</b>
          <StatusChip
            status={
              g.status === "confirmed"
                ? "ok"
                : g.status === "accepted"
                  ? "info"
                  : g.status === "declined"
                    ? "neutral"
                    : "wait"
            }
          >
            {g.status === "confirmed"
              ? "Confirmed"
              : g.status === "accepted"
                ? "Check their words"
                : g.status === "declined"
                  ? "Declined"
                  : "Invited"}
          </StatusChip>
          {g.status === "accepted" ? (
            <Button size="sm" variant="cord" icon="check" onClick={() => setChecking(g.guardian)}>
              Check words
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            icon="trash"
            aria-label={`Remove ${label(g.guardian)}`}
            busy={busy === `rm${g.guardian}`}
            onClick={() => {
              setBusy(`rm${g.guardian}`);
              void tokened()
                .then((t) => removeGuardian(t, draft.id, g.guardian))
                .then(reload)
                .finally(() => setBusy(null));
            }}
          />
        </div>
      ))}
      {confirmedN > 1 ? (
        <fieldset className={p.fieldset}>
          <legend className={p.legend}>How many must hand over their piece</legend>
          <Segmented
            label="Guardians needed"
            value={String(Math.min(draft.threshold, confirmedN))}
            onChange={(v) => change((d) => ({ ...d, threshold: Number(v) }))}
            options={Array.from({ length: confirmedN }, (_, i) => ({
              value: String(i + 1),
              label: `Any ${i + 1} of ${confirmedN}`,
            }))}
          />
          <p className={p.hint}>More needed is harder to open early; fewer still opens if someone is unreachable.</p>
        </fieldset>
      ) : null}
      <Sheet
        open={checking !== null}
        onClose={() => setChecking(null)}
        title={`Check it is really ${checking ? label(checking) : ""}`}
        dismissable={busy !== "confirm"}
      >
        <div className={p.form}>
          <p>
            Ask them to read the six safety words on their Capsules page, on a call or in person. Confirm only if every
            word matches.
          </p>
          {words === null ? (
            <Skeleton lines={1} />
          ) : words ? (
            <ul className={p.words} aria-label="Safety words">
              {words.split(" ").map((w, i) => (
                <li key={`${w}${i}`}>{w}</li>
              ))}
            </ul>
          ) : (
            <Oops title="Their key could not be read">Check your connection and try again.</Oops>
          )}
          <div className={p.actions}>
            <Button variant="ghost" onClick={() => setChecking(null)}>
              They don&rsquo;t match
            </Button>
            <Button
              variant="cord"
              icon="check"
              disabled={!words}
              busy={busy === "confirm"}
              onClick={() => {
                if (!checking) return;
                setBusy("confirm");
                void tokened()
                  .then((t) => confirmGuardian(t, draft.id, checking))
                  .then(async () => {
                    toast.show(`${label(checking)} is confirmed.`);
                    setChecking(null);
                    await reload();
                  })
                  .catch((e: unknown) => toast.show(failureText(e, "Not confirmed."), { tone: "error" }))
                  .finally(() => setBusy(null));
              }}
            >
              They match, confirm
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}

const ARM_LABEL: Record<ArmStep, string> = {
  content: "Sealing each recipient's files and message",
  pieces: "Sealing key pieces to your guardians",
  chain: "Recording the plan on QoreChain",
  sign: "Signing the plan",
};
const ARM_ORDER: ArmStep[] = ["content", "pieces", "chain", "sign"];

function ConfirmPlan({
  draft,
  row,
  confirmed,
  label,
  flush,
  tokened,
  reload,
}: {
  draft: CapsuleDraft;
  row: OwnedCapsule | null;
  confirmed: string[];
  label: (a: string) => string;
  flush: (d: CapsuleDraft) => Promise<void>;
  tokened: () => Promise<Tokened>;
  reload: () => Promise<void>;
}) {
  const toast = useToast();
  const router = useRouter();
  const [step, setStep] = useState<ArmStep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const prior = row?.plan ?? null;
  const pending = (row?.guardians ?? []).filter((g) => g.status === "invited" || g.status === "accepted");
  const problems = armProblems(draft, confirmed, prior !== null);
  if (pending.length)
    problems.push(
      `Wait for ${pending.map((g) => label(g.guardian)).join(", ")} to accept and be confirmed, or remove them.`,
    );
  const sentences = useMemo(
    () =>
      planSentences({
        mode: prior?.body.mode ?? draft.mode,
        releaseAt: prior?.body.releaseAt ?? (draft.releaseAt ? Math.floor(Date.parse(draft.releaseAt) / 1000) : 0),
        waitSeconds: prior?.body.waitSeconds ?? draft.waitSeconds,
        quietSeconds: prior?.body.quietSeconds ?? draft.quietSeconds,
        accessSeconds: prior?.body.accessSeconds ?? draft.accessSeconds,
        threshold: Math.min(draft.threshold, Math.max(1, confirmed.length)),
        deleteAfter: draft.deleteAfter,
        guardians: confirmed.length ? confirmed.map(label) : ["Your guardians"],
        recipients: draft.recipients.length
          ? draft.recipients.map((r) => (r.name ? `@${r.name}` : "your recipient"))
          : ["your recipients"],
      }),
    [draft, confirmed, label, prior],
  );
  const go = async () => {
    setErr(null);
    setStep("content");
    const cur: { at: ArmStep } = { at: "content" };
    try {
      await flush(draft);
      await arm(await tokened(), draft, confirmed, prior, (x) => {
        cur.at = x;
        setStep(x);
      });
      toast.show(prior ? "Updated. Old key pieces no longer fit." : "Armed on QoreChain.");
      setStep(null);
      await reload();
    } catch (e) {
      setStep(cur.at);
      setErr(failureText(e, "It was not armed. Nothing was recorded."));
    }
  };
  const i = step ? ARM_ORDER.indexOf(step) : -1;
  const steps: SealStep[] = ARM_ORDER.map((x, j) => ({
    label: ARM_LABEL[x],
    state: j < i ? "done" : j === i ? (err ? "failed" : "running") : "waiting",
  }));
  return (
    <>
      <ul className={s.plan} aria-label="Your plan">
        {sentences.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <p className={s.danger}>
        {Math.min(draft.threshold, Math.max(1, confirmed.length)) === 1
          ? "Any one guardian could hand over their piece early. Ask for more guardians to be needed to make that harder."
          : `If ${Math.min(draft.threshold, confirmed.length)} guardians agree among themselves, they could open it early. Fewer cannot.`}{" "}
        QoreChain has no time lock of its own, so this is a wait guarded by people and the chain.
      </p>
      {problems.length ? (
        <ul className={p.hint}>
          {problems.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      ) : null}
      <div className={p.actions}>
        {!prior ? (
          <Button variant="ghost" icon="trash" onClick={() => setDeleting(true)}>
            Delete draft
          </Button>
        ) : null}
        <Button variant="cord" icon="lock" disabled={problems.length > 0} onClick={() => void go()}>
          {prior ? "Update the plan" : "Confirm and arm"}
        </Button>
      </div>
      <Sheet
        open={step !== null}
        onClose={() => setStep(null)}
        title={prior ? "Updating the plan" : "Arming your capsule"}
        dismissable={err !== null}
      >
        <SealMoment
          steps={steps}
          progress={(i + 1) / ARM_ORDER.length}
          note={<>On your device. QoreChain records only the plan&rsquo;s fingerprint.</>}
        />
        {err ? (
          <div className={p.form}>
            <p className={p.err} role="alert">
              {err}
            </p>
            <div className={p.actions}>
              <Button variant="quiet" onClick={() => setStep(null)}>
                Close
              </Button>
              <Button variant="cord" icon="undo" onClick={() => void go()}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
      <Confirm
        open={deleting}
        title="Delete this draft?"
        confirm="Delete"
        onClose={() => setDeleting(false)}
        onConfirm={() =>
          void tokened()
            .then((t) => deleteDraft(t, draft.id))
            .then(() => router.push("/app/capsules"))
        }
      >
        <p>Nothing was armed, so nothing is recorded on QoreChain. Invited guardians see it disappear.</p>
      </Confirm>
    </>
  );
}
