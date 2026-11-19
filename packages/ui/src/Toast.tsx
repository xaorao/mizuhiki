"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Musubi } from "./Musubi";
import s from "./Toast.module.css";

interface ToastItem {
  id: number;
  text: ReactNode;
  action?: { label: string; onClick: () => void };
  tone: "ok" | "info" | "error";
}
interface ToastApi {
  show: (
    text: ReactNode,
    opts?: {
      action?: { label: string; onClick: () => void };
      tone?: ToastItem["tone"] | undefined;
      ms?: number | undefined;
    },
  ) => void;
}
const Ctx = createContext<ToastApi | null>(null);

/** Toasts for transient results ("Link added" with Share, "Published", Undo). One at a time, polite. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const n = useRef(0);
  const show = useCallback<ToastApi["show"]>((text, opts) => {
    clearTimeout(timer.current);
    const id = ++n.current;
    setItem({ id, text, tone: opts?.tone ?? "ok", ...(opts?.action ? { action: opts.action } : {}) });
    timer.current = setTimeout(
      () => setItem((cur) => (cur?.id === id ? null : cur)),
      opts?.ms ?? (opts?.action ? 6000 : 3200),
    );
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Ctx.Provider value={{ show }}>
      {children}
      <div className={s.region} role="status" aria-live="polite">
        {item ? (
          <div key={item.id} className={[s.toast, s[item.tone]].join(" ")}>
            <Musubi
              face={item.tone === "error" ? "worried" : item.tone === "ok" ? "wink" : "normal"}
              size={30}
              sticker={false}
            />
            <span className={s.text}>{item.text}</span>
            {item.action ? (
              <button
                type="button"
                className={s.action}
                onClick={() => {
                  item.action?.onClick();
                  setItem(null);
                }}
              >
                {item.action.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const c = useContext(Ctx);
  if (!c) throw new Error("useToast needs <ToastProvider>");
  return c;
}
