"use client";
/** Reload when a capsule event arrives (an invite, an acceptance, a plan, a release). Shares the dashboard's one socket. */
import { useRoomEvents } from "@/rooms/useRoom";

export function useCapsuleEvents(reload: () => void): boolean {
  return useRoomEvents((kind) => {
    if (kind === "capsule") reload();
  });
}
