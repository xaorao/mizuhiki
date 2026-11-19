"use client";
/** Reload when the other side of a pass acts (accept, confirm, revoke, new copies). Shares the dashboard's one socket. */
import { useRoomEvents } from "@/rooms/useRoom";

export function usePassEvents(reload: () => void): boolean {
  return useRoomEvents((kind) => {
    if (kind === "pass") reload();
  });
}
