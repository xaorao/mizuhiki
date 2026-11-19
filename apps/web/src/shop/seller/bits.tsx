"use client";
/** Small pieces the seller screens share: the row menu, a confirm sheet, a product thumbnail and the rich-text renderer. */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Button, Icon, Sheet, type IconName } from "@mizuhiki/ui";
import type { ProductDef } from "@mizuhiki/core";
import { mediaUrl } from "@/lib/api";
import { KIND_ICON, KIND_TONE, parseRich } from "./model";
import s from "./seller.module.css";

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
}

/** A "more" button that opens a short list of actions (Escape, outside tap and Tab close it). */
export function RowMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    addEventListener("pointerdown", away);
    addEventListener("keydown", key);
    root.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    return () => {
      removeEventListener("pointerdown", away);
      removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <div className={s.menuRoot} ref={root}>
      <button
        type="button"
        className={s.menuBtn}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more" size={18} />
      </button>
      {open ? (
        <div
          className={s.menu}
          role="menu"
          id={id}
          onKeyDown={(e) => {
            const all = [...(root.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
            const i = all.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              all[(i + 1) % all.length]?.focus();
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              all[(i - 1 + all.length) % all.length]?.focus();
            } else if (e.key === "Tab") setOpen(false);
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              className={it.danger ? s.menuDanger : undefined}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              <Icon name={it.icon} size={16} />
              {it.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A confirmation for something that cannot be taken back. */
export function Confirm({
  open,
  title,
  children,
  confirm,
  danger = true,
  busy,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} dismissable={!busy}>
      <div className={s.confirm}>
        <div className={s.confirmText}>{children}</div>
        <div className={s.actionsEnd}>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant={danger ? "danger" : "cord"} busy={busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}

/** Square thumbnail: the thumbnail, else the first cover, else the kind's icon on its pastel. */
export function Thumb({ def, size = 44 }: { def: Pick<ProductDef, "thumbnail" | "covers" | "kind" | "title">; size?: number }) {
  const pic = def.thumbnail ?? def.covers[0] ?? null;
  return (
    <span className={[s.thumb, s[`tone_${KIND_TONE[def.kind]}`]].join(" ")} style={{ width: size, height: size }} aria-hidden="true">
      {pic ? <img src={mediaUrl(pic.hash)} alt="" /> : <Icon name={KIND_ICON[def.kind]} size={Math.round(size * 0.46)} />}
    </span>
  );
}

/** The description subset buyers see: paragraphs, **bold**, *italic* and links. */
export function RichText({ text, className }: { text: string; className?: string | undefined }) {
  const paras = parseRich(text);
  return (
    <div className={[s.rich, className ?? ""].join(" ")}>
      {paras.map((p, i) => (
        <p key={i}>
          {p.map((x, j) =>
            x.t === "b" ? (
              <strong key={j}>{x.text}</strong>
            ) : x.t === "i" ? (
              <em key={j}>{x.text}</em>
            ) : x.t === "a" ? (
              <a key={j} href={x.href} target="_blank" rel="noopener noreferrer nofollow">
                {x.text}
              </a>
            ) : (
              <Lines key={j} text={x.text} />
            ),
          )}
        </p>
      ))}
    </div>
  );
}

function Lines({ text }: { text: string }) {
  const parts = text.split("\n");
  return (
    <>
      {parts.map((t, i) => (
        <span key={i}>
          {i > 0 ? <br /> : null}
          {t}
        </span>
      ))}
    </>
  );
}

export const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
