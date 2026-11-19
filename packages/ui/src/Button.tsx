"use client";
import {
  createContext,
  forwardRef,
  useContext,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { Icon, type IconName } from "./Icon";
import { ripple } from "./motion";
import s from "./Button.module.css";

export type ButtonVariant = "cord" | "line" | "quiet" | "ink" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg" | "xl";

interface Common {
  variant?: ButtonVariant | undefined;
  size?: ButtonSize | undefined;
  icon?: IconName | undefined;
  iconRight?: IconName | undefined;
  full?: boolean | undefined;
  /** Shows a working state and blocks presses; keep the label (it says what is happening). */
  busy?: boolean | undefined;
  children?: ReactNode | undefined;
}

const cls = (o: Common, extra?: string) =>
  [s.btn, s[o.variant ?? "line"], s[o.size ?? "md"], o.full ? s.full : "", o.busy ? s.busy : "", extra ?? ""]
    .filter(Boolean)
    .join(" ");

function Inner({ icon, iconRight, busy, children, size }: Common) {
  const px = size === "sm" ? 16 : size === "xl" ? 22 : 20;
  return (
    <>
      {busy ? <span className={s.spin} aria-hidden="true" /> : icon ? <Icon name={icon} size={px} /> : null}
      {children !== undefined && <span className={s.label}>{children}</span>}
      {iconRight && !busy ? <Icon name={iconRight} size={px} /> : null}
    </>
  );
}

export const Button = forwardRef<HTMLButtonElement, Common & ButtonHTMLAttributes<HTMLButtonElement>>(function Button(
  { variant, size, icon, iconRight, full, busy, children, className, onPointerDown, disabled, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cls({ variant, size, full, busy }, className)}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      onPointerDown={(e) => {
        ripple(e);
        onPointerDown?.(e);
      }}
      {...rest}
    >
      <Inner icon={icon} iconRight={iconRight} busy={busy} size={size}>
        {children}
      </Inner>
    </button>
  );
});

/**
 * The anchor component link-buttons render. Apps with client-side routing
 * (Next.js) provide their Link here, so in-app navigation does not reload the
 * page (which would drop keys held in memory).
 */
type AnchorLike = ComponentType<
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; ref?: Ref<HTMLAnchorElement> }
>;
const LinkContext = createContext<AnchorLike | null>(null);
export function UiLinkProvider({ component, children }: { component: AnchorLike; children: ReactNode }) {
  return <LinkContext.Provider value={component}>{children}</LinkContext.Provider>;
}

export const ButtonLink = forwardRef<HTMLAnchorElement, Common & AnchorHTMLAttributes<HTMLAnchorElement>>(
  function ButtonLink(
    { variant, size, icon, iconRight, full, busy, children, className, onPointerDown, href = "", ...rest },
    ref,
  ) {
    const Provided = useContext(LinkContext);
    // New tabs, downloads and in-page anchors stay plain anchors.
    const plain = !Provided || !href || rest.target === "_blank" || rest.download !== undefined || href.startsWith("#");
    const A = (plain ? "a" : Provided) as AnchorLike;
    return (
      <A
        href={href}
        ref={ref}
        className={cls({ variant, size, full, busy }, className)}
        onPointerDown={(e) => {
          ripple(e);
          onPointerDown?.(e);
        }}
        {...rest}
      >
        <Inner icon={icon} iconRight={iconRight} busy={busy} size={size}>
          {children}
        </Inner>
      </A>
    );
  },
);

/** Round icon-only button. `label` is required: it is the accessible name. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  { icon: IconName; label: string; variant?: ButtonVariant | undefined; size?: ButtonSize | undefined } & Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "children"
  >
>(function IconButton({ icon, label, variant = "quiet", size = "md", className, onPointerDown, type, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={[s.btn, s.icon, s[variant], s[size], className ?? ""].join(" ")}
      onPointerDown={(e) => {
        ripple(e);
        onPointerDown?.(e);
      }}
      {...rest}
    >
      <Icon name={icon} size={size === "sm" ? 16 : 20} />
    </button>
  );
});
