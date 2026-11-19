/** Turns a page theme (Design tab) into CSS custom properties for the page renderer. */
import type { CSSProperties } from "react";
import type { Theme } from "@mizuhiki/core";
import { mediaUrl } from "@/lib/api";

const FONTS: Record<Theme["font"], string> = {
  round: "var(--font-round)",
  sans: "var(--font-sans)",
  jp: "var(--font-jp)",
};

const RADIUS: Record<Theme["button"]["radius"], string> = { pill: "999px", round: "18px", square: "8px" };

/** WCAG relative luminance of a #rrggbb colour. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] ?? 0) + 0.7152 * (ch[1] ?? 0) + 0.0722 * (ch[2] ?? 0);
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return ((x ?? 0) + 0.05) / ((y ?? 0) + 0.05);
}

export function themeVars(t: Theme): CSSProperties {
  const solid = t.button.style === "solid";
  const glass = t.button.style === "glass";
  const shadow = t.button.shadow ? "0 5px 0 var(--ink)" : "none";
  const vars: Record<string, string> = {
    "--page-font": FONTS[t.font],
    "--page-text": t.text,
    "--wp-a": t.wallpaper.a,
    "--wp-b": t.wallpaper.b,
    "--row-radius": RADIUS[t.button.radius],
    "--row-bg": solid ? t.button.color : glass ? "rgba(255,255,255,.45)" : "transparent",
    "--row-blur": glass ? "blur(10px) saturate(1.3)" : "none",
    "--row-border": "var(--ink)",
    "--row-shadow": shadow,
    "--row-shadow-hover": t.button.shadow ? "0 7px 0 var(--ink)" : "none",
    "--row-shadow-active": t.button.shadow ? "0 2px 0 var(--ink)" : "none",
    "--row-ink": luminance(solid ? t.button.color : t.wallpaper.a) < 0.25 ? "#ffffff" : "var(--ink)",
  };
  if (t.wallpaper.kind === "image" && t.wallpaper.image) vars["--wp-image"] = `url(${mediaUrl(t.wallpaper.image)})`;
  return vars;
}
