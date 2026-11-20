"use client";
/**
 * A value that only the browser knows (the URL's query, whether the Web Share API exists), read without breaking
 * hydration: React renders the server value while hydrating and switches to the browser's value right after,
 * instead of finding different HTML and throwing the server's away. `read` must return a primitive (or the
 * same object each time).
 */
import { useSyncExternalStore } from "react";

const never = () => () => undefined;

export function useClient<T extends string | number | boolean | null>(read: () => T, onServer: T): T {
  return useSyncExternalStore(never, read, () => onServer);
}

/** The page's query string ("" on the server and while hydrating). */
export const useSearch = (): string => useClient(() => window.location.search, "");

/** The page's path and query, for "come back here after logging in" links ("/" on the server). */
export const useHere = (): string => useClient(() => `${window.location.pathname}${window.location.search}`, "/");

/** Whether this browser can open the system share sheet (false on the server and most desktops). */
export const useCanShare = (): boolean =>
  useClient(() => typeof (navigator as Partial<Pick<Navigator, "share">>).share === "function", false);
