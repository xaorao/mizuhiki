"use client";
/**
 * The chat screen of a room (Telegram + WhatsApp, adapted): header with the
 * room's photo, name, member count and key number; a pinned bar; the
 * timeline with day separators, bubbles, replies, reactions, files and
 * system pills (every key change says who can no longer read); the composer
 * with @mentions, replies and sealed attachments. Everything opens and is
 * sealed on this device.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { Button, Icon, IconButton, Oops, Sheet, Skeleton, useToast } from "@mizuhiki/ui";
import { decryptFile, type FileFacts } from "@mizuhiki/core";
import { useAccount } from "@/account/AccountProvider";
import { api } from "@/lib/api";
import {
  deleteForEveryone,
  forgetRoom,
  leaveRoom,
  newMsgId,
  postMessage,
  sealRoomFile,
  setMuted,
  type Line,
} from "./engine";
import { can, durationLabel, snippetOf, type Item } from "./derive";
import { PersonAvatar, RoomAvatar, fmtBytes, label, pillString, toneOf, useNames, useSealedPhoto } from "./people";
import { useRoom } from "./useRoom";
import { RoomInfoPanel } from "./info/RoomInfoPanel";
import { InviteLinks } from "./invite/InviteLinks";
import { DirectMessage } from "./DirectMessage";
import s from "./rooms.module.css";
import { failureText } from "@/lib/failure";

const REACTIONS = ["❤️", "👍", "😂", "😮", "🙏", "🎉"];
const BANNER_KEY = "mzk:room-banner-seen";

type MessageItem = Extract<Item, { type: "message" }>;

function time(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === y.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], {
    weekday: "long",
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

/** Text with @mentions of members highlighted. */
function Rich({ text, names, me }: { text: string; names: Record<string, string | null>; me: string }): ReactNode {
  const known = new Map(Object.entries(names).flatMap(([a, n]) => (n ? [[n.toLowerCase(), a] as const] : [])));
  const parts = text.split(/(@[a-z0-9._-]{3,30})/gi);
  return parts.map((p, i) => {
    const who = p.startsWith("@") ? known.get(p.slice(1).toLowerCase()) : undefined;
    if (!who) return <span key={i}>{p}</span>;
    return (
      <span key={i} className={s.mention} data-me={who === me || undefined}>
        {p}
      </span>
    );
  });
}

export function ChatView({ roomId, isNew }: { roomId: string; isNew: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const { account } = useAccount();
  const room = useRoom(roomId);
  const { detail, derived } = room;
  const me = account?.owner.address ?? "";
  const [panel, setPanel] = useState<"info" | "invites" | null>(null);
  const [menu, setMenu] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [replyTo, setReplyTo] = useState<MessageItem | null>(null);
  const [actionFor, setActionFor] = useState<MessageItem | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<MessageItem | null>(null);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [sending, setSending] = useState<{ id: string; text: string; progress?: number }[]>([]);
  const [banner, setBanner] = useState(false);
  const [pinIndex, setPinIndex] = useState(0);
  const [dmTo, setDmTo] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(0);

  const people = useMemo(() => {
    const set = new Set<string>(detail?.members.map((m) => m.address) ?? []);
    for (const l of room.lines) if (l.msg) set.add(l.msg.author);
    for (const it of derived?.items ?? [])
      if (it.type === "pill") for (const p of it.text) if (typeof p !== "string") set.add(p.who);
    return [...set];
  }, [detail, room.lines, derived]);
  const names = useNames(people);

  useEffect(() => {
    try {
      setBanner(localStorage.getItem(`${BANNER_KEY}:${roomId}`) !== "1");
    } catch {
      setBanner(true);
    }
  }, [roomId]);
  const dismissBanner = () => {
    setBanner(false);
    try {
      localStorage.setItem(`${BANNER_KEY}:${roomId}`, "1");
    } catch {
      // Private windows can refuse storage; the banner simply shows again next time.
    }
  };

  const items = useMemo(() => derived?.items ?? [], [derived]);
  const active = detail?.me.status === "active";
  const mine = detail?.me;
  const count = detail?.members.filter((m) => m.status === "active").length ?? 0;
  const info = derived?.info;
  const title = info?.name || (room.loading ? "" : "Unnamed room");

  // Search over text and file captions on this device.
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as string[];
    return items
      .filter((i): i is MessageItem => i.type === "message")
      .filter((i) =>
        (i.body.kind === "text" ? i.body.text : `${i.body.caption} ${(i.body.file as unknown as FileFacts).name}`)
          .toLowerCase()
          .includes(q),
      )
      .map((i) => i.key);
  }, [items, query]);
  const current = hits.length ? hits[Math.min(hit, hits.length - 1)] : undefined;
  useEffect(() => {
    if (!current) return;
    document.getElementById(`m-${current}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [current]);

  // Stay at the bottom when new lines arrive, unless the person scrolled up.
  const lastKey = items[items.length - 1]?.key;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (nearBottom.current) {
      el.scrollTop = el.scrollHeight;
      setUnseen(0);
    } else setUnseen((n) => n + 1);
  }, [lastKey, sending.length]);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom.current) setUnseen(0);
  };
  const toBottom = () => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  };

  const jumpTo = (msgId: string) => {
    const el = document.getElementById(`m-${msgId}`);
    if (!el) {
      toast.show("That message is no longer here.");
      return;
    }
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.dataset.flash = "1";
    setTimeout(() => delete el.dataset.flash, 1400);
  };

  const send = useCallback(
    async (text: string, files: File[]) => {
      const a = await room.acct();
      const mentions = Object.entries(names)
        .filter(([addr, n]) => n && addr !== me && new RegExp(`@${n.replace(/[.]/g, "\\.")}\\b`, "i").test(text))
        .map(([addr]) => addr);
      const reply = replyTo?.key;
      setReplyTo(null);
      const jobs: Array<{ id: string; run: () => Promise<unknown> }> = [];
      for (const f of files) {
        const id = newMsgId();
        jobs.push({
          id,
          run: async () => {
            const facts = await sealRoomFile(a, f, (p) =>
              setSending((x) => x.map((j) => (j.id === id ? { ...j, progress: p } : j))),
            );
            await postMessage(
              a,
              roomId,
              {
                kind: "file",
                file: facts as unknown as Record<string, unknown>,
                caption: files.length === 1 ? text : "",
                ...(reply ? { replyTo: reply } : {}),
              },
              id,
            );
          },
        });
        setSending((x) => [...x, { id, text: `Sealing ${f.name}`, progress: 0 }]);
      }
      if (text.trim() && !(files.length === 1)) {
        const id = newMsgId();
        jobs.push({
          id,
          run: () =>
            postMessage(
              a,
              roomId,
              { kind: "text", text: text.trim(), mentions, ...(reply ? { replyTo: reply } : {}) },
              id,
            ),
        });
        setSending((x) => [...x, { id, text: text.trim() }]);
      }
      nearBottom.current = true;
      for (const j of jobs) {
        try {
          await j.run();
        } catch (e) {
          toast.show(`Not sent: ${failureText(e, "Try again.")}`, { tone: "error" });
        } finally {
          setSending((x) => x.filter((p) => p.id !== j.id));
        }
      }
      await room.reload();
    },
    [room, roomId, names, me, replyTo, toast],
  );

  const react = async (it: MessageItem, emoji: string) => {
    setActionFor(null);
    const on = !(it.reactions[emoji] ?? []).includes(me);
    try {
      await postMessage(await room.acct(), roomId, { kind: "reaction", target: it.key, emoji, on });
      await room.reload();
    } catch (e) {
      toast.show(failureText(e, "That did not work. Try again."), { tone: "error" });
    }
  };
  const pin = async (it: MessageItem) => {
    setActionFor(null);
    try {
      await postMessage(await room.acct(), roomId, { kind: "pin", target: it.key, on: !it.pinned });
      await room.reload();
      toast.show(it.pinned ? "Unpinned." : "Pinned for everyone.");
    } catch (e) {
      toast.show(failureText(e, "That did not work. Try again."), { tone: "error" });
    }
  };
  const remove = async (it: MessageItem) => {
    setConfirmDelete(null);
    try {
      await deleteForEveryone(await room.acct(), roomId, it.line);
      await room.reload();
      toast.show("Deleted for everyone. The sealed copy was removed from storage.");
    } catch (e) {
      toast.show(failureText(e, "That did not work. Try again."), { tone: "error" });
    }
  };
  const copy = async (it: MessageItem) => {
    setActionFor(null);
    if (it.body.kind !== "text") return;
    try {
      await navigator.clipboard.writeText(it.body.text);
      toast.show("Copied.");
    } catch {
      toast.show("This browser did not allow copying.", { tone: "error" });
    }
  };
  const toggleMute = async () => {
    setMenu(false);
    if (!detail) return;
    try {
      await setMuted(await room.acct(), roomId, !detail.me.muted);
      await room.reload();
      toast.show(detail.me.muted ? "Notifications on." : "Muted. You will not be told about new messages.");
    } catch (e) {
      toast.show(failureText(e, "That did not work. Try again."), { tone: "error" });
    }
  };
  const leave = async () => {
    setConfirmLeave(false);
    try {
      await leaveRoom(await room.acct(), roomId);
      toast.show("You left the room. The key changes as soon as an admin's device is open.");
      router.push("/app/rooms");
    } catch (e) {
      toast.show(failureText(e, "That did not work. Try again."), { tone: "error" });
    }
  };
  const forget = async () => {
    try {
      await forgetRoom(await room.acct(), roomId);
      router.push("/app/rooms");
    } catch (e) {
      toast.show(failureText(e, "That did not work. Try again."), { tone: "error" });
    }
  };

  const pinned = derived?.pinned ?? [];
  const pinShown = pinned.length ? pinned[pinIndex % pinned.length] : undefined;
  const createdBy = detail?.epochs.find((e) => e.epoch === 1)?.by;
  const canAdd = can(mine, "add");

  if (room.error && !detail)
    return (
      <div className={s.chatEmpty}>
        <Oops
          title="This room did not open"
          action={
            <Button variant="line" size="sm" icon="back" onClick={() => router.push("/app/rooms")}>
              Back to rooms
            </Button>
          }
        >
          {room.error}
        </Oops>
      </div>
    );

  return (
    <div className={s.chatWrap} data-panel={panel === "info" || undefined}>
      <section className={s.chat} aria-label={title || "Room"}>
        <header className={s.chatHead}>
          <IconButton
            icon="back"
            label="Back to rooms"
            className={s.backBtn}
            onClick={() => router.push("/app/rooms")}
          />
          <button
            type="button"
            className={s.headWho}
            onClick={() => setPanel(panel === "info" ? null : "info")}
            aria-label="Room info"
          >
            <RoomAvatar name={title} photo={info?.photo} roomId={roomId} size={42} />
            <span>
              <b>{title || <Skeleton lines={1} />}</b>
              <small>
                {detail && !active
                  ? detail.me.status === "left"
                    ? "You left this room"
                    : "You are no longer in this room"
                  : `${count} ${count === 1 ? "member" : "members"}${info?.autoDeleteSeconds ? ` · new messages delete after ${durationLabel(info.autoDeleteSeconds)}` : ""}`}
              </small>
            </span>
          </button>
          {detail && active ? (
            <span
              className={s.keyChip}
              title={`Room key number ${detail.epoch}. It changes every time someone joins or leaves.`}
            >
              <Icon name="key" size={14} />
              Key {detail.epoch}
            </span>
          ) : null}
          <IconButton icon="search" label="Search in room" onClick={() => setSearching((v) => !v)} />
          <IconButton icon="more" label="More" onClick={() => setMenu(true)} />
        </header>

        {searching ? (
          <div className={s.searchBar}>
            <Icon name="search" size={18} />
            <input
              autoFocus
              placeholder="Search in this room"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHit(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") setHit((h) => (hits.length ? (h + 1) % hits.length : 0));
                if (e.key === "Escape") setSearching(false);
              }}
              aria-label="Search in this room"
            />
            <span className={s.searchCount}>
              {query
                ? hits.length
                  ? `${Math.min(hit, hits.length - 1) + 1} of ${hits.length}`
                  : "No results"
                : "Searches on this device"}
            </span>
            <IconButton
              icon="chev"
              label="Earlier result"
              className={s.up}
              disabled={!hits.length}
              onClick={() => setHit((h) => (h + 1) % hits.length)}
            />
            <IconButton
              icon="chev"
              label="Later result"
              className={s.down}
              disabled={!hits.length}
              onClick={() => setHit((h) => (h - 1 + hits.length) % hits.length)}
            />
            <IconButton
              icon="x"
              label="Close search"
              onClick={() => {
                setSearching(false);
                setQuery("");
              }}
            />
          </div>
        ) : null}

        {pinShown ? (
          <button
            type="button"
            className={s.pinBar}
            onClick={() => {
              jumpTo(pinShown.msgId);
              setPinIndex((i) => i + 1);
            }}
          >
            <Icon name="pin" size={16} />
            <span>
              <b>Pinned{pinned.length > 1 ? ` · ${(pinIndex % pinned.length) + 1} of ${pinned.length}` : ""}</b>
              <small>{pinShown.text}</small>
            </span>
          </button>
        ) : null}
        {room.chainCheck === "mismatch" ? (
          <p className={s.chainWarn} role="alert">
            <Icon name="alert" size={16} />
            The member list this server shows does not match the room&apos;s record on QoreChain. Do not send anything
            sensitive until an admin checks the members.
          </p>
        ) : null}
        {room.chore ? (
          <p className={s.chore} role="status">
            <span className={s.spinner} aria-hidden="true" />
            {room.chore}
          </p>
        ) : null}
        {room.requests.length > 0 && active ? (
          <button type="button" className={s.requestBar} onClick={() => setPanel("info")}>
            <Icon name="users" size={16} />
            {room.requests.length === 1 ? "1 person asked to join" : `${room.requests.length} people asked to join`}
            {can(mine, "add") && (mine?.role === "admin" || mine?.role === "owner")
              ? " · Review"
              : " · An admin will review"}
          </button>
        ) : null}

        <div className={s.timeline} ref={scroller} onScroll={onScroll} data-nosave={info?.restrictSaving || undefined}>
          {room.loading && !derived ? (
            <div className={s.loadingLines}>
              <Skeleton avatar lines={2} />
              <Skeleton avatar lines={1} />
              <Skeleton avatar lines={2} />
            </div>
          ) : (
            <>
              {banner ? (
                <div className={s.e2eBanner}>
                  <Icon name="lock" size={16} />
                  <p>
                    Messages and files are sealed to the people in this room. Only they can open them, on their own
                    devices. When someone leaves, the key changes.
                  </p>
                  <IconButton icon="x" label="Hide this note" size="sm" onClick={dismissBanner} />
                </div>
              ) : null}
              <div className={s.creation}>
                <RoomAvatar name={title} photo={info?.photo} roomId={roomId} size={72} />
                <b>
                  {createdBy === me
                    ? "You created this room"
                    : createdBy
                      ? `${label(createdBy, names, me)} created this room`
                      : "Room"}
                </b>
                <small>
                  {active ? `Room · ${count} ${count === 1 ? "member" : "members"}` : "Room"}
                  {info?.description ? ` · ${info.description}` : ""}
                </small>
                {active && canAdd && (isNew || count < 3) ? (
                  <div className={s.creationActions}>
                    <Button variant="line" size="sm" icon="plus" onClick={() => setPanel("info")}>
                      Add members
                    </Button>
                    <Button variant="line" size="sm" icon="qr" onClick={() => setPanel("invites")}>
                      Invite via link or QR code
                    </Button>
                  </div>
                ) : null}
              </div>
              {info?.restrictSaving ? (
                <p className={s.pill}>
                  Members are asked not to save what is said here. Screenshots cannot be prevented.
                </p>
              ) : null}
              {items.map((it) =>
                it.type === "day" ? (
                  <p key={it.key} className={s.day}>
                    {dayLabel(it.date)}
                  </p>
                ) : it.type === "pill" ? (
                  <p key={it.key} className={it.tone === "key" ? s.keyPill : s.pill}>
                    {it.tone === "key" ? <Icon name="key" size={14} /> : null}
                    {pillString(it.text, names, me)}
                  </p>
                ) : it.type === "problem" ? (
                  <p key={it.key} className={s.problem}>
                    <Icon name="lock" size={14} />
                    {it.line.problem === "no-key"
                      ? "A message sealed with a key this device does not have (sent before you joined, or after you left)."
                      : it.line.problem === "bad-signature"
                        ? "A message whose signature did not check out against QoreChain. It is hidden."
                        : it.line.problem === "not-member"
                          ? "A message from someone who was not in the room at that time. It is hidden."
                          : "A message that could not be opened. It may be damaged."}
                  </p>
                ) : (
                  <Bubble
                    key={it.key}
                    it={it}
                    me={me}
                    names={names}
                    parent={it.body.replyTo ? derived?.byId.get(it.body.replyTo) : undefined}
                    highlighted={current === it.key}
                    onJump={jumpTo}
                    onMenu={() => setActionFor(it)}
                    onReact={(e) => void react(it, e)}
                  />
                ),
              )}
              {sending.map((p) => (
                <div key={p.id} className={s.bubbleRow} data-mine="1">
                  <div className={s.bubble} data-mine="1" data-sending="1">
                    <p>{p.text}</p>
                    <span className={s.meta}>
                      {p.progress !== undefined ? `${Math.round(p.progress * 100)}% · ` : ""}
                      <span className={s.spinner} aria-hidden="true" /> Sealing
                    </span>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
        {unseen > 0 ? (
          <button type="button" className={s.newBelow} onClick={toBottom}>
            <Icon name="chev" size={16} /> New messages
          </button>
        ) : null}

        {detail && !active ? (
          <div className={s.inactive}>
            <p>
              {detail.me.status === "left"
                ? "You left this room. You keep what you already saw here; new messages are sealed with a key you do not have."
                : "You were removed from this room. You keep what you already saw here; new messages are sealed with a key you do not have."}
            </p>
            <Button variant="line" size="sm" icon="trash" onClick={() => void forget()}>
              Remove from my list
            </Button>
          </div>
        ) : detail && !can(mine, "send") && !can(mine, "files") ? (
          <div className={s.inactive}>
            <p>An admin turned off sending for you in this room. You can still read.</p>
          </div>
        ) : detail ? (
          <Composer
            names={names}
            members={detail.members.filter((m) => m.status === "active" && m.address !== me).map((m) => m.address)}
            canSend={can(mine, "send")}
            canFiles={can(mine, "files")}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            replyLabel={replyTo ? label(replyTo.author, names, me) : ""}
            onSend={send}
          />
        ) : null}
      </section>

      {panel === "info" && detail ? (
        <aside className={s.side} aria-label="Room info">
          <RoomInfoPanel
            room={room}
            onClose={() => setPanel(null)}
            onOpenInvites={() => setPanel("invites")}
            onMessage={(address: string) => setDmTo(address)}
          />
        </aside>
      ) : null}
      {panel === "invites" && detail ? <InviteLinks room={room} onClose={() => setPanel(null)} /> : null}

      <DirectMessage to={dmTo} toLabel={dmTo ? label(dmTo, names, me) : ""} onClose={() => setDmTo(null)} />

      <Sheet open={menu} onClose={() => setMenu(false)} title={title || "Room"}>
        <div className={s.menuList}>
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              setPanel("info");
            }}
          >
            <Icon name="info" size={20} /> Room info
          </button>
          <button
            type="button"
            onClick={() => {
              setMenu(false);
              setSearching(true);
            }}
          >
            <Icon name="search" size={20} /> Search
          </button>
          {active ? (
            <button type="button" onClick={() => void toggleMute()}>
              <Icon name="bell" size={20} /> {detail.me.muted ? "Unmute" : "Mute"}
            </button>
          ) : null}
          {active && canAdd ? (
            <button
              type="button"
              onClick={() => {
                setMenu(false);
                setPanel("invites");
              }}
            >
              <Icon name="link" size={20} /> Invite link
            </button>
          ) : null}
          {active && mine?.role !== "owner" ? (
            <button
              type="button"
              className={s.danger}
              onClick={() => {
                setMenu(false);
                setConfirmLeave(true);
              }}
            >
              <Icon name="logout" size={20} /> Leave room
            </button>
          ) : null}
        </div>
      </Sheet>

      <Sheet open={actionFor !== null} onClose={() => setActionFor(null)} title="Message">
        {actionFor ? (
          <div className={s.menuList}>
            <div className={s.reactRow} role="group" aria-label="React">
              {REACTIONS.map((e) => (
                <button
                  key={e}
                  type="button"
                  aria-pressed={(actionFor.reactions[e] ?? []).includes(me)}
                  onClick={() => void react(actionFor, e)}
                >
                  {e}
                </button>
              ))}
            </div>
            {active && can(mine, "send") ? (
              <button
                type="button"
                onClick={() => {
                  setReplyTo(actionFor);
                  setActionFor(null);
                }}
              >
                <Icon name="reply" size={20} /> Reply
              </button>
            ) : null}
            {actionFor.body.kind === "text" && !info?.restrictSaving ? (
              <button type="button" onClick={() => void copy(actionFor)}>
                <Icon name="copy" size={20} /> Copy
              </button>
            ) : null}
            {active && can(mine, "pin") ? (
              <button type="button" onClick={() => void pin(actionFor)}>
                <Icon name="pin" size={20} /> {actionFor.pinned ? "Unpin" : "Pin for everyone"}
              </button>
            ) : null}
            {active && (actionFor.author === me || mine?.role === "admin" || mine?.role === "owner") ? (
              <button
                type="button"
                className={s.danger}
                onClick={() => {
                  setConfirmDelete(actionFor);
                  setActionFor(null);
                }}
              >
                <Icon name="trash" size={20} /> Delete for everyone
              </button>
            ) : null}
            <p className={s.menuNote}>
              Sent {new Date(actionFor.line.msg?.sentAt ?? actionFor.line.at).toLocaleString()} · signed by{" "}
              {label(actionFor.author, names, me)}, checked against QoreChain
              {actionFor.line.expiresAt ? ` · deletes ${new Date(actionFor.line.expiresAt).toLocaleDateString()}` : ""}
            </p>
          </div>
        ) : null}
      </Sheet>

      <Sheet open={confirmDelete !== null} onClose={() => setConfirmDelete(null)} title="Delete for everyone?">
        <p className={s.sheetText}>
          The sealed copy is removed from storage and the message disappears for everyone. People who already opened it
          may still have seen it.
        </p>
        <div className={s.sheetActions}>
          <Button variant="line" onClick={() => setConfirmDelete(null)}>
            Cancel
          </Button>
          <Button variant="danger" icon="trash" onClick={() => confirmDelete && void remove(confirmDelete)}>
            Delete for everyone
          </Button>
        </div>
      </Sheet>

      <Sheet open={confirmLeave} onClose={() => setConfirmLeave(false)} title="Leave this room?">
        <p className={s.sheetText}>
          You stop getting new messages at once. The room key changes the next time an admin&apos;s device is open, so
          you cannot read anything sent after you leave. You keep what you already saw.
        </p>
        <div className={s.sheetActions}>
          <Button variant="line" onClick={() => setConfirmLeave(false)}>
            Stay
          </Button>
          <Button variant="danger" icon="logout" onClick={() => void leave()}>
            Leave room
          </Button>
        </div>
      </Sheet>
    </div>
  );
}

function Bubble({
  it,
  me,
  names,
  parent,
  highlighted,
  onJump,
  onMenu,
  onReact,
}: {
  it: MessageItem;
  me: string;
  names: Record<string, string | null>;
  parent: Line | undefined;
  highlighted: boolean;
  onJump: (id: string) => void;
  onMenu: () => void;
  onReact: (emoji: string) => void;
}) {
  const mine = it.author === me;
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const startPress = () => {
    press.current = setTimeout(onMenu, 480);
  };
  const endPress = () => clearTimeout(press.current);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " " || e.key === "ContextMenu") {
      e.preventDefault();
      onMenu();
    }
  };
  const sentAt = it.line.msg?.sentAt ?? it.line.at;
  return (
    <div id={`m-${it.key}`} className={s.bubbleRow} data-mine={mine || undefined} data-hit={highlighted || undefined}>
      {!mine ? <PersonAvatar address={it.author} names={names} size={32} /> : null}
      <div className={s.bubbleCol}>
        <div
          className={s.bubble}
          data-mine={mine || undefined}
          tabIndex={0}
          role="article"
          aria-label={`${label(it.author, names, me)}, ${time(sentAt)}`}
          onContextMenu={(e) => {
            e.preventDefault();
            onMenu();
          }}
          onPointerDown={(e) => {
            if (e.pointerType !== "mouse") startPress();
          }}
          onPointerUp={endPress}
          onPointerLeave={endPress}
          onKeyDown={onKey}
        >
          {!mine ? (
            <b className={s.author} data-tone={toneOf(it.author)}>
              {label(it.author, names, me)}
            </b>
          ) : null}
          {parent?.msg ? (
            <button type="button" className={s.quote} onClick={() => parent.msg && onJump(parent.msg.id)}>
              <b>{label(parent.msg.author, names, me)}</b>
              <span>{snippetOf(parent.msg.body)}</span>
            </button>
          ) : it.body.replyTo ? (
            <span className={s.quote} data-gone="1">
              <span>Reply to a message that is no longer here</span>
            </span>
          ) : null}
          {it.body.kind === "file" ? <FileBody facts={it.body.file as unknown as FileFacts} /> : null}
          {it.body.kind === "text" ? (
            <p>
              <Rich text={it.body.text} names={names} me={me} />
            </p>
          ) : it.body.caption ? (
            <p>
              <Rich text={it.body.caption} names={names} me={me} />
            </p>
          ) : null}
          <span className={s.meta}>
            {it.pinned ? <Icon name="pin" size={12} label="Pinned" /> : null}
            {it.line.expiresAt ? <Icon name="clock" size={12} label="Deletes automatically" /> : null}
            {time(sentAt)}
          </span>
          <button type="button" className={s.moreBtn} aria-label="Message actions" onClick={onMenu}>
            <Icon name="more" size={16} />
          </button>
        </div>
        {Object.keys(it.reactions).length ? (
          <div className={s.reactions}>
            {Object.entries(it.reactions).map(([emoji, who]) => (
              <button
                key={emoji}
                type="button"
                aria-pressed={who.includes(me)}
                title={who.map((w) => label(w, names, me)).join(", ")}
                onClick={() => onReact(emoji)}
              >
                {emoji} {who.length}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function FileBody({ facts }: { facts: FileFacts }) {
  const isImage = facts.type.startsWith("image/") && !facts.type.includes("svg");
  const url = useSealedPhoto(isImage ? facts : null);
  const [busy, setBusy] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const save = async () => {
    setBusy(0);
    setFailed(false);
    try {
      const parts = await decryptFile({
        facts,
        fetchChunk: (h) => api.bytes(`/blobs/${h}`),
        onProgress: (d, t) => setBusy(d / Math.max(1, t)),
      });
      const href = URL.createObjectURL(
        new Blob(parts as BlobPart[], { type: facts.type || "application/octet-stream" }),
      );
      const a = document.createElement("a");
      a.href = href;
      a.download = facts.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(href), 10_000);
    } catch {
      setFailed(true);
    } finally {
      setBusy(null);
    }
  };
  if (isImage)
    return (
      <button type="button" className={s.photo} onClick={() => void save()} aria-label={`Save ${facts.name}`}>
        {url ? <img src={url} alt={facts.name} /> : <span className={s.photoWait}>Unsealing photo…</span>}
      </button>
    );
  return (
    <button type="button" className={s.fileRow} onClick={() => void save()} disabled={busy !== null}>
      <span className={s.fileIcon}>
        <Icon name="file" size={20} />
      </span>
      <span>
        <b>{facts.name}</b>
        <small>
          {failed
            ? "Could not unseal. A piece may have expired."
            : busy !== null
              ? `Unsealing ${Math.round(busy * 100)}%`
              : `${fmtBytes(facts.size)} · sealed · tap to save`}
        </small>
      </span>
      <Icon name="download" size={18} />
    </button>
  );
}

function Composer({
  names,
  members,
  canSend,
  canFiles,
  replyTo,
  replyLabel,
  onCancelReply,
  onSend,
}: {
  names: Record<string, string | null>;
  members: string[];
  canSend: boolean;
  canFiles: boolean;
  replyTo: MessageItem | null;
  replyLabel: string;
  onCancelReply: () => void;
  onSend: (text: string, files: File[]) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [mention, setMention] = useState<{ q: string; at: number } | null>(null);
  const [pick, setPick] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);

  useLayoutEffect(() => {
    const el = area.current;
    if (el && caret.current !== null) {
      el.focus();
      el.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (replyTo) area.current?.focus();
  }, [replyTo]);

  // Grow with the text, up to six lines.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const options = useMemo(() => {
    if (!mention) return [];
    const q = mention.q.toLowerCase();
    return members.filter((a) => names[a] && names[a].toLowerCase().startsWith(q)).slice(0, 6);
  }, [mention, members, names]);

  const onChange = (v: string, caret: number) => {
    setText(v);
    const m = /(^|\s)@([a-z0-9._-]{0,30})$/i.exec(v.slice(0, caret));
    setMention(m ? { q: m[2] ?? "", at: caret - (m[2]?.length ?? 0) - 1 } : null);
    setPick(0);
  };
  const choose = (address: string) => {
    if (!mention) return;
    const n = names[address];
    if (!n) return;
    const end = mention.at + 1 + mention.q.length;
    const next = `${text.slice(0, mention.at)}@${n} ${text.slice(end)}`;
    // The caret goes right after "@name " in the same commit as the new text, so the next key lands there.
    caret.current = mention.at + n.length + 2;
    setText(next);
    setMention(null);
  };
  const submit = () => {
    if (!text.trim() && files.length === 0) return;
    if (!canSend && files.length === 0) return;
    const t = canSend ? text : "";
    const f = files;
    setText("");
    setFiles([]);
    setMention(null);
    void onSend(t, f);
  };

  return (
    <div className={s.composer}>
      {replyTo ? (
        <div className={s.replyBar}>
          <Icon name="reply" size={16} />
          <span>
            <b>Replying to {replyLabel}</b>
            <small>{snippetOf(replyTo.body)}</small>
          </span>
          <IconButton icon="x" label="Cancel reply" size="sm" onClick={onCancelReply} />
        </div>
      ) : null}
      {files.length ? (
        <ul className={s.attachList}>
          {files.map((f, i) => (
            <li key={`${f.name}:${i}`}>
              <Icon name={f.type.startsWith("image/") ? "image" : "file"} size={16} />
              <span>{f.name}</span>
              <small>{fmtBytes(f.size)}</small>
              <button
                type="button"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((x) => x.filter((_, j) => j !== i))}
              >
                <Icon name="x" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {options.length ? (
        <ul className={s.mentions} role="listbox" aria-label="Mention someone">
          {options.map((a, i) => (
            <li key={a}>
              <button
                type="button"
                role="option"
                aria-selected={i === pick}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(a);
                }}
              >
                <PersonAvatar address={a} names={names} size={26} />@{names[a]}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={s.composeRow}>
        {canFiles ? (
          <>
            <IconButton icon="upload" label="Attach files" onClick={() => fileInput.current?.click()} />
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                setFiles((x) => [...x, ...picked].slice(0, 10));
                e.target.value = "";
              }}
            />
          </>
        ) : null}
        <textarea
          ref={area}
          rows={1}
          className={s.input}
          placeholder={canSend ? "Message" : "You can send files only"}
          disabled={!canSend}
          value={text}
          aria-label="Message"
          onChange={(e) => onChange(e.target.value, e.target.selectionStart)}
          onKeyDown={(e) => {
            if (options.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault();
              setPick((p) => (p + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length);
              return;
            }
            if (options.length && (e.key === "Enter" || e.key === "Tab")) {
              e.preventDefault();
              const a = options[pick];
              if (a) choose(a);
              return;
            }
            if (e.key === "Escape") setMention(null);
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <IconButton
          icon="send"
          label="Send sealed"
          variant="cord"
          disabled={!text.trim() && files.length === 0}
          onClick={submit}
        />
      </div>
      <p className={s.composeNote}>
        <Icon name="lock" size={12} /> Sealed on this device to the people in this room
      </p>
    </div>
  );
}
