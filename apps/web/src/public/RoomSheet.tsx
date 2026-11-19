"use client";
/**
 * A "Join my room" button on a public page opens this card in place: the
 * room's name and photo (opened with the key in the invite link the owner
 * put on the page), how joining works, and the way in.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, LockLine, Oops, Sheet, Skeleton } from "@mizuhiki/ui";
import { ROOM_TEMPLATES, type Block } from "@mizuhiki/core";
import { openInvite, type InviteCard, type InvitePreview } from "@/rooms/engine";
import { RoomAvatar } from "@/rooms/people";
import s from "./public.module.css";

type Room = Extract<Block, { type: "room" }>;

export function RoomSheet({ block, ownerName, open, onClose }: { block: Room | null; ownerName: string; open: boolean; onClose: () => void }) {
  const router = useRouter();
  const [state, setState] = useState<{ s: "loading" } | { s: "ok"; preview: InvitePreview; card: InviteCard } | { s: "failed"; why: string }>({ s: "loading" });
  const invite = block?.invite;

  useEffect(() => {
    if (!open || !invite) return;
    const m = /^\/join\/([a-z0-9]{12,32})#k=([A-Za-z0-9_-]{43})$/.exec(invite);
    if (!m?.[1] || !m[2]) {
      setState({ s: "failed", why: "This room link on the page is damaged. Ask the owner for a new one." });
      return;
    }
    setState({ s: "loading" });
    void openInvite(m[1], m[2]).then(
      (r) => setState({ s: "ok", ...r }),
      (e: unknown) => setState({ s: "failed", why: (e as Error).message }),
    );
  }, [open, invite]);

  const closed = state.s === "ok" && state.preview.state !== "ok";
  return (
    <Sheet open={open} onClose={onClose} title={block?.title ?? "Room"}>
      {state.s === "loading" ? (
        <Skeleton avatar lines={3} />
      ) : state.s === "failed" ? (
        <Oops title="This room could not be opened">{state.why}</Oops>
      ) : (
        <div className={s.roomCard}>
          <RoomAvatar name={state.card.name} photo={state.card.photo} roomId={state.preview.roomId} size={72} />
          <b>{state.card.name}</b>
          <small>
            {ROOM_TEMPLATES[state.card.type].label} room · {state.preview.members} {state.preview.members === 1 ? "member" : "members"}
          </small>
          {state.card.description ? <p>{state.card.description}</p> : null}
          {closed ? (
            <p className={s.roomNote}>
              {state.preview.state === "expired"
                ? "This invite has expired. Ask @" + ownerName + " for a new one."
                : state.preview.state === "used-up"
                  ? "This invite reached its limit. Ask @" + ownerName + " for a new one."
                  : "This invite was reset. Ask @" + ownerName + " for a new one."}
            </p>
          ) : (
            <>
              <p className={s.roomNote}>
                {state.preview.approval
                  ? `@${ownerName} approves each person. Once you are in, messages and files are sealed to the people in the room.`
                  : "You join as soon as an admin's device next opens the room. Messages and files are sealed to the people in it."}
              </p>
              <LockLine>Joining needs a Mizuhiki key, which takes a minute to make. You will see messages from the day you join unless an admin shares earlier ones.</LockLine>
              <Button variant="cord" icon="users" full onClick={() => invite && router.push(invite)}>
                {state.preview.approval ? "Ask to join" : "Join"}
              </Button>
            </>
          )}
        </div>
      )}
    </Sheet>
  );
}
