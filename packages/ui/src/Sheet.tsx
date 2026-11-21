"use client";
/**
 * Bottom sheet on phones, centred card on desktop (spec 5.4). Built on the
 * native <dialog> in modal mode: focus is trapped, Escape closes, the page
 * behind is inert. Browser back closes the sheet when `history` is set.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./Button";
import s from "./Sheet.module.css";

/*
 * Sheets and the browser's back button. Opening a sheet adds a history entry
 * (keeping the router's own state on it), so back closes the sheet. Closing a
 * sheet in code must never go back itself: that back lands later, and if the
 * app navigates in the same moment (leave a room, then go to the list) it would
 * undo the navigation. So a sheet closed in code leaves its entry in place as a
 * "leftover": the next sheet reuses it, and a back press from it skips it.
 */
type HistoryState = Record<string, unknown> & { mzSheet?: string };
const state = (): HistoryState => (window.history.state as HistoryState | null) ?? {};
let onLeftover = false;
let skipping = false;
let lastPopWasOurs = false;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    lastPopWasOurs = skipping;
    if (skipping) {
      skipping = false;
      return;
    }
    if (onLeftover) {
      // Back from a leftover lands on the same page; take the step the person meant.
      onLeftover = false;
      skipping = true;
      lastPopWasOurs = true;
      window.history.back();
    }
  });
}
function markOpen(id: string) {
  if (onLeftover) window.history.replaceState({ ...state(), mzSheet: id }, "");
  else window.history.pushState({ ...state(), mzSheet: id }, "");
  onLeftover = false;
}
function markClosedInCode(id: string) {
  if (state().mzSheet !== id) return;
  const { mzSheet: _gone, ...rest } = state();
  window.history.replaceState(rest, "");
  onLeftover = true;
}

export function Sheet({
  open,
  onClose,
  title,
  children,
  history = true,
  wide = false,
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Push a history entry so browser back closes the sheet. */
  history?: boolean | undefined;
  wide?: boolean | undefined;
  /** False while work is running that must not be interrupted (sealing). */
  dismissable?: boolean | undefined;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const pushed = useRef(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissRef = useRef(dismissable);
  dismissRef.current = dismissable;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // The browser focuses the first control, which is Close, and draws a focus ring on it. Unless a field inside
      // asked for focus, focus the sheet itself: screen readers start at its title and Tab still reaches Close.
      if (document.activeElement instanceof HTMLElement && document.activeElement.dataset.sheetClose === "true")
        d.focus();
      if (history) {
        pushed.current = true;
        markOpen(titleId);
      }
    } else if (!open && d.open) {
      d.close();
      if (pushed.current) {
        pushed.current = false;
        markClosedInCode(titleId);
      }
    }
  }, [open, history, titleId]);

  useEffect(() => {
    if (!history) return;
    const pop = () => {
      // A back this module took (skipping a leftover) is not the person closing this sheet.
      if (lastPopWasOurs) return;
      if (pushed.current) {
        if (dismissRef.current) {
          pushed.current = false;
          onCloseRef.current();
        } else {
          // Work that must not be interrupted is running: stay open and put the entry back.
          window.history.pushState({ ...state(), mzSheet: titleId }, "");
        }
      }
    };
    addEventListener("popstate", pop);
    return () => removeEventListener("popstate", pop);
  }, [history, titleId]);

  return (
    <dialog
      ref={ref}
      className={[s.sheet, wide ? s.wide : ""].join(" ")}
      aria-labelledby={titleId}
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        if (dismissRef.current) onCloseRef.current();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && dismissRef.current) onCloseRef.current();
      }}
    >
      <div className={s.inner}>
        <div className={s.grab} aria-hidden="true" />
        <header className={s.head}>
          <h2 id={titleId}>{title}</h2>
          {dismissable ? (
            <IconButton icon="x" label="Close" size="sm" data-sheet-close="true" onClick={() => onCloseRef.current()} />
          ) : null}
        </header>
        <div className={s.body}>{children}</div>
      </div>
    </dialog>
  );
}
