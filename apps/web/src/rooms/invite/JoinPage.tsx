"use client";
/**
 * The page an invite link opens (spec 5.10 "Invites"). The link's key is in
 * the fragment, which browsers never send to a server: it opens the room card
 * here, and a secret derived from it proves the link when asking to join. The
 * room key itself is sealed to the newcomer only by an admin's browser.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Avatar,
  Button,
  ButtonLink,
  Chip,
  Icon,
  Kicker,
  Knot,
  LockLine,
  Musubi,
  Oops,
  Skeleton,
  TextField,
  Wordmark,
  burstFrom,
  useToast,
  type MusubiFace,
} from "@mizuhiki/ui";
import { ROOM_TEMPLATES } from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { ApiFailure } from "@/lib/api";
import {
  cancelRequest,
  joinWithInvite,
  openInvite,
  rememberRoomCard,
  withToken,
  type InviteCard,
  type InvitePreview,
} from "../engine";
import { toneOf, useSealedPhoto } from "../people";
import { useRoomEvents } from "../useRoom";
import { fmtWhen, isInviteId, keyFromFragment } from "./limits";
import s from "./invite.module.css";
import { failureText } from "@/lib/failure";

type Load =
  | { s: "loading" }
  | { s: "damaged" }
  | { s: "not-found" }
  | { s: "deleted" }
  | { s: "error"; detail: string }
  | { s: "ok"; preview: InvitePreview; card: InviteCard };

/** Where a link's key waits while the person signs up or logs in (this tab only; never sent anywhere). */
const keySlot = (id: string) => `mzk:join:${id}`;

function readKey(id: string): string | null {
  const fromHash = keyFromFragment(window.location.hash);
  try {
    if (fromHash) sessionStorage.setItem(keySlot(id), fromHash);
    return fromHash ?? keyFromFragment(`k=${sessionStorage.getItem(keySlot(id)) ?? ""}`);
  } catch {
    return fromHash;
  }
}

export function JoinPage({ id }: { id: string }) {
  const acct = useAccount();
  const router = useRouter();
  const toast = useToast();
  const [seed, setSeed] = useState<string | null | undefined>(undefined);
  const [load, setLoad] = useState<Load>({ s: "loading" });
  const [busy, setBusy] = useState<"join" | "cancel" | null>(null);
  const [actionError, setActionError] = useState<{ title: string; detail: string; setup?: boolean } | null>(null);
  const [admitted, setAdmitted] = useState(false);
  const knot = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSeed(isInviteId(id) ? readKey(id) : null);
  }, [id]);

  const signedIn = acct.status === "unlocked" && !!acct.account;
  const token = acct.token;
  const settled = acct.status !== "loading";

  const refresh = useCallback(async () => {
    if (!seed) return;
    const t = signedIn ? await token().catch(() => undefined) : undefined;
    try {
      const r = await openInvite(id, seed, t);
      setLoad({ s: "ok", ...r });
    } catch (e) {
      if (e instanceof ApiFailure) {
        if (e.status === 404) return setLoad({ s: "not-found" });
        if (e.status === 410) return setLoad({ s: "deleted" });
        return setLoad({ s: "error", detail: e.message });
      }
      // Every network or server failure is an ApiFailure; anything else means the link's key did not open the card.
      setLoad({ s: "damaged" });
    }
  }, [id, seed, signedIn, token]);

  useEffect(() => {
    if (seed === undefined) return;
    if (seed === null) {
      setLoad(isInviteId(id) ? { s: "damaged" } : { s: "not-found" });
      return;
    }
    if (settled) void refresh();
  }, [seed, settled, refresh, id]);

  const you = load.s === "ok" ? load.preview.you : null;
  const roomId = load.s === "ok" ? load.preview.roomId : null;
  const waiting = you === "request-pending" || you === "request-approved";

  // While waiting: the live socket says "room" when an admin lets you in or declines; a gentle poll covers a dropped socket.
  useRoomEvents((kind) => {
    if (kind === "room" && waiting) void refresh();
  });
  useEffect(() => {
    if (!waiting) return;
    const h = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    return () => clearInterval(h);
  }, [waiting, refresh]);

  // Let in, or already a member: say so, then open the room.
  useEffect(() => {
    if (you !== "active" || !roomId) return;
    setAdmitted(true);
    burstFrom(knot.current, 16);
    try {
      sessionStorage.removeItem(keySlot(id));
    } catch {
      // Storage refused: nothing to clean.
    }
    const h = setTimeout(() => router.push(`/app/rooms/${roomId}`), 1800);
    return () => clearTimeout(h);
  }, [you, roomId, router, id]);

  const join = async () => {
    if (!seed || !acct.account || load.s !== "ok") return;
    setBusy("join");
    setActionError(null);
    try {
      const r = await joinWithInvite(await acct.token(), id, seed);
      await rememberRoomCard(acct.account, r.roomId, load.card);
      await refresh();
      if (r.status === "pending")
        toast.show(load.preview.approval ? "Request sent to the admins" : "You are on the list");
    } catch (e) {
      const code = e instanceof ApiFailure ? e.code : "";
      if (code === "NO_ACCOUNT")
        setActionError({
          title: "Your account is not finished",
          detail: "Finish setting up your account first, so the room key can be sealed to you. You have not joined.",
          setup: true,
        });
      else
        setActionError({
          title: "You have not joined",
          detail: failureText(e, "You have not joined. Nothing changed; try again."),
        });
      if (e instanceof ApiFailure && (e.status === 410 || e.status === 403)) void refresh();
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (!acct.account || !roomId) return;
    setBusy("cancel");
    setActionError(null);
    try {
      await cancelRequest(withToken(acct.account, await acct.token()), roomId);
      await refresh();
      toast.show("Request cancelled");
    } catch (e) {
      setActionError({
        title: "Not cancelled",
        detail: `${failureText(e, "That did not finish.")} Your request is still waiting.`,
      });
    } finally {
      setBusy(null);
    }
  };

  const next = `/join/${id}`;

  return (
    <div className={s.stage}>
      <header className={s.top}>
        <Wordmark size={22} href="/" />
      </header>
      <main className={s.main}>
        {load.s === "loading" || seed === undefined ? (
          <div className={s.invite} aria-busy="true">
            <p className={s.muted}>Opening the invite on this device with the key in your link…</p>
            <Skeleton avatar lines={4} />
          </div>
        ) : load.s === "damaged" ? (
          <Problem face="worried" title="This link is damaged" jp="あれ？">
            Invite links carry their key after the # sign, and this one is missing or cut short. Ask for the full link
            again. Nothing was opened.
          </Problem>
        ) : load.s === "not-found" ? (
          <Problem face="sleepy" title="There is no invite at this link" jp="あれ？">
            Check the link with the person who sent it. Nothing was opened.
          </Problem>
        ) : load.s === "deleted" ? (
          <Problem face="sleepy" title="This room was deleted" jp="おしまい">
            Its owner deleted the room, so there is nothing to join. Nothing was opened.
          </Problem>
        ) : load.s === "error" ? (
          <Problem
            face="worried"
            title="The invite could not be opened"
            jp="あれ？"
            action={
              <Button variant="line" icon="undo" onClick={() => void refresh()}>
                Try again
              </Button>
            }
          >
            {load.detail} You have not joined anything.
          </Problem>
        ) : (
          <InviteCardView preview={load.preview} card={load.card} cardRef={knot} admitted={admitted}>
            {admitted ? (
              <div className={s.state}>
                <Kicker>ようこそ</Kicker>
                <h2 className={s.stateTitle}>You’re in</h2>
                <p className={s.muted}>Opening the room…</p>
                <ButtonLink href={`/app/rooms/${load.preview.roomId}`} variant="cord" size="lg" full iconRight="arrow">
                  Open the room
                </ButtonLink>
              </div>
            ) : load.preview.state !== "ok" && !waiting ? (
              <LinkStopped state={load.preview.state} expiresAt={load.preview.expiresAt} />
            ) : you === "blocked" ? (
              <p className={s.warn}>
                <Icon name="alert" size={18} />
                <span>
                  An admin removed you from this room and blocked you from joining again. Only an admin can undo that.
                </span>
              </p>
            ) : waiting ? (
              <div className={s.state}>
                <div className={s.waitMark} aria-hidden="true">
                  <Musubi face="sleepy" size={72} bob />
                </div>
                <Kicker>ちょっと待ってね</Kicker>
                <h2 className={s.stateTitle}>
                  {load.preview.approval ? "Waiting for an admin to let you in" : "Waiting for an admin’s device"}
                </h2>
                <p className={s.muted}>
                  {load.preview.approval
                    ? "The room key is sealed to you only when they do. This page updates by itself, and the room will also appear in your rooms."
                    : "You join automatically the next time an admin opens the room. The room key is sealed to you then. This page updates by itself."}
                </p>
                <Button variant="ghost" full busy={busy === "cancel"} onClick={() => void cancel()}>
                  Cancel request
                </Button>
              </div>
            ) : !settled ? (
              <Skeleton lines={2} />
            ) : acct.status === "elsewhere" ? (
              <div className={s.state}>
                <p className={s.muted}>
                  Mizuhiki is open in another tab of this browser. Your key is unlocked in one tab at a time.
                </p>
                <Button variant="cord" size="lg" full onClick={acct.takeOver}>
                  Use it here instead
                </Button>
              </div>
            ) : acct.status === "none" ? (
              <div className={s.state}>
                <p className={s.muted}>
                  Joining needs your own Mizuhiki key, so the room key can be sealed to you. Making one takes a minute
                  and is free.
                </p>
                <ButtonLink href={`/signup?next=${encodeURIComponent(next)}`} variant="cord" size="lg" full icon="key">
                  Create your account
                </ButtonLink>
                <ButtonLink href={`/login?next=${encodeURIComponent(next)}`} variant="line" full>
                  I already have one
                </ButtonLink>
                <p className={s.fine}>You come back to this invite afterwards. The link’s key stays in this tab.</p>
              </div>
            ) : acct.status === "locked" ? (
              <UnlockHere />
            ) : (
              <div className={s.state}>
                {you === "request-declined" ? (
                  <p className={s.notice}>
                    <Icon name="info" size={16} />
                    <span>An admin declined your last request. You can ask again if they expect you.</span>
                  </p>
                ) : you === "removed" ? (
                  <p className={s.notice}>
                    <Icon name="info" size={16} />
                    <span>You were removed from this room before. Asking again sends a new request to the admins.</span>
                  </p>
                ) : you === "left" ? (
                  <p className={s.notice}>
                    <Icon name="info" size={16} />
                    <span>You left this room before. Asking again sends a new request.</span>
                  </p>
                ) : null}
                <Button
                  variant="cord"
                  size="lg"
                  full
                  icon={load.preview.approval ? "send" : "users"}
                  busy={busy === "join"}
                  onClick={() => void join()}
                >
                  {you === "request-declined" ? "Ask again" : load.preview.approval ? "Ask to join" : "Join"}
                </Button>
                <p className={s.fine}>
                  {load.preview.approval
                    ? "The admins see your @name or address. Nothing else about you is shared."
                    : "No approval needed. An admin’s device seals the room key to you the next time it opens the room."}
                </p>
              </div>
            )}
            {actionError ? (
              <Oops
                title={actionError.title}
                action={
                  actionError.setup ? (
                    <ButtonLink href={`/signup?next=${encodeURIComponent(next)}`} size="sm" variant="line">
                      Finish setup
                    </ButtonLink>
                  ) : undefined
                }
              >
                {actionError.detail}
              </Oops>
            ) : null}
          </InviteCardView>
        )}
      </main>
    </div>
  );
}

function Problem({
  face,
  title,
  jp,
  children,
  action,
}: {
  face: MusubiFace;
  title: string;
  jp: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className={[s.invite, s.problem].join(" ")}>
      <Musubi face={face} size={110} />
      <Kicker>{jp}</Kicker>
      <h1 className={s.problemTitle}>{title}</h1>
      <p className={s.muted}>{children}</p>
      {action}
      <ButtonLink href="/" variant="ghost">
        What is Mizuhiki?
      </ButtonLink>
    </div>
  );
}

function LinkStopped({ state, expiresAt }: { state: InvitePreview["state"]; expiresAt: string | null }) {
  const text =
    state === "revoked"
      ? "This link was reset by an admin. Ask for a new one."
      : state === "expired"
        ? `This link expired${expiresAt ? ` ${fmtWhen(new Date(expiresAt), new Date())}` : ""}. Ask for a new one.`
        : "This link reached its limit of uses. Ask for a new one.";
  return (
    <div className={s.state}>
      <p className={s.warn}>
        <Icon name="clock" size={18} />
        <span>{text}</span>
      </p>
      <p className={s.fine}>Nobody joined anything. Whoever sent it can make a new link in the room.</p>
    </div>
  );
}

function InviteCardView({
  preview,
  card,
  children,
  cardRef,
  admitted,
}: {
  preview: InvitePreview;
  card: InviteCard;
  children: React.ReactNode;
  cardRef: React.RefObject<HTMLDivElement | null>;
  admitted: boolean;
}) {
  const photo = useSealedPhoto(card.photo ?? null);
  const stopped = preview.state !== "ok";
  // The card was opened from the link, not checked against a schema: an unknown type reads as a plain room.
  const type = (ROOM_TEMPLATES as Partial<Record<string, { label: string }>>)[card.type]?.label ?? "Private";
  const inviter = card.invitedBy.startsWith("@")
    ? card.invitedBy
    : `${card.invitedBy.slice(0, 8)}…${card.invitedBy.slice(-4)}`;
  return (
    <article className={[s.invite, stopped ? s.stopped : ""].join(" ")} aria-labelledby="invite-name">
      <div className={s.ribbon} aria-hidden="true" />
      <div ref={cardRef} className={s.knot}>
        <Knot size={46} tie tied={admitted || !stopped} title="" />
      </div>
      <Kicker>ご招待</Kicker>
      <Avatar name={card.name || "Room"} src={photo} size={104} tone={toneOf(preview.roomId)} lock />
      <h1 id="invite-name" className={s.inviteName}>
        {card.name || "A private room"}
      </h1>
      <div className={s.chips}>
        <Chip tone="sora" icon="users">
          {preview.members === 1 ? "1 member" : `${preview.members} members`}
        </Chip>
        <Chip tone="fuji">{type} room</Chip>
        <Chip tone={preview.approval ? "butter" : "matcha"} icon={preview.approval ? "shield" : "check"}>
          {preview.approval ? "Admin approval" : "Joins without approval"}
        </Chip>
      </div>
      {card.description ? <p className={s.desc}>{card.description}</p> : null}
      <p className={s.inviter}>
        Invited by <b>{inviter}</b>
      </p>
      <div className={s.cta}>{children}</div>
      <LockLine>
        Messages in this room are sealed to its members. Your key is added only when an admin’s device seals the room
        key to you.
      </LockLine>
    </article>
  );
}

function UnlockHere() {
  const acct = useAccount();
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | undefined>();
  const [busy, setBusy] = useState<"pass" | "key" | null>(null);
  const hasPasskey = acct.vault?.wraps.some((w) => w.kind === "passkey") ?? false;
  return (
    <form
      className={s.state}
      onSubmit={(e) => {
        e.preventDefault();
        setBusy("pass");
        setErr(undefined);
        acct
          .unlock(pass)
          .catch((x: unknown) => setErr((x as Error).message))
          .finally(() => setBusy(null));
      }}
    >
      <p className={s.muted}>Unlock Mizuhiki on this device to answer the invite. Your key stays here.</p>
      <TextField
        label="Device passphrase"
        type="password"
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        error={err}
        autoComplete="current-password"
      />
      <Button type="submit" variant="cord" size="lg" full icon="key" busy={busy === "pass"} disabled={!pass}>
        Unlock
      </Button>
      {hasPasskey ? (
        <Button
          variant="line"
          full
          icon="key"
          busy={busy === "key"}
          onClick={() => {
            setBusy("key");
            setErr(undefined);
            acct
              .unlockWithPasskey()
              .catch((x: unknown) => setErr((x as Error).message))
              .finally(() => setBusy(null));
          }}
        >
          Unlock with passkey
        </Button>
      ) : null}
    </form>
  );
}
