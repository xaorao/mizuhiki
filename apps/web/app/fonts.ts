import { M_PLUS_Rounded_1c, Figtree, Zen_Maru_Gothic, JetBrains_Mono } from "next/font/google";

/** Self-hosted brand fonts (brand README, type). Exposed as --f-* for tokens.css. */
export const round = M_PLUS_Rounded_1c({
  weight: ["500", "700", "800", "900"],
  subsets: ["latin"],
  variable: "--f-round",
  display: "swap",
});
export const sans = Figtree({
  weight: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
  variable: "--f-sans",
  display: "swap",
});
export const jp = Zen_Maru_Gothic({
  weight: ["500", "700", "900"],
  subsets: ["latin"],
  variable: "--f-jp",
  display: "swap",
  preload: false,
});
export const mono = JetBrains_Mono({
  weight: ["400", "500"],
  subsets: ["latin"],
  variable: "--f-mono",
  display: "swap",
  preload: false,
});
