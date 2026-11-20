"use client";
/**
 * Members tab (Telegram members screen + WhatsApp member section): search,
 * Add members, Invite via link or QR code, join requests for admins, the
 * member list with role tags, and removed people with Unblock.
 */
import { useMemo, useState, type CSSProperties } from "react";
import { Button, ButtonLink, ChoiceCard, Icon, Sheet, StatusChip, TextField, useToast } from "@mizuhiki/ui";
import { ROOM_TEMPLATES } from "@mizuhiki/core";
import { can } from "../derive";
import { changeMembers, declineRequest, unblock, type JoinRequest, type MemberRow } from "../engine";
import { PersonAvatar, label } from "../people";
import type { RoomState } from "../useRoom";
import { AddMembersSheet } from "./AddMembersSheet";
import { MemberSheet } from "./MemberSheet";
import { dayLabel, isAdminRole, matchesQuery, requestOrigin, sortMembers, whenLabel } from "./model";
import { InlineError, StepList, changeFailure, useSteps } from "./Progress";
import s from "./info.module.css";
import { failureText } from "@/lib/failure";

function ApproveSheet({
  room,
  request,
  names,
  onClose,
}: {
  room: RoomState;
  request: JoinRequest | null;
  names: Record<string, string | null>;
  onClose: () => void;
}) {
  const toast = useToast();
  const [history, setHistory] = useState<"share" | "hide" | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const steps = useSteps();
  const who = request ? label(request.address, names) : "";

  const clear = () => {
    setHistory(null);
    setErr(null);
    steps.reset();
  };
  const approve = async () => {
    if (!request || !history || !room.detail) return;
    setBusy(true);
    setErr(null);
    steps.reset();
    try {
      await changeMembers(
        await room.acct(),
        room.detail.id,
        { add: [{ address: request.address, history }], reason: "joined" },
        steps.onStep,
      );
      toast.show(`${who} is in. Room key changed.`);
      setBusy(false);
      clear();
      onClose();
      void room.reload();
    } catch (e) {
      setErr(changeFailure(e, steps.at));
      setBusy(false);
      void room.reload();
    }
  };

  return (
    <Sheet
      open={!!request}
      onClose={() => {
        if (busy) return;
        clear();
        onClose();
      }}
      title={`Let ${who} in`}
      dismissable={!busy}
    >
      <div className={s.sheetBody}>
        <p>Share past messages with {who}?</p>
        <div className={s.choiceList} role="radiogroup" aria-label={`What ${who} can read`}>
          <ChoiceCard
            selected={history === "share"}
            onSelect={() => setHistory("share")}
            title="Share past messages"
            detail="The older room keys are sealed to them, so they can read everything said before."
            tone="sora"
            icon={<Icon name="archive" />}
          />
          <ChoiceCard
            selected={history === "hide"}
            onSelect={() => setHistory("hide")}
            title="Only new messages"
            detail="They cannot open anything sent before they joined."
            tone="matcha"
            icon={<Icon name="lock" />}
          />
        </div>
        <p className={s.consequence}>It cannot be undone: past messages are sealed to them or never shared.</p>
        <StepList at={busy ? steps.at : null} />
        <InlineError>{err}</InlineError>
        <div className={s.btnRow}>
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              clear();
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button variant="cord" icon="check" busy={busy} disabled={!history} onClick={() => void approve()}>
            {busy ? "Changing the room key…" : "Approve"}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

export function MembersTab({
  room,
  names,
  verified,
  onVerified,
  onOpenInvites,
  onMessage,
}: {
  room: RoomState;
  names: Record<string, string | null>;
  verified: Record<string, string>;
  onVerified: (address: string, phrase: string) => void;
  onOpenInvites: () => void;
  onMessage: (address: string) => void;
}) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [openAddr, setOpenAddr] = useState<string | null>(null);
  const [approving, setApproving] = useState<JoinRequest | null>(null);
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const detail = room.detail;
  const me = detail?.me;
  const admin = isAdminRole(me);
  const mayAdd = can(me, "add");

  const active = useMemo(
    () => sortMembers((detail?.members ?? []).filter((m) => m.status === "active")),
    [detail?.members],
  );
  const shown = active.filter((m) => matchesQuery(m.address, names[m.address], q));
  const gone = (detail?.members ?? []).filter((m) => m.status === "removed" || m.status === "blocked");
  const openMember: MemberRow | null = active.find((m) => m.address === openAddr) ?? null;

  if (!detail || !me) return null;

  const decline = async (r: JoinRequest) => {
    setRowBusy(r.address);
    setRowErr(null);
    try {
      await declineRequest(await room.acct(), detail.id, r.address);
      toast.show(`Declined. ${label(r.address, names)} was not let in and got no key.`);
      await room.reload();
    } catch (e) {
      setRowErr(`Not declined. ${failureText(e, "Try again.")}`);
    } finally {
      setRowBusy(null);
    }
  };
  const doUnblock = async (m: MemberRow) => {
    setRowBusy(m.address);
    setRowErr(null);
    try {
      await unblock(await room.acct(), detail.id, m.address);
      toast.show(`${label(m.address, names)} is unblocked. They can ask to join again.`);
      await room.reload();
    } catch (e) {
      setRowErr(`Still blocked. ${failureText(e, "Try again.")}`);
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <>
      {active.length > 6 ? (
        <TextField
          label="Search members"
          hideLabel
          placeholder="Search by @name or address"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          type="search"
        />
      ) : null}

      <div className={s.actionsRow}>
        {mayAdd ? (
          <Button variant="line" icon="plus" full onClick={() => setAdding(true)}>
            {admin ? "Add members" : "Suggest members"}
          </Button>
        ) : null}
        {admin ? (
          <Button variant="line" icon="link" full onClick={onOpenInvites}>
            Invite via link or QR code
          </Button>
        ) : null}
        {me.role === "owner" && ROOM_TEMPLATES[room.derived?.info.type ?? "team"].auditor ? (
          <ButtonLink variant="line" icon="pass" full href={`/app/passes?new=room&id=${encodeURIComponent(detail.id)}`}>
            Give an accountant a pass
          </ButtonLink>
        ) : null}
      </div>

      <InlineError>{rowErr}</InlineError>

      {room.requests.length > 0 && mayAdd ? (
        <section aria-label="Join requests" className={s.choiceList}>
          <p className={s.sectionLabel}>
            <span>Waiting to join</span>
            <span>{room.requests.length}</span>
          </p>
          {room.requests.map((r) => {
            const origin = requestOrigin(r.inviteId);
            return (
              <div key={r.address} className={s.request}>
                <PersonAvatar address={r.address} names={names} size={40} />
                <span className={s.memberText}>
                  <b>{label(r.address, names)}</b>
                  <small>
                    {origin.kind === "link"
                      ? "Used an invite link"
                      : `Suggested by ${label(origin.by, names, me.address)}`}{" "}
                    · {whenLabel(r.at)}
                  </small>
                </span>
                {admin ? (
                  <div className={s.requestBtns}>
                    <Button
                      size="sm"
                      variant="cord"
                      icon="check"
                      onClick={() => setApproving(r)}
                      disabled={rowBusy === r.address}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="quiet"
                      icon="x"
                      busy={rowBusy === r.address}
                      onClick={() => void decline(r)}
                    >
                      Decline
                    </Button>
                  </div>
                ) : (
                  <div className={s.requestBtns}>
                    <StatusChip status="wait">Waiting for an admin</StatusChip>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ) : null}

      <p className={s.sectionLabel}>
        <span>{active.length === 1 ? "1 member" : `${active.length} members`}</span>
      </p>
      {shown.length === 0 ? (
        <p className={s.noMatch}>Nobody here matches “{q.trim()}”.</p>
      ) : (
        <ul className={s.list}>
          {shown.map((m, i) => (
            <li key={m.address} style={{ "--i": Math.min(i, 12) } as CSSProperties}>
              <button type="button" className={s.member} onClick={() => setOpenAddr(m.address)}>
                <PersonAvatar address={m.address} names={names} size={40} />
                <span className={s.memberText}>
                  <b>{label(m.address, names, me.address)}</b>
                  <small>
                    {m.address === me.address && names[m.address] ? `${label(m.address, names)} · ` : ""}Joined{" "}
                    {dayLabel(m.joinedAt)}
                  </small>
                </span>
                <span className={s.tags}>
                  {verified[m.address] ? (
                    <span className={s.verified}>
                      <Icon name="shield" size={14} />
                      Verified
                    </span>
                  ) : null}
                  {m.role !== "member" ? (
                    <span className={s.role}>{m.role === "owner" ? "Owner" : "Admin"}</span>
                  ) : null}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {admin && gone.length > 0 ? (
        <section aria-label="Removed people" className={s.choiceList}>
          <p className={s.sectionLabel}>
            <span>Removed people</span>
            <span>{gone.length}</span>
          </p>
          {gone.map((m) => (
            <div key={m.address} className={s.removed}>
              <PersonAvatar address={m.address} names={names} size={34} />
              <span className={s.memberText}>
                <b>{label(m.address, names)}</b>
                <small>{m.status === "blocked" ? "Removed and blocked" : "Removed · can ask to join again"}</small>
              </span>
              {m.status === "blocked" ? (
                <Button size="sm" variant="line" busy={rowBusy === m.address} onClick={() => void doUnblock(m)}>
                  Unblock
                </Button>
              ) : null}
            </div>
          ))}
          <p className={s.help}>
            Removed people kept what they saw before. They cannot open anything sent after they left.
          </p>
        </section>
      ) : null}

      <AddMembersSheet room={room} open={adding} onClose={() => setAdding(false)} />
      <ApproveSheet room={room} request={approving} names={names} onClose={() => setApproving(null)} />
      <MemberSheet
        room={room}
        member={openMember}
        names={names}
        verified={verified}
        onVerified={onVerified}
        onMessage={(a) => {
          setOpenAddr(null);
          onMessage(a);
        }}
        onClose={() => setOpenAddr(null)}
      />
    </>
  );
}
