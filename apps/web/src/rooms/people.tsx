"use client";
/**
 * Shared room pieces: names for addresses (@name from the registry index, or
 * a short address), avatars for people and rooms, and sealed photos opened
 * on this device.
 */
import { useEffect, useState } from "react";
import { Avatar } from "@mizuhiki/ui";
import { decryptFile, type FileFacts } from "@mizuhiki/core";
import { api } from "@/lib/api";
import { nameOf, shortAddress } from "./engine";
import type { PillText } from "./derive";

const TONES = ["peach", "sakura", "sora", "matcha", "butter", "fuji"] as const;
export const toneOf = (key: string) => {
  let n = 7;
  for (let i = 0; i < key.length; i++) n = (n * 31 + key.charCodeAt(i)) >>> 0;
  return TONES[n % TONES.length] ?? "peach";
};

/** Resolve many addresses to names; unresolved ones show a short address until they arrive. */
export function useNames(addresses: string[]): Record<string, string | null> {
  const [names, setNames] = useState<Record<string, string | null>>({});
  const key = [...new Set(addresses)].sort().join(",");
  useEffect(() => {
    let alive = true;
    const list = key ? key.split(",") : [];
    void Promise.all(list.map(async (a) => [a, await nameOf(a)] as const)).then((pairs) => {
      if (alive) setNames(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [key]);
  return names;
}

/** "@ana", "You", or a short address. */
export function label(address: string, names: Record<string, string | null>, me?: string): string {
  if (me && address === me) return "You";
  const n = names[address];
  return n ? `@${n}` : shortAddress(address);
}

export function pillString(text: PillText, names: Record<string, string | null>, me?: string): string {
  return text.map((p) => (typeof p === "string" ? p : label(p.who, names, me))).join("");
}

export function PersonAvatar({ address, names, size = 40 }: { address: string; names: Record<string, string | null>; size?: number }) {
  return <Avatar name={names[address] ?? address.slice(4, 6)} size={size} tone={toneOf(address)} />;
}

const photoCache = new Map<string, Promise<string | null>>();

/** Open a sealed photo on this device and keep an object URL for this session. */
export function useSealedPhoto(facts: FileFacts | null | undefined): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const id = facts?.fileId;
  useEffect(() => {
    if (!facts || !id) {
      setUrl(undefined);
      return;
    }
    let alive = true;
    let p = photoCache.get(id);
    if (!p) {
      p = decryptFile({ facts, fetchChunk: (h) => api.bytes(`/blobs/${h}`) })
        .then((parts) => URL.createObjectURL(new Blob(parts as BlobPart[], { type: facts.type })))
        .catch(() => {
          photoCache.delete(id);
          return null;
        });
      photoCache.set(id, p);
    }
    void p.then((u) => {
      if (alive) setUrl(u ?? undefined);
    });
    return () => {
      alive = false;
    };
    // The file id identifies the photo; the facts object can be re-created with the same content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  return url;
}

export function RoomAvatar({ name, photo, roomId, size = 44 }: { name: string; photo: FileFacts | null | undefined; roomId: string; size?: number }) {
  const src = useSealedPhoto(photo);
  return <Avatar name={name || "Room"} src={src} size={size} tone={toneOf(roomId)} />;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
