"use client";
/**
 * One pass, from either side (spec 5.12 steps 2-5).
 * Owner: the boundary, the three-step handshake (invite, accept, confirm with
 * six safety words read from the holder's key on QoreChain, as Bitwarden's
 * fingerprint phrase), what the pass covers, "Bring up to date", Revoke.
 * Holder: the invite in plain words, Accept or Decline, their own safety words,
 * then what the pass lets them read, opened on their device.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Avatar,
  Button,
  ButtonLink,
  Chip,
  CopyValue,
  EmptyState,
  Icon,
  Kicker,
  LockLine,
  Oops,
  SealMoment,
  Sheet,
  Skeleton,
  StatusChip,
  TypeChip,
  useToast,
  type SealStep,
} from "@mizuhiki/ui";
import type { Content, FileFacts } from "@mizuhiki/core";
import { useOwnerSession } from "@/owner/OwnerProvider";
import { SITE_URL } from "@/lib/site";
import { nameOf, safetyWords } from "@/rooms/engine";
import { FileItem, FormAnswer } from "@/inbox/Detail";
import { InvoiceView } from "@/invoices/InvoiceView";
import { ContentReader } from "@/shop/buyer/OrderPage";
import { Confirm } from "@/shop/seller/bits";
import {
  acceptPass,
  bringUpToDate,
  confirmPass,
  declinePass,
  formDefFor,
  getPass,
  openPassItems,
  openPassProduct,
  revokePass,
  type ConfirmStep,
  type PassItem,
  type PassView,
} from "./engine";
import { chipOf, periodLabel, scopeLine } from "./model";
import { usePassHooks } from "./usePassHooks";
import { usePassEvents } from "./usePassEvents";
import s from "./passes.module.css";
import { failureText } from "@/lib/failure";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
/** The last day an expiry covers, in UTC like the boundary sentence. */
const lastDay = (iso: string) =>
  new Date(Date.parse(iso) - 1).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export function PassDetail({ id }: { id: string }) {
  const owner = useOwnerSession();
  const [pass, setPass] = useState<PassView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [names, setNames] = useState<Record<string, string | null>>({});

  const load = useCallback(async () => {
    try {
      const p = await getPass({ ...owner.account, token: await owner.token() }, id);
      setPass(p);
      setError(null);
      const both = await Promise.all(
        [p.owner, p.holder].map(async (a) => [a, await nameOf(a).catch(() => null)] as const),
      );
      setNames(Object.fromEntries(both));
    } catch (e) {
      setError(failureText(e, "This pass could not be loaded. Nothing changed."));
    }
  }, [owner, id]);
  useEffect(() => {
    void load();
  }, [load]);
  usePassEvents(() => void load());

  const label = (a: string) => (names[a] ? `@${names[a]}` : `${a.slice(0, 10)}…${a.slice(-4)}`);
  if (error)
    return (
      <div className={s.page}>
        <Back />
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
      </div>
    );
  if (!pass)
    return (
      <div className={s.page}>
        <Back />
        <Skeleton lines={5} />
      </div>
    );
  const side = pass.owner === owner.account.owner.address ? "owner" : "holder";
  const other = side === "owner" ? pass.holder : pass.owner;
  const chip = chipOf(pass, side);
  return (
    <div className={s.page}>
      <Back />
      <header className={s.top}>
        <Avatar name={names[other] ?? other.slice(4, 6)} size={56} tone={side === "owner" ? "matcha" : "sora"} />
        <div className={s.titleBlock}>
          <Kicker>{side === "owner" ? "あいかぎ" : "おまかせ"}</Kicker>
          <div className={s.titleWithChip}>
            <h1>{side === "owner" ? `Pass for ${label(other)}` : `Pass from ${label(other)}`}</h1>
            <StatusChip status={chip.status}>{chip.label}</StatusChip>
          </div>
          <p className={s.lede}>{scopeLine(pass.invite.body.scope)}</p>
        </div>
      </header>
      <div className={s.detail}>
        <div className={s.body}>
          <Boundary pass={pass} />
          {side === "owner" ? (
            <OwnerSide pass={pass} holder={label(pass.holder)} onChanged={load} />
          ) : (
            <HolderSide pass={pass} from={label(pass.owner)} onChanged={load} />
          )}
        </div>
        <Facts pass={pass} label={label} />
      </div>
    </div>
  );
}

function Back() {
  return (
    <Link href="/app/passes" className={s.back}>
      <Icon name="back" size={16} /> All passes
    </Link>
  );
}

function Boundary({ pass }: { pass: PassView }) {
  const inv = pass.invite.body;
  return (
    <section className={s.boundary}>
      <h3>
        <Icon name="lock" size={14} /> The boundary, as both of you saw it
      </h3>
      <p>{inv.boundary}</p>
      {inv.note ? <p className={s.note}>“{inv.note}”</p> : null}
    </section>
  );
}

function Facts({ pass, label }: { pass: PassView; label: (a: string) => string }) {
  const sc = pass.invite.body.scope;
  return (
    <aside className={s.panel} aria-label="Pass details">
      <dl className={s.facts}>
        <div>
          <dt>Owner</dt>
          <dd>{label(pass.owner)}</dd>
        </div>
        <div>
          <dt>Holder</dt>
          <dd>{label(pass.holder)}</dd>
        </div>
        {sc.kind === "period" ? (
          <div>
            <dt>Period</dt>
            <dd>{periodLabel(sc.from, sc.until)}</dd>
          </div>
        ) : null}
        <div>
          <dt>New items</dt>
          <dd>{pass.expiresAt ? `Through ${lastDay(pass.expiresAt)}` : "Until revoked"}</dd>
        </div>
        <div>
          <dt>Invited</dt>
          <dd>{when(pass.createdAt)}</dd>
        </div>
        {pass.acceptedAt ? (
          <div>
            <dt>Accepted</dt>
            <dd>{when(pass.acceptedAt)}</dd>
          </div>
        ) : null}
        {pass.confirmedAt ? (
          <div>
            <dt>Confirmed</dt>
            <dd>{when(pass.confirmedAt)}</dd>
          </div>
        ) : null}
        {pass.revokedAt ? (
          <div>
            <dt>Revoked</dt>
            <dd>{when(pass.revokedAt)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Reference</dt>
          <dd className={s.mono}>{pass.id}</dd>
        </div>
      </dl>
      <LockLine>The invite and acceptance are signed with each person&rsquo;s post-quantum key.</LockLine>
    </aside>
  );
}

function Steps({ pass }: { pass: PassView }) {
  const at = pass.status === "invited" ? 1 : pass.status === "accepted" ? 2 : 3;
  const items = [
    { t: "Invite sent", d: "Signed by you, with the boundary above." },
    { t: "They accept", d: "Signed with their own key." },
    {
      t: "You compare safety words",
      d: "Six words read from their key on QoreChain. Then the pass is sealed to them.",
    },
  ];
  return (
    <ol className={s.steps}>
      {items.map((x, i) => (
        <li key={x.t} className={i < at ? s.stepDone : i === at ? s.stepNow : ""}>
          <span className={s.stepDot}>{i < at ? <Icon name="check" size={14} /> : i + 1}</span>
          <span>
            <b>{x.t}</b>
            <small>{x.d}</small>
          </span>
        </li>
      ))}
    </ol>
  );
}

const STEP_LABEL: Record<ConfirmStep, string> = {
  keys: "Finding their key on QoreChain",
  seal: "Sealing the pass key to them",
  room: "Adding them to the room, read-only",
  form: "Adding them as a reader of the form",
  page: "Signing your page with the pass key",
  catchup: "Sealing earlier items to them",
};
function stepsFor(pass: PassView, at: ConfirmStep | null, failed: boolean): SealStep[] {
  const k = pass.invite.body.scope.kind;
  const order: ConfirmStep[] =
    k === "period"
      ? ["keys", "seal", "page", "catchup"]
      : k === "product"
        ? ["keys", "seal"]
        : k === "room"
          ? ["room"]
          : ["form", "catchup"];
  const i = at ? order.indexOf(at) : -1;
  return order.map((x, j) => ({
    label: STEP_LABEL[x],
    state: j < i ? "done" : j === i ? (failed ? "failed" : "running") : "waiting",
  }));
}

function OwnerSide({ pass, holder, onChanged }: { pass: PassView; holder: string; onChanged: () => Promise<void> }) {
  const owner = useOwnerSession();
  const toast = useToast();
  const hooksFor = usePassHooks();
  const [words, setWords] = useState<string | null>(null);
  const [wordsError, setWordsError] = useState<string | null>(null);
  const [step, setStep] = useState<ConfirmStep | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<"ask" | "busy" | "mismatch" | null>(null);
  const [catching, setCatching] = useState(false);

  useEffect(() => {
    if (pass.status !== "accepted") return;
    const life = { alive: true };
    safetyWords(pass.holder)
      .then((w) => life.alive && setWords(w))
      .catch(
        (e: unknown) => life.alive && setWordsError(failureText(e, "Their key could not be read from QoreChain.")),
      );
    return () => {
      life.alive = false;
    };
  }, [pass.status, pass.holder]);

  const confirm = async () => {
    setConfirmError(null);
    setStep(null);
    const cur: { at: ConfirmStep | null } = { at: null };
    try {
      const { t, hooks } = await hooksFor();
      await confirmPass(t, pass, hooks, (x) => {
        cur.at = x;
        setStep(x);
      });
      toast.show(`The pass is active. ${holder} can read what it covers.`);
      setStep(null);
      await onChanged();
    } catch (e) {
      setStep(cur.at ?? "keys");
      setConfirmError(failureText(e, "The pass was not confirmed. Nothing was shared."));
    }
  };

  const revoke = async () => {
    setRevoking("busy");
    try {
      const { t, hooks } = await hooksFor();
      await revokePass(t, pass, hooks);
      toast.show(
        pass.status === "invited" || pass.status === "accepted"
          ? "The invite is cancelled."
          : `Revoked. New items are no longer sealed to ${holder}.`,
      );
      setRevoking(null);
      await onChanged();
    } catch (e) {
      setRevoking("ask");
      toast.show(failureText(e, "It was not revoked. Nothing changed."), {
        tone: "error",
      });
    }
  };

  const catchUp = async () => {
    setCatching(true);
    try {
      const r = await bringUpToDate({ ...owner.account, token: await owner.token() }, pass);
      toast.show(
        r.added
          ? `${r.added} ${r.added === 1 ? "item" : "items"} sealed to ${holder}. The pass covers ${r.covered} ${r.covered === 1 ? "item" : "items"}.`
          : `Up to date. The pass covers ${r.covered} ${r.covered === 1 ? "item" : "items"}.`,
      );
      await onChanged();
    } catch (e) {
      toast.show(failureText(e, "Nothing new was sealed. Try again."), {
        tone: "error",
      });
    } finally {
      setCatching(false);
    }
  };

  const link = `${SITE_URL}/app/passes/${pass.id}`;
  const scopeKind = pass.invite.body.scope.kind;
  const live =
    pass.status === "invited" || pass.status === "accepted" || pass.status === "active" || pass.status === "expired";
  return (
    <>
      {pass.status === "invited" || pass.status === "accepted" ? (
        <section className={s.panel}>
          <h2>{pass.status === "invited" ? `Waiting for ${holder} to accept` : `Check it is really ${holder}`}</h2>
          <Steps pass={pass} />
          {pass.status === "invited" ? (
            <>
              <p>They see the invite under Passes › Shared with me. You can also send them this link.</p>
              <CopyValue value={link} label="Invite link" />
            </>
          ) : wordsError ? (
            <Oops title="Their key could not be read">{wordsError}</Oops>
          ) : words === null ? (
            <Skeleton lines={2} />
          ) : (
            <>
              <p>
                Ask {holder} to read the six safety words on their pass screen, on a call or in person. Confirm only if
                every word matches, in order.
              </p>
              <ul className={s.words} aria-label="Safety words">
                {words.split(/\s+/).map((w, i) => (
                  <li key={`${w}${i}`}>{w}</li>
                ))}
              </ul>
              <div className={s.actions}>
                <Button variant="ghost" icon="alert" onClick={() => setRevoking("mismatch")}>
                  They don&rsquo;t match
                </Button>
                <Button
                  variant="cord"
                  icon="check"
                  onClick={() => void confirm()}
                  disabled={step !== null && !confirmError}
                >
                  They match, confirm
                </Button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {pass.status === "active" ? (
        <section className={s.panel}>
          <h2>Active</h2>
          {scopeKind === "period" || scopeKind === "form" ? (
            <>
              <p>
                New items in scope are sealed to {holder} as they arrive. Older items, invoices, and anything a
                sender&rsquo;s browser missed are sealed from this device.
              </p>
              <div className={s.covered}>
                <Chip tone="matcha" icon="lock">
                  {pass.resealed ?? 0} older {(pass.resealed ?? 0) === 1 ? "item" : "items"} sealed to them
                </Chip>
                <Button variant="line" icon="undo" busy={catching} onClick={() => void catchUp()}>
                  {catching ? "Sealing" : "Seal older items too"}
                </Button>
              </div>
            </>
          ) : scopeKind === "room" ? (
            <p>
              {holder} is in the room as a read-only member, with its past messages. Removing them changes the
              room&rsquo;s key.
            </p>
          ) : (
            <p>{holder} can open this product&rsquo;s content page and files. They cannot see sales or buyers.</p>
          )}
        </section>
      ) : null}

      {pass.status === "expired" ? (
        <section className={s.panel}>
          <h2>Expired</h2>
          <p>
            New items are no longer sealed to {holder}. What the pass covered before it ended stays readable to them.
          </p>
        </section>
      ) : null}
      {pass.status === "revoked" || pass.status === "declined" ? (
        <section className={s.panel}>
          <h2>{pass.status === "revoked" ? "Revoked" : `${holder} declined`}</h2>
          <p>
            {pass.status === "revoked"
              ? `${holder} keeps anything already opened. Future items are not sealed to them.`
              : "Nothing was shared. You can make a new pass any time."}
          </p>
          <ButtonLink href="/app/passes" variant="line" icon="plus">
            New pass
          </ButtonLink>
        </section>
      ) : null}

      {live ? (
        <div className={s.actions}>
          <Button variant="danger" icon="x" onClick={() => setRevoking("ask")}>
            {pass.status === "invited" || pass.status === "accepted" ? "Cancel invite" : "Revoke"}
          </Button>
        </div>
      ) : null}

      <Sheet
        open={step !== null}
        onClose={() => setStep(null)}
        title="Confirming the pass"
        dismissable={confirmError !== null}
      >
        <SealMoment
          steps={stepsFor(pass, step, confirmError !== null)}
          progress={
            step
              ? (stepsFor(pass, step, false).findIndex((x) => x.state === "running") + 1) /
                stepsFor(pass, step, false).length
              : 0
          }
          note={<>On your device. Keys are sealed here before they leave.</>}
        />
        {confirmError ? (
          <div className={s.form}>
            <p className={s.err} role="alert">
              {confirmError}
            </p>
            <div className={s.actions}>
              <Button variant="quiet" onClick={() => setStep(null)}>
                Close
              </Button>
              <Button variant="cord" icon="undo" onClick={() => void confirm()}>
                Try again
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>

      <Confirm
        open={revoking !== null}
        title={
          revoking === "mismatch"
            ? "Cancel this invite?"
            : pass.status === "invited" || pass.status === "accepted"
              ? "Cancel the invite?"
              : `Revoke ${holder}'s pass?`
        }
        confirm={pass.status === "invited" || pass.status === "accepted" ? "Cancel invite" : "Revoke"}
        busy={revoking === "busy"}
        onClose={() => setRevoking(null)}
        onConfirm={() => void revoke()}
      >
        {revoking === "mismatch" ? (
          <p>
            If the words differ, the key on chain may not be theirs. Cancel this invite and check their @name with them
            another way. Nothing has been shared.
          </p>
        ) : pass.status === "invited" || pass.status === "accepted" ? (
          <p>Nothing has been shared yet. {holder} will see that the invite was cancelled.</p>
        ) : (
          <p>
            {holder} keeps anything already opened. Future items are not sealed to them.
            {scopeKind === "room"
              ? " They leave the room and its key changes."
              : scopeKind === "form"
                ? " They stop being a reader of the form."
                : ""}
          </p>
        )}
      </Confirm>
    </>
  );
}

function HolderSide({ pass, from, onChanged }: { pass: PassView; from: string; onChanged: () => Promise<void> }) {
  const owner = useOwnerSession();
  const toast = useToast();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [words, setWords] = useState<string | null>(null);

  useEffect(() => {
    if (pass.status !== "accepted") return;
    const life = { alive: true };
    safetyWords(owner.account.owner.address)
      .then((w) => life.alive && setWords(w))
      .catch(() => life.alive && setWords(""));
    return () => {
      life.alive = false;
    };
  }, [pass.status, owner.account.owner.address]);

  const act = async (what: "accept" | "decline") => {
    setBusy(what);
    try {
      const t = { ...owner.account, token: await owner.token() };
      if (what === "accept") await acceptPass(t, pass);
      else await declinePass(t, pass);
      toast.show(
        what === "accept" ? `Accepted. ${from} will compare safety words with you.` : "Declined. Nothing was shared.",
      );
      await onChanged();
    } catch (e) {
      toast.show(failureText(e, "That did not work. Nothing changed."), {
        tone: "error",
      });
    } finally {
      setBusy(null);
    }
  };

  if (pass.status === "invited")
    return (
      <section className={s.panel}>
        <h2>{from} wants to give you read-only access</h2>
        <p>
          Accepting signs a short note with your key. Nothing is shared until {from} compares safety words with you.
        </p>
        <div className={s.actions}>
          <Button
            variant="ghost"
            busy={busy === "decline"}
            disabled={busy !== null}
            onClick={() => void act("decline")}
          >
            Decline
          </Button>
          <Button
            variant="cord"
            icon="check"
            busy={busy === "accept"}
            disabled={busy !== null}
            onClick={() => void act("accept")}
          >
            {busy === "accept" ? "Signing" : "Accept"}
          </Button>
        </div>
      </section>
    );
  if (pass.status === "accepted")
    return (
      <section className={s.panel}>
        <h2>Your safety words</h2>
        <p>
          Read these to {from} on a call or in person. They confirm the pass only if every word matches what they see.
        </p>
        {words === null ? (
          <Skeleton lines={1} />
        ) : words ? (
          <ul className={s.words} aria-label="Your safety words">
            {words.split(/\s+/).map((w, i) => (
              <li key={`${w}${i}`}>{w}</li>
            ))}
          </ul>
        ) : (
          <Oops title="Your key could not be read">Check your connection and reload.</Oops>
        )}
      </section>
    );
  if (pass.status === "declined")
    return (
      <section className={s.panel}>
        <h2>You declined</h2>
        <p>Nothing was shared.</p>
      </section>
    );
  return <HolderContent pass={pass} from={from} />;
}

function HolderContent({ pass, from }: { pass: PassView; from: string }) {
  const owner = useOwnerSession();
  const scope = pass.invite.body.scope;
  const [items, setItems] = useState<PassItem[] | null>(null);
  const [product, setProduct] = useState<Content | null | "none">(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<PassItem | null>(null);

  useEffect(() => {
    const life = { alive: true };
    void (async () => {
      try {
        const t = { ...owner.account, token: await owner.token() };
        if (scope.kind === "product") {
          const c = await openPassProduct(owner.account, pass);
          if (life.alive) setProduct(c ?? "none");
        } else if (scope.kind !== "room") {
          const list = await openPassItems(t, pass);
          if (life.alive) setItems(list);
        }
      } catch (e) {
        if (life.alive) setError(failureText(e, "What this pass covers could not be opened."));
      }
    })();
    return () => {
      life.alive = false;
    };
  }, [owner, pass, scope.kind]);

  const ended =
    pass.status !== "active" ? (
      <LockLine>
        {pass.status === "revoked"
          ? `${from} revoked this pass. You keep what it covered; nothing new arrives.`
          : "This pass has ended. You keep what it covered; nothing new arrives."}
      </LockLine>
    ) : null;

  if (scope.kind === "room")
    return (
      <section className={s.panel}>
        <h2>Room: {scope.label}</h2>
        {ended}
        <p>You are a read-only member, with its past messages.</p>
        {pass.status === "active" ? (
          <ButtonLink href={`/app/rooms/${scope.roomId}`} variant="cord" icon="chat">
            Open the room
          </ButtonLink>
        ) : null}
      </section>
    );
  if (error) return <Oops title="Not opened">{error}</Oops>;
  if (scope.kind === "product")
    return (
      <section className={s.panel}>
        <h2>{scope.label}</h2>
        {ended}
        {product === null ? (
          <Skeleton lines={4} />
        ) : product === "none" ? (
          <p>This product has no content page.</p>
        ) : (
          <div className={s.product}>
            <ContentReader content={product} />
          </div>
        )}
        <LockLine>Opened on this device with the key {from} sealed to you.</LockLine>
      </section>
    );
  return (
    <section className={s.panel}>
      <h2>What this pass covers</h2>
      {ended}
      {items === null ? (
        <Skeleton lines={4} />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing here yet" face="sleepy" jp="まだだよ">
          Items in this pass&rsquo;s scope show here when {from} receives or sends them.
        </EmptyState>
      ) : (
        <ul className={s.items}>
          {items.map((it) => (
            <li key={it.source}>
              <ItemRow it={it} onOpen={() => setOpen(it)} />
            </li>
          ))}
        </ul>
      )}
      <LockLine>Everything here is opened on this device. Mizuhiki only holds sealed copies.</LockLine>
      <Sheet open={open !== null} onClose={() => setOpen(null)} title={open ? titleOf(open) : ""} wide>
        {open ? <ItemBody it={open} owner={pass.owner} /> : null}
      </Sheet>
    </section>
  );
}

const noToken = () => Promise.reject(new Error("not used"));

const TYPE: Record<string, { label: string; tone: "sakura" | "sora" | "matcha" | "butter" | "fuji" }> = {
  message: { label: "Message", tone: "sakura" },
  reply: { label: "Reply", tone: "sakura" },
  paynote: { label: "Payment note", tone: "matcha" },
  form: { label: "Form answer", tone: "fuji" },
  invoice: { label: "Invoice", tone: "sora" },
};
export function titleOf(it: PassItem): string {
  if ("doc" in it) return `Invoice ${it.doc.number}`;
  return TYPE[it.kind]?.label ?? "Item";
}
function snippet(it: PassItem): string {
  if ("error" in it) return it.error;
  if ("doc" in it) return it.doc.billTo.business || it.doc.billTo.label || "Invoice";
  const o = it.opened;
  if (o.kind === "message")
    return (
      o.text.slice(0, 120) ||
      (o.files.length ? `${o.files.length} ${o.files.length === 1 ? "file" : "files"}` : "Message")
    );
  if (o.kind === "paynote") return o.note.slice(0, 120);
  const n = Object.keys(o.answers).filter((k) => !k.includes(":")).length;
  return `${n} ${n === 1 ? "answer" : "answers"}`;
}
export function ItemRow({ it, onOpen }: { it: PassItem; onOpen: () => void }) {
  const t = TYPE[it.kind] ?? { label: it.kind, tone: "sakura" as const };
  const bad = "error" in it;
  return (
    <button type="button" className={s.itemRow} aria-disabled={bad} onClick={bad ? undefined : onOpen}>
      <TypeChip tone={t.tone}>{t.label}</TypeChip>
      <span>
        <b>{snippet(it)}</b>
        {bad ? <small>Sealed, not yet shared with this pass</small> : null}
      </span>
      <span className={s.time}>{when(it.at)}</span>
    </button>
  );
}
/** One opened item, for a pass holder or an offline reader (no account needed). */
export function ItemBody({ it, owner }: { it: PassItem; owner: string }) {
  if ("error" in it) return <p>{it.error}</p>;
  if ("doc" in it) return <InvoiceView doc={it.doc} sentAt={it.at} />;
  const o = it.opened;
  // Questions come from the verified form (loadDef), so no session is used.
  if (o.kind === "form") return <FormAnswer answer={o} token={noToken} loadDef={() => formDefFor(owner, o.formId)} />;
  return (
    <div className={s.opened}>
      {o.kind === "message" ? (
        <>
          {o.text ? <p>{o.text}</p> : null}
          {o.contact ? <p className={s.hint}>From: {o.contact}</p> : null}
          {o.files.length ? (
            <ul className={s.files}>
              {o.files.map((f: FileFacts) => (
                <FileItem key={f.fileId} f={f} />
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p>{o.note}</p>
      )}
      <LockLine>Opened on this device.</LockLine>
    </div>
  );
}
