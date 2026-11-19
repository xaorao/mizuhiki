"use client";
/** Plugs Next's client-side Link into the design system's link-buttons (no page reload, keys stay unlocked). */
import Link from "next/link";
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";
import { UiLinkProvider } from "@mizuhiki/ui";

const NextAnchor = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }>(
  function NextAnchor({ href, ...rest }, ref) {
    return <Link ref={ref} href={href} {...(rest as Record<string, unknown>)} />;
  },
);

export function AppLinks({ children }: { children: ReactNode }) {
  return <UiLinkProvider component={NextAnchor}>{children}</UiLinkProvider>;
}
