"use client";
import { useSyncExternalStore } from "react";

const sub = (cb: () => void) => {
  addEventListener("online", cb);
  addEventListener("offline", cb);
  return () => {
    removeEventListener("online", cb);
    removeEventListener("offline", cb);
  };
};

/** Browser connectivity; server render assumes online. */
export function useOnline(): boolean {
  return useSyncExternalStore(
    sub,
    () => navigator.onLine,
    () => true,
  );
}
