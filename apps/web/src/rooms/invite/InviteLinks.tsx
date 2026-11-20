"use client";
/**
 * Invite links for a room (spec 5.10 "Invites"). WhatsApp's Group link screen
 * (Copy, Share, QR code, Forward, a red Reset link) around the primary link,
 * Telegram's New Link screen (time and use-limit sliders with custom values)
 * for extra links, and the list of every extra link with its state.
 *
 * A link's key lives only in its fragment, so the full URL exists only on the
 * device that made it. Links made here are kept on this device, encrypted.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import QRCode from "qrcode";
import {
  Avatar,
  Button,
  ButtonLink,
  Icon,
  LockLine,
  Oops,
  Sheet,
  Skeleton,
  StatusChip,
  TextField,
  burstFrom,
  ripple,
  useToast,
  type Status,
} from "@mizuhiki/ui";
import { ROOM_TEMPLATES } from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { SEND_STEP_LABEL, sendSealed, type SendStep } from "@/lib/send";
import { can } from "../derive";
import {
  createInvite,
  inviteUrls,
  listInvites,
  lookupPerson,
  nameOf,
  rememberInviteUrl,
  revokeInvite,
  shortAddress,
  type InviteCard,
  type InviteRow,
} from "../engine";
import { toneOf, useSealedPhoto } from "../people";
import { useRoomEvents, type RoomState } from "../useRoom";
import {
  STATE_LABEL,
  TIME_STOPS,
  USE_STOPS,
  customExpiryProblem,
  expiryLabel,
  expiryOf,
  fmtWhen,
  fromLocalInput,
  linkState,
  parseUseLimit,
  shareText,
  toLocalInput,
  usesHelp,
  usesLabel,
  usesOf,
  type LinkState,
  type TimeChoice,
  type UseChoice,
} from "./limits";
import { AddToPage } from "./AddToPage";
import s from "./invite.module.css";
import { failureText } from "@/lib/failure";

type View = "main" | "new" | "qr" | "forward" | "reset";

const STATE_STATUS: Record<LinkState, Status> = {
  active: "ok",
  expired: "wait",
  "used-up": "neutral",
  revoked: "danger",
};

const failText = (e: unknown, fallback: string) => failureText(e, fallback);

export function InviteLinks({ room, onClose }: { room: RoomState; onClose: () => void }) {
  const { account } = useAccount();
  const toast = useToast();
  const detail = room.detail;
  const info = room.derived?.info;
  const roomId = detail?.id ?? "";
  const me = detail?.me;
  const allowed = !!detail && !detail.closed && can(me, "add");
  const isAdmin = me?.status === "active" && (me.role === "owner" || me.role === "admin");

  const [view, setView] = useState<View>("main");
  const [rows, setRows] = useState<InviteRow[] | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [making, setMaking] = useState(false);
  const [makeError, setMakeError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const autoMade = useRef(false);

  const load = useCallback(async () => {
    if (!allowed || !account) return;
    try {
      const a = await room.acct();
      const [r, u] = await Promise.all([listInvites(a, roomId), inviteUrls(account)]);
      setRows(r.invites);
      setUrls(u);
      setLoadError(null);
      setNow(new Date());
    } catch (e) {
      setLoadError(failText(e, "The invite links did not load."));
    }
  }, [allowed, account, room, roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  // A join uses up a link: admins hear "roomreq" on the live socket. States also change with the clock.
  useRoomEvents((kind) => {
    if (kind === "roomreq" || kind === "room") void load();
  });
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(h);
  }, []);

  const primary = useMemo(
    () =>
      (rows ?? [])
        .filter((r) => r.primary && linkState(r, now) === "active")
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0],
    [rows, now],
  );
  const extra = useMemo(
    () => (rows ?? []).filter((r) => !r.primary).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    [rows],
  );

  const card = useCallback(async (): Promise<InviteCard> => {
    if (!account || !info) throw new Error("The room is still opening. Try again in a moment.");
    const mine = await nameOf(account.owner.address);
    return {
      name: info.name,
      type: info.type,
      description: info.description,
      invitedBy: mine ? `@${mine}` : account.owner.address,
      ...(info.photo ? { photo: info.photo } : {}),
    };
  }, [account, info]);

  /** Make a link, keep its URL on this device, refresh the list. */
  const make = useCallback(
    async (o: { primary: boolean; expiresAt: Date | null; maxUses: number | null }): Promise<string> => {
      if (!account) throw new Error("Unlock your account first.");
      const a = await room.acct();
      const r = await createInvite(a, roomId, await card(), o);
      await rememberInviteUrl(account, r.id, r.url);
      setUrls((u) => ({ ...u, [r.id]: r.url }));
      setFresh(r.id);
      await load();
      return r.id;
    },
    [account, room, roomId, card, load],
  );

  // No primary link yet: make one, once, as WhatsApp does when the screen opens.
  useEffect(() => {
    if (!rows || primary || autoMade.current || !allowed || !info?.name) return;
    autoMade.current = true;
    setMaking(true);
    setMakeError(null);
    make({ primary: true, expiresAt: null, maxUses: null })
      .catch((e: unknown) => setMakeError(failText(e, "The link was not made.")))
      .finally(() => setMaking(false));
  }, [rows, primary, allowed, info?.name, make]);

  const primaryUrl = primary ? urls[primary.id] : undefined;

  const copy = async (url: string, what = "Link copied and ready to share") => {
    try {
      await navigator.clipboard.writeText(url);
      toast.show(what);
    } catch {
      toast.show("Copying is not allowed in this browser. Select the link and copy it by hand.", { tone: "error" });
    }
  };

  const share = async (url: string) => {
    // navigator.share is missing on most desktop browsers even though the DOM types always declare it.
    const nav: Partial<Pick<Navigator, "share">> = navigator;
    if (nav.share) {
      try {
        await nav.share({ title: info?.name || "Mizuhiki room", text: shareText(info?.name ?? ""), url });
        return;
      } catch (e) {
        if ((e as Error).name === "AbortError") return;
      }
    }
    await copy(url, "Sharing is not available here, so the link was copied instead");
  };

  const title =
    view === "new"
      ? "New invite link"
      : view === "qr"
        ? "QR code"
        : view === "forward"
          ? "Send the link"
          : view === "reset"
            ? "Reset link?"
            : "Invite links";

  return (
    <Sheet open onClose={onClose} title={title} dismissable={!making}>
      <div className={s.sheetBody}>
        {view !== "main" ? (
          <button type="button" className={s.back} onClick={() => setView("main")} onPointerDown={ripple}>
            <Icon name="back" size={16} /> Invite links
          </button>
        ) : null}
        {!detail || !info ? (
          <Skeleton avatar lines={3} />
        ) : !allowed ? (
          <NotAllowed closed={detail.closed} />
        ) : view === "new" ? (
          <NewLink
            onCreate={async (o) => {
              await make({ primary: false, ...o });
              setView("main");
              toast.show("Link created. It is at the top of your extra links.");
            }}
          />
        ) : view === "qr" && primaryUrl ? (
          <QrView url={primaryUrl} roomName={info.name} />
        ) : view === "forward" && primaryUrl ? (
          <ForwardView
            url={primaryUrl}
            roomName={info.name}
            members={detail.members.filter((m) => m.status === "active").map((m) => m.address)}
            onDone={() => setView("main")}
          />
        ) : view === "reset" ? (
          <ResetView
            onCancel={() => setView("main")}
            onReset={async () => {
              await make({ primary: true, expiresAt: null, maxUses: null });
              setView("main");
              toast.show("Link reset. The old link no longer works.");
            }}
          />
        ) : (
          <>
            <RoomHead
              roomId={roomId}
              name={info.name}
              photo={info.photo}
              members={detail.members.filter((m) => m.status === "active").length}
              type={info.type}
            />
            <p className={s.lead}>
              {info.approval
                ? "People can ask to join with this link. The room key is sealed to them only after an admin approves."
                : "Anyone with this link joins automatically when an admin’s device next opens the room."}
            </p>

            {loadError ? (
              <Oops
                title="The invite links did not load"
                action={
                  <Button size="sm" variant="line" icon="undo" onClick={() => void load()}>
                    Try again
                  </Button>
                }
              >
                {loadError} No link was changed.
              </Oops>
            ) : rows === null || (making && !primary) ? (
              <div className={s.linkCard} aria-busy="true">
                <p className={s.muted}>
                  {making ? "Sealing the room card to a new link key…" : "Loading the room’s links…"}
                </p>
                <Skeleton height={52} />
              </div>
            ) : !primary ? (
              <Oops
                title="No invite link yet"
                action={
                  <Button
                    size="sm"
                    variant="cord"
                    icon="link"
                    busy={making}
                    onClick={() => {
                      setMaking(true);
                      setMakeError(null);
                      make({ primary: true, expiresAt: null, maxUses: null })
                        .catch((e: unknown) => setMakeError(failText(e, "The link was not made.")))
                        .finally(() => setMaking(false));
                    }}
                  >
                    Make a link
                  </Button>
                }
              >
                {makeError ?? "This room has no active link."} Nothing was shared.
              </Oops>
            ) : (
              <div className={[s.linkCard, fresh === primary.id ? s.pop : ""].join(" ")}>
                <div className={s.linkHead}>
                  <span className={s.linkTitle}>
                    <Icon name="link" size={16} /> Main link
                  </span>
                  <span className={s.muted}>{usesLabel(primary.uses, primary.maxUses)}</span>
                </div>
                {primaryUrl ? (
                  <>
                    <button type="button" className={s.url} onClick={() => void copy(primaryUrl)} title="Copy link">
                      <code>{primaryUrl}</code>
                      <Icon name="copy" size={16} />
                    </button>
                    <div className={s.actions}>
                      <ActionTile icon="copy" label="Copy link" tone="sakura" onClick={() => void copy(primaryUrl)} />
                      <ActionTile icon="share" label="Share link" tone="sora" onClick={() => void share(primaryUrl)} />
                      <ActionTile icon="qr" label="QR code" tone="butter" onClick={() => setView("qr")} />
                      <ActionTile
                        icon="send"
                        label="Send in Mizuhiki"
                        tone="matcha"
                        onClick={() => setView("forward")}
                      />
                    </div>
                  </>
                ) : (
                  <p className={s.notice}>
                    <Icon name="info" size={16} />
                    <span>
                      This link was made on another device. Its key never leaves the device that made it, so it cannot
                      be shown here. Reset it to get a link here.
                    </span>
                  </p>
                )}
                <Button variant="danger" full icon="undo" onClick={() => setView("reset")}>
                  Reset link
                </Button>
              </div>
            )}
            {primary ? (
              <AddToPage roomId={room.detail?.id ?? ""} roomName={info.name} url={primaryUrl ?? null} />
            ) : null}

            <section className={s.section} aria-labelledby="extra-links">
              <div className={s.sectionHead}>
                <h3 id="extra-links">More links</h3>
                <Button size="sm" variant="line" icon="plus" onClick={() => setView("new")}>
                  Create a new link
                </Button>
              </div>
              <p className={s.muted}>
                Links that stop after a time or a number of uses. Good for a deal or one pay run.
              </p>
              {rows === null ? (
                <Skeleton lines={2} />
              ) : extra.length === 0 ? (
                <p className={s.empty}>No extra links yet.</p>
              ) : (
                <ul className={s.list}>
                  {extra.map((r) => (
                    <LinkRow
                      key={r.id}
                      row={r}
                      now={now}
                      url={urls[r.id]}
                      fresh={fresh === r.id}
                      canRevoke={isAdmin || r.createdBy === account?.owner.address}
                      onCopy={(u) => void copy(u)}
                      onRevoke={async () => {
                        await revokeInvite(await room.acct(), roomId, r.id);
                        await load();
                        toast.show("Link revoked. It no longer works.");
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
            <LockLine>
              The link carries a key after the # sign. Mizuhiki never sees it, so only this device can show the link
              again.
            </LockLine>
          </>
        )}
      </div>
    </Sheet>
  );
}

function NotAllowed({ closed }: { closed: boolean }) {
  return (
    <p className={s.notice}>
      <Icon name="lock" size={16} />
      <span>
        {closed
          ? "This room was deleted, so it has no invite links."
          : "Only admins, and members an admin allowed to add people, can share invite links. Ask an admin for a link."}
      </span>
    </p>
  );
}

function RoomHead({
  roomId,
  name,
  photo,
  members,
  type,
}: {
  roomId: string;
  name: string;
  photo: InviteCard["photo"] | null;
  members: number;
  type: InviteCard["type"];
}) {
  const src = useSealedPhoto(photo);
  return (
    <div className={s.roomHead}>
      <Avatar name={name || "Room"} src={src} size={56} tone={toneOf(roomId)} />
      <div>
        <b className={s.roomName}>{name || "This room"}</b>
        <span className={s.muted}>
          {ROOM_TEMPLATES[type].label} room, {members === 1 ? "1 member" : `${members} members`}
        </span>
      </div>
    </div>
  );
}

function ActionTile({
  icon,
  label,
  tone,
  onClick,
}: {
  icon: "copy" | "share" | "qr" | "send";
  label: string;
  tone: "sakura" | "sora" | "butter" | "matcha";
  onClick: () => void;
}) {
  return (
    <button type="button" className={s.tile} onClick={onClick} onPointerDown={ripple}>
      <span className={[s.tileIcon, s[`t_${tone}`]].join(" ")} aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      {label}
    </button>
  );
}

function LinkRow({
  row,
  now,
  url,
  fresh,
  canRevoke,
  onCopy,
  onRevoke,
}: {
  row: InviteRow;
  now: Date;
  url: string | undefined;
  fresh: boolean;
  canRevoke: boolean;
  onCopy: (url: string) => void;
  onRevoke: () => Promise<void>;
}) {
  const state = linkState(row, now);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <li className={[s.row, state !== "active" ? s.dim : "", fresh ? s.pop : ""].join(" ")}>
      <div className={s.rowTop}>
        <StatusChip status={STATE_STATUS[state]}>{STATE_LABEL[state]}</StatusChip>
        <span className={s.rowMeta}>{usesLabel(row.uses, row.maxUses)}</span>
      </div>
      <span className={s.rowMeta}>
        <Icon name="clock" size={14} />{" "}
        {state === "revoked" ? `Made ${fmtWhen(new Date(row.createdAt), now)}` : expiryLabel(row.expiresAt, now)}
      </span>
      {state === "active" ? (
        confirm ? (
          <div className={s.confirm} role="group" aria-label="Revoke this link">
            <span>Revoke this link? It stops working at once. People who already asked to join stay in the queue.</span>
            {err ? <span className={s.err}>{err} The link still works.</span> : null}
            <div className={s.rowActions}>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} disabled={busy}>
                Keep it
              </Button>
              <Button
                size="sm"
                variant="danger"
                busy={busy}
                onClick={() => {
                  setBusy(true);
                  setErr(null);
                  onRevoke()
                    .catch((e: unknown) => setErr(failText(e, "The link was not revoked.")))
                    .finally(() => setBusy(false));
                }}
              >
                Revoke
              </Button>
            </div>
          </div>
        ) : (
          <div className={s.rowActions}>
            {url ? (
              <Button size="sm" variant="line" icon="copy" onClick={() => onCopy(url)}>
                Copy
              </Button>
            ) : (
              <span className={s.rowMeta}>Made on another device</span>
            )}
            {canRevoke ? (
              <Button size="sm" variant="ghost" icon="x" onClick={() => setConfirm(true)}>
                Revoke
              </Button>
            ) : null}
          </div>
        )
      ) : null}
    </li>
  );
}

/** Telegram's New Link screen: a time slider and a use slider, each with presets and a custom value. */
function NewLink({ onCreate }: { onCreate: (o: { expiresAt: Date | null; maxUses: number | null }) => Promise<void> }) {
  const ids = { time: useId(), uses: useId() };
  const [time, setTime] = useState<TimeChoice>({ kind: "stop", index: 3 });
  const [customAt, setCustomAt] = useState("");
  const [use, setUse] = useState<UseChoice>({ kind: "stop", index: 3 });
  const [customUses, setCustomUses] = useState("");
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(h);
  }, []);

  const customDate = time.kind === "custom" ? fromLocalInput(customAt) : null;
  const timeProblem = time.kind === "custom" ? customExpiryProblem(customDate, now) : null;
  const expires = time.kind === "custom" ? (timeProblem ? null : customDate) : expiryOf(time, now);
  const parsedUses = use.kind === "custom" ? parseUseLimit(customUses) : null;
  const usesProblem = parsedUses && "problem" in parsedUses ? parsedUses.problem : null;
  const maxUses = use.kind === "custom" ? (parsedUses && "uses" in parsedUses ? parsedUses.uses : null) : usesOf(use);
  const ready = !timeProblem && !usesProblem;

  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        setErr(null);
        onCreate({ expiresAt: expires, maxUses })
          .then(() => burstFrom(btn.current))
          .catch((x: unknown) => {
            setErr(failText(x, "The link was not made."));
            setBusy(false);
          });
      }}
    >
      <fieldset className={s.group}>
        <legend>Limit by time period</legend>
        <Slider
          id={ids.time}
          stops={TIME_STOPS.map((t) => t.label)}
          value={time.kind === "stop" ? time.index : null}
          onChange={(index) => setTime({ kind: "stop", index })}
          label="Time limit"
        />
        <p className={s.result} aria-live="polite">
          {time.kind === "custom"
            ? customDate && !timeProblem
              ? `Stops working ${fmtWhen(customDate, now)}`
              : "Pick when the link stops working."
            : expires
              ? `Stops working ${fmtWhen(expires, now)}`
              : "Never expires"}
        </p>
        {time.kind === "custom" ? (
          <TextField
            label="Expire after"
            type="datetime-local"
            value={customAt}
            min={toLocalInput(new Date(now.getTime() + 5 * 60_000))}
            onChange={(e) => setCustomAt(e.target.value)}
            error={customAt ? (timeProblem ?? undefined) : undefined}
            hint="Your device’s time zone."
          />
        ) : (
          <button
            type="button"
            className={s.textBtn}
            onClick={() => {
              setTime({ kind: "custom", at: new Date(now.getTime() + 2 * 86_400_000) });
              setCustomAt(toLocalInput(new Date(now.getTime() + 2 * 86_400_000)));
            }}
          >
            Set custom duration
          </button>
        )}
        <p className={s.help}>You can make the link stop working after a certain time.</p>
      </fieldset>

      <fieldset className={s.group}>
        <legend>Limit number of uses</legend>
        <Slider
          id={ids.uses}
          stops={USE_STOPS.map((u) => u.label)}
          value={use.kind === "stop" ? use.index : null}
          onChange={(index) => setUse({ kind: "stop", index })}
          label="Use limit"
        />
        <p className={s.result} aria-live="polite">
          {usesHelp(maxUses)}
        </p>
        {use.kind === "custom" ? (
          <TextField
            label="Custom limit"
            inputMode="numeric"
            value={customUses}
            onChange={(e) => setCustomUses(e.target.value)}
            error={customUses ? (usesProblem ?? undefined) : undefined}
            hint="From 1 to 100,000 people."
            autoFocus
          />
        ) : (
          <button
            type="button"
            className={s.textBtn}
            onClick={() => {
              setUse({ kind: "custom", uses: 25 });
              setCustomUses("25");
            }}
          >
            Enter custom limit
          </button>
        )}
        <p className={s.help}>You can make the link stop working after a certain number of people have used it.</p>
      </fieldset>

      {err ? <Oops title="The link was not made">{err} Nothing was shared.</Oops> : null}
      <Button ref={btn} type="submit" variant="cord" size="lg" full icon="link" busy={busy} disabled={!ready}>
        {busy ? "Sealing the room card…" : "Create link"}
      </Button>
    </form>
  );
}

/** A stepped slider with the stop names under it. `value` null = a custom value is chosen (no stop lit). */
function Slider({
  id,
  stops,
  value,
  onChange,
  label,
}: {
  id: string;
  stops: string[];
  value: number | null;
  onChange: (i: number) => void;
  label: string;
}) {
  const at = value ?? stops.length - 1;
  return (
    <div
      className={[s.slider, value === null ? s.sliderOff : ""].join(" ")}
      style={{ ["--pct" as string]: `${(at / (stops.length - 1)) * 100}%` }}
    >
      <input
        id={id}
        type="range"
        min={0}
        max={stops.length - 1}
        step={1}
        value={at}
        aria-label={label}
        aria-valuetext={value === null ? "Custom" : stops[at]}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <div className={s.stops} aria-hidden="true">
        {stops.map((t, i) => (
          <button
            key={t}
            type="button"
            tabIndex={-1}
            className={value === i ? s.stopOn : ""}
            onClick={() => onChange(i)}
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

function QrView({ url, roomName }: { url: string; roomName: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, {
      margin: 2,
      width: 1024,
      errorCorrectionLevel: "M",
      color: { dark: "#2b2340", light: "#ffffff" },
    }).then(
      (u) => alive && setQr(u),
      () => alive && setFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  const file = `${
    (roomName || "room")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "room"
  }-invite-qr.png`;
  return (
    <div className={s.qrView}>
      {qr ? (
        <img className={s.qr} src={qr} alt={`QR code for the invite link to ${roomName || "this room"}`} />
      ) : failed ? (
        <Oops title="The QR code could not be drawn">
          This browser could not draw it. The link works the same; copy it instead.
        </Oops>
      ) : (
        <Skeleton height={280} />
      )}
      <p className={s.lead}>
        Scanning it opens the invite. Anyone who scans it can ask to join, so share it like the link itself.
      </p>
      {qr ? (
        <ButtonLink href={qr} download={file} variant="line" full icon="download">
          Download PNG
        </ButtonLink>
      ) : null}
    </div>
  );
}

/** Send the link to a Mizuhiki account as a sealed, signed message in their inbox. */
function ForwardView({
  url,
  roomName,
  members,
  onDone,
}: {
  url: string;
  roomName: string;
  members: string[];
  onDone: () => void;
}) {
  const { account } = useAccount();
  const toast = useToast();
  const [who, setWho] = useState("");
  const [note, setNote] = useState("");
  const [step, setStep] = useState<{ s: SendStep; p: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const busy = step !== null;
  return (
    <form
      className={s.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!account) return;
        setErr(null);
        setStep({ s: "keys", p: 0.02 });
        void (async () => {
          try {
            const person = await lookupPerson(who);
            if (!person)
              throw new Error(
                `There is no Mizuhiki account called ${who.trim().startsWith("@") || who.trim().startsWith("qor1") ? who.trim() : `@${who.trim()}`}. Nothing was sent.`,
              );
            const label = person.name ? `@${person.name}` : shortAddress(person.address);
            if (person.address === account.owner.address)
              throw new Error("That is your own account. Nothing was sent.");
            if (members.includes(person.address))
              throw new Error(`${label} is already in this room. Nothing was sent.`);
            await sendSealed({
              to: { address: person.address, card: null },
              kind: "message",
              text: `${note.trim() ? `${note.trim()}\n\n` : ""}You are invited to “${roomName || "a room"}” on Mizuhiki. Open the link to ask to join: ${url}`,
              contact: "",
              files: [],
              extra: { link: url },
              maxFileBytes: 0,
              signer: account,
              onStep: (st, p) => setStep({ s: st, p }),
            });
            toast.show(`Sent to ${label}, sealed`);
            onDone();
          } catch (x) {
            setErr(failText(x, "Not sent. Nothing left your device."));
            setStep(null);
          }
        })();
      }}
    >
      <p className={s.lead}>The link goes to their Mizuhiki inbox, sealed to them and signed by you.</p>
      <TextField
        label="Send to"
        placeholder="@name or qor1… address"
        value={who}
        onChange={(e) => setWho(e.target.value)}
        disabled={busy}
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <TextField
        label="Note (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={280}
        counter
        disabled={busy}
      />
      {step ? (
        <div className={s.progress} role="status">
          <span className={s.bar}>
            <span style={{ transform: `scaleX(${step.p})` }} />
          </span>
          <span className={s.muted}>{SEND_STEP_LABEL[step.s]}…</span>
        </div>
      ) : null}
      {err ? <Oops title="Not sent">{err}</Oops> : null}
      <Button type="submit" variant="cord" size="lg" full icon="send" busy={busy} disabled={!who.trim()}>
        Seal and send
      </Button>
    </form>
  );
}

function ResetView({ onCancel, onReset }: { onCancel: () => void; onReset: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <div className={s.form}>
      <p className={s.warn}>
        <Icon name="alert" size={18} />
        <span>The old link stops working at once. People who already asked to join stay in the queue.</span>
      </p>
      <p className={s.muted}>You get a new link on this device. Share it again with anyone who still needs it.</p>
      {err ? <Oops title="The link was not reset">{err} The old link still works.</Oops> : null}
      <div className={s.rowActions}>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="danger"
          icon="undo"
          busy={busy}
          onClick={() => {
            setBusy(true);
            setErr(null);
            onReset().catch((e: unknown) => {
              setErr(failText(e, "The link was not reset."));
              setBusy(false);
            });
          }}
        >
          Reset link
        </Button>
      </div>
    </div>
  );
}
