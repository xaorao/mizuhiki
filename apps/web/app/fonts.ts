import { Figtree, JetBrains_Mono } from "next/font/google";

/**
 * Self-hosted brand fonts (brand README, type), exposed as --f-* for tokens.css.
 * Latin-only families come through next/font. The two Japanese families are
 * vendored by tools/vendor-fonts.mjs into app/fonts-jp.css (Google's own
 * unicode-range slices), so the build never downloads hundreds of slices.
 */
export const sans = Figtree({
  weight: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
  variable: "--f-sans",
  display: "swap",
});
export const mono = JetBrains_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--f-mono",
  display: "swap",
  preload: false,
});
