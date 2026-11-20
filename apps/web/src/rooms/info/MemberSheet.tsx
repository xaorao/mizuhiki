"use client";
/**
 * One member's sheet (Telegram member menu + WhatsApp contact sheet): Message,
 * Make or dismiss admin, Change permissions, Verify keys, then Remove and
 * Remove and block last, in red, each explained before it runs.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Button, Icon, Sheet, ToggleRow, useToast, type IconName } from "@mizuhiki/ui";
import { PERMISSION_LABEL, PERMISSIONS, type Permission } from "@mizuhiki/core";
import { changeMembers, markVerified, safetyWords, setRole, type MemberRow } from "../engine";
import { PersonAvatar, label } from "../people";
import type { RoomState } from "../useRoom";
import { adminCheck, dayLabel, permissionsCheck, removeCheck, verifyState, type Check } from "./model";
import { InlineError, StepList, changeFailure, useSteps } from "./Progress";
import s from "./info.module.css";
import { failureText } from "@/lib/failure";

type View = "menu" | "admin" | "perms" | "verify" | "remove";

function MenuButton({
  icon,
  title,
  detail,
  onClick,
  check,
  danger,
}: {
  icon: IconName;
  title: string;
  detail?: string | undefined;
  onClick: () => void;
  check?: Check | undefined;
  danger?: boolean | undefined;
}) {
  const blocked = check && !check.allowed ? check.reason : null;
  return (
    <button
      type="button"
      className={[s.menuBtn, danger ? s.danger : ""].join(" ")}
      onClick={onClick}
      disabled={!!blocked}
    >
      <span className={s.menuIcon} aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span>
        <b>{title}</b>
        {blocked || detail ? <small>{blocked ?? detail}</small> : null}
      </span>
      {blocked ? null : <Icon name="chev" size={18} />}
    </button>
  );
}

export function MemberSheet({
  room,
  member,
  names,
  verified,
  onVerified,
  onMessage,
  onClose,
}: {
  room: RoomState;
  member: MemberRow | null;
  names: Record<string, string | null>;
  verified: Record<string, string>;
  onVerified: (address: string, phrase: string) => void;
  onMessage: (address: string) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [view, setView] = useState<View>("menu");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [perms, setPerms] = useState<Permission[]>([]);
  const [blockToo, setBlockToo] = useState(false);
  const [words, setWords] = useState<string | null>(null);
  const [wordsErr, setWordsErr] = useState<string | null>(null);
  const steps = useSteps();
  const { reset: resetSteps } = steps;

  const address = member?.address ?? "";
  useEffect(() => {
    setView("menu");
    setErr(null);
    setWords(null);
    setWordsErr(null);
    setPerms(member?.permissions ?? []);
    resetSteps();
  }, [address, member?.permissions, resetSteps]);

  const me = room.detail?.me;
  if (!member || !me || !room.detail)
    return (
      <Sheet open={false} onClose={onClose} title="Member">
        {null}
      </Sheet>
    );

  const roomId = room.detail.id;
  const isMe = member.address === me.address;
  const who = label(member.address, names);
  const roleWord = member.role === "owner" ? "Owner" : member.role === "admin" ? "Admin" : "Member";

  const loadWords = async () => {
    setWords(null);
    setWordsErr(null);
    try {
      setWords(await safetyWords(member.address));
    } catch (e) {
      setWordsErr(failureText(e, "The safety words could not be shown. Try again."));
    }
  };

  const go = (v: View) => {
    setErr(null);
    setView(v);
    if (v === "verify") void loadWords();
  };

  const runRole = async (role: "member" | "admin", permissions: Permission[], done: string) => {
    setBusy(true);
    setErr(null);
    try {
      await setRole(await room.acct(), roomId, member.address, role, permissions);
      toast.show(done);
      await room.reload();
      onClose();
    } catch (e) {
      setErr(`Nothing changed. ${failureText(e, "Try again.")}`);
    } finally {
      setBusy(false);
    }
  };

  const runRemove = async () => {
    setBusy(true);
    setErr(null);
    resetSteps();
    try {
      await changeMembers(
        await room.acct(),
        roomId,
        { remove: [{ address: member.address, blocked: blockToo }], reason: blockToo ? "removed+blocked" : "removed" },
        steps.onStep,
      );
      toast.show(
        blockToo ? `${who} was removed and blocked. Room key changed.` : `${who} was removed. Room key changed.`,
      );
      await room.reload();
      onClose();
    } catch (e) {
      setErr(changeFailure(e, steps.at));
      void room.reload();
    } finally {
      setBusy(false);
    }
  };

  const saveVerified = async () => {
    if (!words) return;
    try {
      await markVerified(await room.acct(), member.address, words);
      onVerified(member.address, words);
      toast.show(`${who} is marked as verified on this device.`);
      setView("menu");
    } catch (e) {
      setWordsErr(`Not saved. ${failureText(e, "Try again.")}`);
    }
  };

  const vState = verifyState(verified[member.address], words);
  const title =
    view === "menu"
      ? isMe
        ? "You"
        : who
      : view === "admin"
        ? member.role === "admin"
          ? "Dismiss admin"
          : "Make admin"
        : view === "perms"
          ? "Change permissions"
          : view === "verify"
            ? isMe
              ? "Your safety words"
              : "Verify keys"
            : blockToo
              ? "Remove and block"
              : "Remove from room";

  return (
    <Sheet open onClose={onClose} title={title} dismissable={!busy}>
      <div className={s.sheetBody}>
        {view === "menu" ? (
          <>
            <div className={s.sheetPerson}>
              <PersonAvatar address={member.address} names={names} size={72} />
              <b>{isMe ? `${label(member.address, names)} (you)` : who}</b>
              <span className={s.role}>
                {roleWord} · joined {dayLabel(member.joinedAt)}
              </span>
              <code>{member.address}</code>
            </div>
            <div className={s.menu}>
              {isMe ? null : (
                <MenuButton
                  icon="mail"
                  title="Message"
                  detail={`A sealed message only ${who} can open.`}
                  onClick={() => onMessage(member.address)}
                />
              )}
              {!isMe && member.role !== "owner" && me.role === "owner" ? (
                <MenuButton
                  icon="shield"
                  title={member.role === "admin" ? "Dismiss admin" : "Make admin"}
                  detail={
                    member.role === "admin"
                      ? "They go back to being a member."
                      : "Admins add and remove people and change the room."
                  }
                  onClick={() => go("admin")}
                  check={adminCheck(me, member)}
                />
              ) : null}
              {!isMe && member.role === "member" && (me.role === "owner" || me.role === "admin") ? (
                <MenuButton
                  icon="gear"
                  title="Change permissions"
                  detail={`${member.permissions.length} of ${PERMISSIONS.length} allowed`}
                  onClick={() => go("perms")}
                  check={permissionsCheck(me, member)}
                />
              ) : null}
              <MenuButton
                icon="key"
                title={isMe ? "Show my safety words" : "Verify keys"}
                detail={
                  isMe
                    ? "Read them to someone who is checking you."
                    : verified[member.address]
                      ? "Marked as verified on this device."
                      : "Check the keys this device uses are theirs."
                }
                onClick={() => go("verify")}
              />
              {!isMe && member.role !== "owner" && (me.role === "owner" || me.role === "admin") ? (
                <>
                  <hr className={s.divider} />
                  <MenuButton
                    icon="logout"
                    title="Remove from room"
                    danger
                    check={removeCheck(me, member)}
                    onClick={() => {
                      setBlockToo(false);
                      go("remove");
                    }}
                  />
                  <MenuButton
                    icon="x"
                    title="Remove and block"
                    detail="They also cannot ask to join again."
                    danger
                    check={removeCheck(me, member)}
                    onClick={() => {
                      setBlockToo(true);
                      go("remove");
                    }}
                  />
                </>
              ) : null}
            </div>
          </>
        ) : null}

        {view === "admin" ? (
          <>
            <p>
              {member.role === "admin"
                ? `${who} goes back to being a member with the rights they had. QoreChain records that they are no longer an admin.`
                : `${who} becomes an admin: they can add and remove members, approve join requests, change room info and settings, and manage invite links. QoreChain records the change.`}
            </p>
            <p className={s.help}>This needs one QoreChain transaction from your account. It takes a few seconds.</p>
            <InlineError>{err}</InlineError>
            <div className={s.btnRow}>
              <Button variant="quiet" onClick={() => setView("menu")} disabled={busy}>
                Back
              </Button>
              <Button
                variant="cord"
                busy={busy}
                onClick={() =>
                  void (member.role === "admin"
                    ? runRole("member", member.permissions, `${who} is no longer an admin.`)
                    : runRole("admin", [...PERMISSIONS], `${who} is now an admin.`))
                }
              >
                {busy ? "Recording on QoreChain…" : member.role === "admin" ? "Dismiss admin" : "Make admin"}
              </Button>
            </div>
          </>
        ) : null}

        {view === "perms" ? (
          <>
            <p className={s.help}>What can {who} do in this room? Admins can always do everything.</p>
            <div className={s.perms}>
              {PERMISSIONS.map((p) => (
                <ToggleRow
                  key={p}
                  title={PERMISSION_LABEL[p]}
                  checked={perms.includes(p)}
                  disabled={busy}
                  onChange={(on) =>
                    setPerms((cur) =>
                      on ? PERMISSIONS.filter((x) => x === p || cur.includes(x)) : cur.filter((x) => x !== p),
                    )
                  }
                />
              ))}
            </div>
            <InlineError>{err}</InlineError>
            <div className={s.btnRow}>
              <Button variant="quiet" onClick={() => setView("menu")} disabled={busy}>
                Back
              </Button>
              <Button
                variant="cord"
                busy={busy}
                disabled={
                  perms.length === member.permissions.length && perms.every((p) => member.permissions.includes(p))
                }
                onClick={() => void runRole("member", perms, `Permissions for ${who} saved.`)}
              >
                {busy ? "Saving…" : "Save permissions"}
              </Button>
            </div>
          </>
        ) : null}

        {view === "verify" ? (
          <>
            {words ? (
              <ol className={s.words} aria-label="Safety words">
                {words.split(" ").map((w, i) => (
                  <li key={`${i}-${w}`} style={{ "--i": i } as CSSProperties}>
                    {w}
                  </li>
                ))}
              </ol>
            ) : wordsErr ? null : (
              <ol className={s.words} aria-hidden="true">
                {Array.from({ length: 6 }, (_, i) => (
                  <li key={i}>
                    <span className={s.tileSkel} style={{ display: "block", height: 22, borderRadius: 8 }} />
                  </li>
                ))}
              </ol>
            )}
            {wordsErr ? (
              <>
                <InlineError>{`These words could not be worked out. ${wordsErr}`}</InlineError>
                <Button variant="line" icon="undo" onClick={() => void loadWords()}>
                  Try again
                </Button>
              </>
            ) : null}
            <p>
              {isMe
                ? "These words come from your keys on QoreChain. Read them to someone checking you, in person or on a call."
                : `Compare these words with ${who} in person or on a call. If they match, the keys this device uses are theirs.`}
            </p>
            {!isMe && vState === "match" ? (
              <p className={[s.verifyNote, s.vMatch].join(" ")}>
                <Icon name="check" size={16} />
                <span>You verified {who} before, and the words still match.</span>
              </p>
            ) : null}
            {!isMe && vState === "changed" ? (
              <p className={[s.verifyNote, s.vChanged].join(" ")}>
                <Icon name="alert" size={16} />
                <span>
                  These words changed since you verified {who}. Their keys on QoreChain are different now. Check with
                  them again before you trust new messages.
                </span>
              </p>
            ) : null}
            {!isMe && vState === "never" && words ? (
              <p className={[s.verifyNote, s.vInfo].join(" ")}>
                <Icon name="info" size={16} />
                <span>Only mark them as verified after the words matched.</span>
              </p>
            ) : null}
            <div className={s.btnRow}>
              <Button variant="quiet" onClick={() => setView("menu")}>
                Back
              </Button>
              {!isMe && words && vState !== "match" ? (
                <Button variant="cord" icon="check" onClick={() => void saveVerified()}>
                  Mark as verified
                </Button>
              ) : null}
            </div>
          </>
        ) : null}

        {view === "remove" ? (
          <>
            <p className={s.consequence}>
              {who} loses access to new messages now. The room key changes. They keep what they already saw.
              {blockToo ? ` They are also blocked: they cannot ask to join again until an admin unblocks them.` : ""}
            </p>
            <p className={s.help}>
              The new key is sealed to everyone else and recorded on QoreChain. It takes a few seconds; keep this open.
            </p>
            <StepList at={busy ? steps.at : null} />
            <InlineError>{err}</InlineError>
            <div className={s.btnRow}>
              <Button variant="quiet" onClick={() => setView("menu")} disabled={busy}>
                Back
              </Button>
              <Button variant="danger" icon={blockToo ? "x" : "logout"} busy={busy} onClick={() => void runRemove()}>
                {busy ? "Changing the room key…" : blockToo ? `Remove and block ${who}` : `Remove ${who}`}
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
