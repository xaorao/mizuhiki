"use client";
/**
 * Room info (spec 5.10; Telegram group profile + WhatsApp group info): the
 * room's photo, name and description, the permanent encryption row with how
 * it works, Members · Files · Recent actions, settings, notifications, and
 * leave, transfer or delete. Fills its container (a right-hand column on
 * desktop, a full-screen sheet on phones) and scrolls inside.
 */
import { useEffect, useMemo, useState } from "react";
import { Button, Chip, Icon, IconButton, Oops, Skeleton, Tabs, ToggleRow, useToast } from "@mizuhiki/ui";
import { ROOM_TEMPLATES } from "@mizuhiki/core";
import { explorerTx } from "@mizuhiki/chain";
import { can } from "../derive";
import { setMuted, verifiedPhrases } from "../engine";
import { RoomAvatar, useNames } from "../people";
import type { RoomState } from "../useRoom";
import { ActionsTab } from "./ActionsTab";
import { BottomActions } from "./BottomActions";
import { EditInfoSheet } from "./EditInfoSheet";
import { FilesTab } from "./FilesTab";
import { MembersTab } from "./MembersTab";
import { SettingsSection } from "./SettingsSection";
import { InlineError } from "./Progress";
import s from "./info.module.css";
import { failureText } from "@/lib/failure";

type Tab = "members" | "files" | "actions";
const TYPE_TONE = { deal: "sora", payroll: "butter", team: "matcha", family: "sakura" } as const;

function EncryptionRow({ room }: { room: RoomState }) {
  const [open, setOpen] = useState(false);
  const detail = room.detail;
  if (!detail) return null;
  const latest = [...detail.epochs].sort((a, b) => b.epoch - a.epoch)[0];
  return (
    <div className={s.choiceList}>
      <button
        type="button"
        className={s.lock}
        aria-expanded={open}
        aria-controls="room-how"
        onClick={() => setOpen((v) => !v)}
      >
        <span className={s.lockIcon} aria-hidden="true">
          <Icon name="lock" />
        </span>
        <span>
          <b>Encryption</b>
          <small>Messages and files are sealed to the people in this room.</small>
        </span>
        <Icon name="chev" className={[s.lockChev, open ? s.lockChevOpen : ""].join(" ")} />
      </button>
      {open ? (
        <div id="room-how" className={s.how}>
          <b>How it works</b>
          <ol>
            <li>
              Everyone in the room shares one room key. Each message and file is sealed with it on the sender&apos;s
              device and signed by them.
            </li>
            <li>
              When someone joins, leaves or is removed, an admin&apos;s device makes a new key and seals it to the
              current members only.
            </li>
            <li>
              Each new key is recorded on QoreChain with a fingerprint of the member list, so nobody can quietly add a
              reader.
            </li>
          </ol>
          <dl className={s.facts}>
            <dt>Room key</dt>
            <dd>
              <span className={s.epochNum}>Key {detail.epoch}</span> (changed {detail.epoch - 1}{" "}
              {detail.epoch - 1 === 1 ? "time" : "times"})
            </dd>
            <dt>Member list</dt>
            <dd>
              {room.chainCheck === "ok"
                ? "Checked on this device against the record on QoreChain. It matches."
                : room.chainCheck === "mismatch"
                  ? "Does not match the record on QoreChain. Do not send anything sensitive until an admin checks the members."
                  : "Being checked against the record on QoreChain."}
            </dd>
            <dt>Server sees</dt>
            <dd>
              Who is a member and the size of sealed messages. Not the name, the messages or who wrote them; it checks
              that a sender is a member but keeps no record of who sent what.
            </dd>
            {latest?.txHash ? (
              <>
                <dt>Record</dt>
                <dd>
                  <a className={s.chainLink} href={explorerTx(latest.txHash)} target="_blank" rel="noopener noreferrer">
                    <Icon name="link" size={14} />
                    Key {latest.epoch} on QoreChain
                    <span className="sr-only"> (opens the QoreChain explorer)</span>
                  </a>
                </dd>
              </>
            ) : null}
          </dl>
          <p className={s.help}>
            Removed people keep what they already saw. They cannot open anything sent after the key changed.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function RoomInfoPanel({
  room,
  onClose,
  onOpenInvites,
  onMessage,
}: {
  room: RoomState;
  onClose: () => void;
  onOpenInvites: () => void;
  onMessage: (address: string) => void;
}) {
  const toast = useToast();
  const [tab, setTab] = useState<Tab>("members");
  const [editing, setEditing] = useState(false);
  const [verified, setVerified] = useState<Record<string, string>>({});
  const [muteBusy, setMuteBusy] = useState(false);
  const [muteErr, setMuteErr] = useState<string | null>(null);
  const { detail, derived, acct } = room;
  const me = detail?.me;

  useEffect(() => {
    let alive = true;
    void acct()
      .then((a) => verifiedPhrases(a))
      .then((v) => {
        if (alive) setVerified(v);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [acct]);

  const people = useMemo(() => {
    const set = new Set<string>();
    for (const m of detail?.members ?? []) set.add(m.address);
    for (const r of room.requests) {
      set.add(r.address);
      const by = /^add:(qor1[0-9a-z]{38})$/.exec(r.inviteId)?.[1];
      if (by) set.add(by);
    }
    for (const a of derived?.actions ?? []) {
      set.add(a.by);
      for (const p of a.text) if (typeof p !== "string") set.add(p.who);
    }
    for (const f of derived?.files ?? []) set.add(f.author);
    return [...set];
  }, [detail?.members, room.requests, derived?.actions, derived?.files]);
  const names = useNames(people);

  const header = (
    <header className={s.bar}>
      <span className={s.barText}>
        <span className={s.barJp} lang="ja">
          へやの情報
        </span>
        <h2>Room info</h2>
      </span>
      <IconButton icon="x" label="Close room info" onClick={onClose} />
    </header>
  );

  if (room.loading && !detail)
    return (
      <div className={s.panel}>
        {header}
        <div className={s.scroll} aria-busy="true">
          <Skeleton avatar lines={3} height={160} />
          <Skeleton lines={2} />
          <Skeleton avatar lines={2} />
          <Skeleton avatar lines={2} />
        </div>
      </div>
    );

  if (!detail || !derived || !me)
    return (
      <div className={s.panel}>
        {header}
        <div className={s.scroll}>
          <Oops
            title="Room info did not load."
            action={
              <Button variant="line" icon="undo" onClick={() => void room.reload()}>
                Try again
              </Button>
            }
          >
            {room.error ?? "This room could not be opened."} Nothing in the room was changed.
          </Oops>
        </div>
      </div>
    );

  const info = derived.info;
  const active = detail.members.filter((m) => m.status === "active");
  const mayEdit = can(me, "info");
  const tabs: { value: Tab; label: string; badge?: number }[] = [
    {
      value: "members",
      label: "Members",
      ...(room.requests.length && can(me, "add") ? { badge: room.requests.length } : {}),
    },
    { value: "files", label: derived.files.length ? `Files ${derived.files.length}` : "Files" },
    { value: "actions", label: "Recent actions" },
  ];

  const toggleMute = async (muted: boolean) => {
    setMuteBusy(true);
    setMuteErr(null);
    try {
      await setMuted(await acct(), detail.id, muted);
      toast.show(muted ? "Muted. New messages here won't count as unread." : "Unmuted.");
      await room.reload();
    } catch (e) {
      setMuteErr(`Not changed. ${failureText(e, "Try again.")}`);
    } finally {
      setMuteBusy(false);
    }
  };

  return (
    <div className={s.panel}>
      {header}
      <div className={s.scroll}>
        {room.chore ? (
          <p className={s.chore} role="status">
            <Icon name="key" size={18} />
            {room.chore}
          </p>
        ) : null}
        {room.error ? <InlineError>{`Not up to date: ${room.error}`}</InlineError> : null}

        <section className={s.hero} aria-label="Room">
          <div className={[s.cover, "seigaiha"].join(" ")} aria-hidden="true" />
          <div className={s.heroBody}>
            <span className={s.heroAvatar}>
              <RoomAvatar name={info.name} photo={info.photo} roomId={detail.id} size={96} />
            </span>
            <h3>{info.name || "Unnamed room"}</h3>
            <p className={s.heroMeta}>
              <span>Room · {active.length === 1 ? "1 member" : `${active.length} members`}</span>
              <Chip tone={TYPE_TONE[info.type]}>{ROOM_TEMPLATES[info.type].label}</Chip>
            </p>
            {info.description ? (
              <p className={s.desc}>{info.description}</p>
            ) : mayEdit ? (
              <p className={s.help}>No description yet.</p>
            ) : null}
            {mayEdit ? (
              <div className={s.heroActions}>
                <Button variant="line" size="sm" icon="pen" onClick={() => setEditing(true)}>
                  Edit
                </Button>
              </div>
            ) : null}
          </div>
        </section>

        <EncryptionRow room={room} />

        <div className={s.tabsWrap}>
          <Tabs label="Room info sections" tabs={tabs} value={tab} onChange={setTab} />
          <div key={tab} className={s.tabPanel} role="tabpanel" aria-label={tabs.find((t) => t.value === tab)?.label}>
            {tab === "members" ? (
              <MembersTab
                room={room}
                names={names}
                verified={verified}
                onVerified={(a, p) => setVerified((v) => ({ ...v, [a]: p }))}
                onOpenInvites={onOpenInvites}
                onMessage={onMessage}
              />
            ) : tab === "files" ? (
              <FilesTab files={derived.files} names={names} me={me.address} />
            ) : (
              <ActionsTab actions={derived.actions} names={names} me={me.address} />
            )}
          </div>
        </div>

        <SettingsSection room={room} />

        <section className={s.card} aria-label="My notifications">
          <div className={s.cardHead}>
            <h3>My notifications</h3>
            <small>Only you</small>
          </div>
          <ToggleRow
            title="Mute this room"
            detail="New messages here won't count as unread in your room list."
            checked={me.muted}
            onChange={(v) => void toggleMute(v)}
            disabled={muteBusy}
          />
          <InlineError>{muteErr}</InlineError>
        </section>

        <BottomActions room={room} names={names} />
      </div>
      <EditInfoSheet room={room} open={editing} onClose={() => setEditing(false)} />
    </div>
  );
}
