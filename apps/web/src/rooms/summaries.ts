/**
 * Room summaries handed from an open room to the room list in the same tab,
 * so the list never reopens (and refetches) the room already on screen.
 */
import type { RoomSummary } from "./engine";

const subs = new Set<(roomId: string, s: RoomSummary) => void>();

export function publishSummary(roomId: string, s: RoomSummary): void {
  for (const f of subs) f(roomId, s);
}
export function onSummary(f: (roomId: string, s: RoomSummary) => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}
