"use client";
/**
 * Rooms: the list on the left and the open room beside it on desktop; on a
 * phone the list is its own page and an open room covers the screen.
 */
import { Musubi } from "@mizuhiki/ui";
import { RoomList } from "./RoomList";
import { ChatView } from "./ChatView";
import { useRoomList } from "./useRoomList";
import s from "./rooms.module.css";

export function RoomsScreen({ roomId, isNew = false }: { roomId?: string | undefined; isNew?: boolean }) {
  const list = useRoomList(roomId);
  return (
    <div className={s.screen} data-open={roomId ? "1" : undefined}>
      <RoomList list={list} activeId={roomId} />
      {roomId ? <ChatView key={roomId} roomId={roomId} isNew={isNew} /> : null}
      {!roomId && list.rooms.length > 0 ? (
        <div className={s.screenEmpty} aria-hidden="true">
          <div>
            <Musubi face="normal" size={96} />
            <b>Pick a room</b>
            Messages open on this device only.
          </div>
        </div>
      ) : null}
    </div>
  );
}
