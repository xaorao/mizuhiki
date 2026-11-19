"use client";
/**
 * Bottom sheet on phones, centred card on desktop (spec 5.4). Built on the
 * native <dialog> in modal mode: focus is trapped, Escape closes, the page
 * behind is inert. Browser back closes the sheet when `history` is set.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./Button";
import s from "./Sheet.module.css";

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
      if (history) {
        window.history.pushState({ mzSheet: titleId }, "");
        pushed.current = true;
      }
    } else if (!open && d.open) {
      d.close();
      if (pushed.current) {
        pushed.current = false;
        window.history.back();
      }
    }
  }, [open, history, titleId]);

  useEffect(() => {
    if (!history) return;
    const pop = () => {
      if (pushed.current) {
        pushed.current = false;
        if (dismissRef.current) onCloseRef.current();
        else window.history.pushState({ mzSheet: titleId }, "");
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
          {dismissable ? <IconButton icon="x" label="Close" size="sm" onClick={() => onCloseRef.current()} /> : null}
        </header>
        <div className={s.body}>{children}</div>
      </div>
    </dialog>
  );
}
