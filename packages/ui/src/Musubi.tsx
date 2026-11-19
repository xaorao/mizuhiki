"use client";
/**
 * Musubi, the mascot: a soft white mochi with a glossy red mizuhiki bow and a gold
 * knot. Drawing code ported from the approved Level 3 preview (`musubi(face)`),
 * with six faces and the same reactions: watches the pointer, hops, wiggles its bow.
 * Decorative: always hidden from screen readers.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type JSX } from "react";
import { useReducedMotion } from "./motion";
import s from "./Musubi.module.css";

export type MusubiFace = "normal" | "happy" | "worried" | "sleepy" | "wink" | "cover";
export const MUSUBI_FACES: MusubiFace[] = ["normal", "happy", "worried", "sleepy", "wink", "cover"];

const INK = "#2b2340";

function Face({ face }: { face: MusubiFace }): JSX.Element {
  switch (face) {
    case "happy":
      return (
        <>
          <path
            d="M70 121 Q80 107 90 121 M130 121 Q140 107 150 121"
            fill="none"
            stroke={INK}
            strokeWidth="5.5"
            strokeLinecap="round"
          />
          <path d="M95 133 Q110 156 125 133Z" fill="#e2483d" stroke={INK} strokeWidth="4" strokeLinejoin="round" />
          <path d="M102 144 Q110 150 118 144" fill="#ff9aa9" />
        </>
      );
    case "worried":
      return (
        <>
          <path d="M68 100 L90 106 M152 100 L130 106" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
          <ellipse cx="80" cy="119" rx="7" ry="9" fill={INK} />
          <ellipse cx="140" cy="119" rx="7" ry="9" fill={INK} />
          <circle cx="82.5" cy="115" r="2.6" fill="#fff" />
          <circle cx="142.5" cy="115" r="2.6" fill="#fff" />
          <path d="M102 142 Q110 134 118 142" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
          <path
            d="M168 86 C164 96 160 102 166 106 C172 108 175 100 168 86Z"
            fill="#bfe3ff"
            stroke={INK}
            strokeWidth="3"
          />
        </>
      );
    case "sleepy":
      return (
        <>
          <path
            d="M70 120 Q80 126 90 120 M130 120 Q140 126 150 120"
            fill="none"
            stroke={INK}
            strokeWidth="5"
            strokeLinecap="round"
          />
          <ellipse cx="110" cy="140" rx="5" ry="4" fill={INK} />
          <g fontFamily="M PLUS Rounded 1c,sans-serif" fontWeight="900" fill="#7a5a6e">
            <text x="160" y="70" fontSize="22" className={s.z1}>
              z
            </text>
            <text x="178" y="52" fontSize="16" className={s.z2}>
              z
            </text>
          </g>
        </>
      );
    case "wink":
      return (
        <>
          <ellipse cx="80" cy="117" rx="8.5" ry="10.5" fill={INK} />
          <circle cx="83" cy="112.5" r="3.2" fill="#fff" />
          <path d="M130 119 Q140 109 150 119" fill="none" stroke={INK} strokeWidth="5.5" strokeLinecap="round" />
          <path d="M98 134 Q110 148 122 134" fill="none" stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
        </>
      );
    case "cover":
      return (
        <>
          <path d="M100 138 Q110 146 120 138" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
          <g fill="#fff8f2" stroke={INK} strokeWidth="4.5" className={s.paws}>
            <ellipse cx="80" cy="116" rx="21" ry="15" transform="rotate(-14 80 116)" />
            <ellipse cx="140" cy="116" rx="21" ry="15" transform="rotate(14 140 116)" />
          </g>
          <g stroke="#e8cfc0" strokeWidth="3" strokeLinecap="round">
            <path d="M70 110 l4 10 M80 107 l3 11 M150 110 l-4 10 M140 107 l-3 11" />
          </g>
        </>
      );
    default:
      return (
        <>
          <ellipse cx="80" cy="117" rx="8.5" ry="10.5" fill={INK} />
          <ellipse cx="140" cy="117" rx="8.5" ry="10.5" fill={INK} />
          <circle cx="83" cy="112.5" r="3.2" fill="#fff" />
          <circle cx="143" cy="112.5" r="3.2" fill="#fff" />
          <circle cx="77.5" cy="121" r="1.4" fill="#fff" opacity=".8" />
          <circle cx="137.5" cy="121" r="1.4" fill="#fff" opacity=".8" />
          <path
            d="M100 136 Q105 142 110 136 Q115 142 120 136"
            fill="none"
            stroke={INK}
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
  }
}

export interface MusubiProps {
  face?: MusubiFace | undefined;
  /** Width in px; height follows the 220:214 drawing. */
  size?: number | undefined;
  /** Eyes follow the pointer (hero only; off with reduced motion). */
  watch?: boolean | undefined;
  /** Slow idle bob. */
  bob?: boolean | undefined;
  /** Change this value to make Musubi hop once. */
  hopKey?: number | string | undefined;
  sticker?: boolean | undefined;
  className?: string | undefined;
  style?: CSSProperties | undefined;
}

export function Musubi({
  face = "normal",
  size = 120,
  watch = false,
  bob = false,
  hopKey,
  sticker = true,
  className,
  style,
}: MusubiProps) {
  const id = useId().replace(/:/g, "");
  const reduced = useReducedMotion();
  const root = useRef<HTMLSpanElement>(null);
  const eyes = useRef<SVGGElement>(null);
  const [hopping, setHopping] = useState(false);

  useEffect(() => {
    if (hopKey === undefined || reduced) return;
    setHopping(false);
    const r = requestAnimationFrame(() => setHopping(true));
    const t = setTimeout(() => setHopping(false), 760);
    return () => {
      cancelAnimationFrame(r);
      clearTimeout(t);
    };
  }, [hopKey, reduced]);

  useEffect(() => {
    if (!watch || reduced || face !== "normal") return;
    const move = (e: PointerEvent) => {
      const el = root.current;
      const g = eyes.current;
      if (!el || !g) return;
      const r = el.getBoundingClientRect();
      const dx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / 400));
      const dy = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / 400));
      g.setAttribute("transform", `translate(${(dx * 6).toFixed(2)} ${(dy * 4).toFixed(2)})`);
    };
    addEventListener("pointermove", move, { passive: true });
    return () => removeEventListener("pointermove", move);
  }, [watch, reduced, face]);

  const cls = [s.musubi, sticker ? "sticker" : "", bob && !reduced ? s.bob : "", hopping ? s.hop : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span ref={root} className={cls} style={{ width: size, ...style }} aria-hidden="true" data-face={face}>
      <svg viewBox="0 0 220 214" className={s.svg} aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id={`mb${id}`} cx=".38" cy=".3" r=".85">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset=".6" stopColor="#fff8f1" />
            <stop offset="1" stopColor="#f6e4d6" />
          </radialGradient>
          <radialGradient id={`mk${id}`} cx=".5" cy=".5" r=".5">
            <stop offset="0" stopColor="#ff9fb2" stopOpacity=".95" />
            <stop offset="1" stopColor="#ff9fb2" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`mr${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ff7466" />
            <stop offset="1" stopColor="#c8342b" />
          </linearGradient>
          <radialGradient id={`mg${id}`} cx=".35" cy=".3" r=".8">
            <stop offset="0" stopColor="#fff2b8" />
            <stop offset=".6" stopColor="#f6c94a" />
            <stop offset="1" stopColor="#c48f14" />
          </radialGradient>
        </defs>
        <ellipse cx="110" cy="200" rx="66" ry="8" fill={INK} opacity=".13" />
        <g className={s.body}>
          <ellipse cx="72" cy="182" rx="17" ry="9" fill={`url(#mb${id})`} stroke={INK} strokeWidth="4.5" />
          <ellipse cx="148" cy="182" rx="17" ry="9" fill={`url(#mb${id})`} stroke={INK} strokeWidth="4.5" />
          <path
            d="M20 132 C20 80 60 54 110 54 C160 54 200 80 200 132 C200 171 164 190 110 190 C56 190 20 171 20 132Z"
            fill={`url(#mb${id})`}
            stroke={INK}
            strokeWidth="5"
          />
          <ellipse cx="72" cy="86" rx="22" ry="11" fill="#fff" opacity=".9" transform="rotate(-24 72 86)" />
          <circle cx="98" cy="74" r="4" fill="#fff" opacity=".9" />
          <ellipse cx="62" cy="138" rx="18" ry="11" fill={`url(#mk${id})`} />
          <ellipse cx="158" cy="138" rx="18" ry="11" fill={`url(#mk${id})`} />
          <g ref={face === "normal" ? eyes : undefined} className={s.face}>
            <Face face={face} />
          </g>
          <g className={s.bow} transform="translate(110 56)">
            <path d="M-3 4 C-10 18 -16 26 -20 36" stroke="#c8342b" strokeWidth="7" strokeLinecap="round" fill="none" />
            <path d="M3 4 C10 18 16 26 20 36" stroke="#c8342b" strokeWidth="7" strokeLinecap="round" fill="none" />
            <path
              d="M0 0 C-20 -32 -60 -26 -52 0 C-46 18 -14 10 0 0Z"
              fill={`url(#mr${id})`}
              stroke={INK}
              strokeWidth="4"
              strokeLinejoin="round"
            />
            <path
              d="M0 0 C20 -32 60 -26 52 0 C46 18 14 10 0 0Z"
              fill={`url(#mr${id})`}
              stroke={INK}
              strokeWidth="4"
              strokeLinejoin="round"
            />
            <path
              d="M-36 -10 C-28 -18 -14 -14 -6 -5"
              fill="none"
              stroke="#fff"
              strokeWidth="4"
              strokeLinecap="round"
              opacity=".85"
            />
            <path
              d="M36 -10 C28 -18 14 -14 6 -5"
              fill="none"
              stroke="#fff"
              strokeWidth="4"
              strokeLinecap="round"
              opacity=".85"
            />
            <circle r="11" fill={`url(#mg${id})`} stroke={INK} strokeWidth="4" />
            <circle cx="-3" cy="-4" r="3" fill="#fff" opacity=".8" />
          </g>
        </g>
      </svg>
    </span>
  );
}

/** Face changes that revert: `react("happy", 1400)` then back to the resting face. Callbacks are stable. */
export function useMusubi(resting: MusubiFace = "normal") {
  const [face, setFace] = useState<MusubiFace>(resting);
  const [hopKey, setHopKey] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const restingRef = useRef(resting);
  restingRef.current = resting;
  useEffect(() => () => clearTimeout(timer.current), []);
  const hop = useCallback(() => setHopKey((k) => k + 1), []);
  const react = useCallback((f: MusubiFace, ms = 1400, doHop = true) => {
    clearTimeout(timer.current);
    setFace(f);
    if (doHop) setHopKey((k) => k + 1);
    if (ms > 0) timer.current = setTimeout(() => setFace(restingRef.current), ms);
  }, []);
  const set = useCallback((f: MusubiFace) => {
    clearTimeout(timer.current);
    setFace(f);
  }, []);
  return useMemo(() => ({ face, hopKey, hop, react, set }), [face, hopKey, hop, react, set]);
}
