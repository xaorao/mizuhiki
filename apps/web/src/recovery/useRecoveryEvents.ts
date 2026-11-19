"use client";
/** Reload when a recovery event arrives (an answer, an acceptance, a request). Shares the dashboard's one socket. */
import { useRoomEvents } from "@/rooms/useRoom";

export function useRecoveryEvents(reload: () => void): boolean {
  return useRoomEvents((kind) => {
    if (kind === "recovery") reload();
  });
}
