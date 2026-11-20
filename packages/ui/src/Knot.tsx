/**
 * The five-loop mizuhiki knot: cord-red loops around an ink hub (brand mark).
 * `tie` draws the petals one after another and pops the hub: the seal moment.
 */
import type { CSSProperties } from "react";
import s from "./Knot.module.css";

const PETAL = "M6 0 C18.6 -44.8 85.8 -36.4 90 0 C85.8 36.4 18.6 44.8 6 0Z";
const ANGLES = [-90, -18, 54, 126, 198];

export function Knot({
  size = 28,
  tie = false,
  tied = true,
  color = "var(--cord)",
  hub = "var(--ink)",
  className,
  style,
  title,
}: {
  size?: number | undefined;
  /** Animate tying (draw petals, pop hub). */
  tie?: boolean | undefined;
  /** When `tie` is set, false holds the untied start state. */
  tied?: boolean | undefined;
  color?: string | undefined;
  hub?: string | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  title?: string | undefined;
}) {
  const cls = [s.knot, tie ? s.tie : "", tie && tied ? s.go : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <svg
      viewBox="6 6 188 188"
      width={size}
      height={size}
      className={cls}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <g fill="none" stroke={color} strokeWidth="10" strokeLinejoin="round">
        {ANGLES.map((a, i) => (
          <path
            key={a}
            className={s.petal}
            style={{ ["--i" as string]: i }}
            d={PETAL}
            transform={`translate(100 100) rotate(${a})`}
          />
        ))}
      </g>
      <circle className={s.hub} cx="100" cy="100" r="16" fill={hub} />
    </svg>
  );
}

/** The wordmark: knot + lowercase "mizuhiki" in the round face + 水引 in cord red. */
export function Wordmark({ size = 24, href }: { size?: number | undefined; href?: string | undefined }) {
  const inner = (
    <>
      <Knot size={Math.round(size * 1.2)} />
      <span className={s.word} style={{ fontSize: size }}>
        mizuhiki
      </span>
      <span className={s.kanji} lang="ja" style={{ fontSize: Math.round(size * 0.58) }}>
        水引
      </span>
    </>
  );
  return href ? (
    // Named by its visible text (WCAG 2.5.3, label in name), with "home" for screen readers only.
    <a className={s.mark} href={href}>
      {inner}
      <span className="sr-only"> home</span>
    </a>
  ) : (
    <span className={s.mark}>{inner}</span>
  );
}
