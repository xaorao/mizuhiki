"use client";
/**
 * The flow map (spec 5.9, Typeform's Workflow view): every screen in order,
 * the endings at the bottom, a straight arrow for "next", a coloured curve
 * for each rule jump labelled with its short sentence, and a dashed curve for
 * "all other cases". Pure SVG drawn from the same path logic the runner uses.
 */
import { useId, useMemo, type KeyboardEvent } from "react";
import { Icon, type IconName } from "@mizuhiki/ui";
import { isQuestion, type FormDef } from "@mizuhiki/core";
import { KINDS } from "./model";
import {
  blockLabel,
  flowEdges,
  questionNumber,
  ruleSentence,
  unreachable,
  type FlowEdge,
  type FlowStep,
} from "./logicHelpers";
import s from "./logic.module.css";

const NODE_W = 210;
const NODE_H = 46;
const PITCH = 76;
const END_GAP = 34;
const LANE = 16;
const LABEL_W = 156;
const PAD = 14;
/** Rule curves cycle through the theme's inks so neighbouring jumps stay apart. */
const RULE_COLOURS = ["var(--cord)", "var(--sora-ink)", "var(--matcha-ink)", "var(--fuji-ink)", "var(--butter-ink)"];

interface MapNode {
  key: string;
  /** Edge-space index (screens, then endings); -1 for the welcome screen. */
  n: number;
  y: number;
  code: string;
  title: string;
  full: string;
  icon: IconName;
  kind: "welcome" | "step" | "ending";
  /** The block to scroll to when picked. */
  target: string | null;
  lost: boolean;
}

const clip = (t: string, n: number) => {
  const one = t
    .replace(/\{\{[A-Za-z0-9_-]{1,40}\}\}/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};

/** Give each curve a lane so curves that overlap in height never share one. */
function lanes(edges: FlowEdge[]): Map<FlowEdge, number> {
  const out = new Map<FlowEdge, number>();
  const taken: [number, number][][] = [];
  const sorted = [...edges].sort((a, b) => a.to - a.from - (b.to - b.from) || a.from - b.from);
  for (const e of sorted) {
    let lane = 0;
    while (taken[lane]?.some(([a, b]) => e.from <= b && a <= e.to)) lane++;
    (taken[lane] ??= []).push([e.from, e.to]);
    out.set(e, lane);
  }
  return out;
}

export function FlowMap({
  def,
  steps,
  onPick,
  active,
}: {
  def: FormDef;
  steps: FlowStep[];
  /** A screen was picked: show the rules of this block. */
  onPick: (blockId: string) => void;
  /** The path the "Try it" box is showing, in edge space. */
  active?: { from: number; to: number } | null | undefined;
}) {
  const uid = useId().replace(/:/g, "");
  const edges = useMemo(() => flowEdges(def, steps), [def, steps]);
  const lost = useMemo(() => unreachable(def, steps), [def, steps]);
  const welcome = def.welcome.enabled;

  const nodes = useMemo<MapNode[]>(() => {
    const out: MapNode[] = [];
    let y = PAD;
    if (welcome) {
      out.push({
        key: "welcome",
        n: -1,
        y,
        code: "Hi",
        title: "Welcome",
        full: `Welcome screen · ${def.title || "Untitled form"}`,
        icon: "home",
        kind: "welcome",
        target: null,
        lost: false,
      });
      y += PITCH;
    }
    steps.forEach((st, i) => {
      const first = def.blocks.find((b) => b.id === st.ids[0]);
      if (!first) return;
      const n = isQuestion(first) ? questionNumber(def, first.id) : 0;
      const kind = KINDS.find((k) => k.kind === first.kind);
      const names = st.ids
        .map((id) => def.blocks.find((b) => b.id === id))
        .filter((b) => b !== undefined)
        .map((b) => blockLabel(def, b, 60));
      const title = isQuestion(first) ? first.title : first.kind === "statement" ? first.title : "";
      const pair = st.ids.length > 1;
      out.push({
        key: st.ids.join("+"),
        n: i,
        y,
        code: isQuestion(first) ? (pair ? `Q${n}+` : `Q${n}`) : "Aa",
        title: clip(title, 22) || (isQuestion(first) ? "Untitled question" : "Statement"),
        full: names.join(" and "),
        icon: kind?.icon ?? "text",
        kind: "step",
        target: isQuestion(first) ? first.id : null,
        lost: lost.has(i),
      });
      y += PITCH;
    });
    y += END_GAP;
    def.endings.forEach((e, j) => {
      out.push({
        key: `end-${e.id}`,
        n: steps.length + j,
        y,
        code: `E${j + 1}`,
        title: clip(e.title, 22) || `Ending ${j + 1}`,
        full: `Ending ${j + 1} · ${e.title || "Untitled ending"}${e.redirect ? " (sends people to a link)" : ""}`,
        icon: e.redirect ? "link" : "flag",
        kind: "ending",
        target: null,
        lost: lost.has(steps.length + j),
      });
      y += PITCH;
    });
    return out;
  }, [def, steps, welcome, lost]);

  const byN = new Map(nodes.map((nd) => [nd.n, nd]));
  const curvesRight = edges.filter((e) => e.kind === "rule");
  const curvesLeft = edges.filter((e) => e.kind === "otherwise" && e.to !== e.from + 1);
  const laneR = lanes(curvesRight);
  const laneL = lanes(curvesLeft);
  const nR = curvesRight.length ? Math.max(...laneR.values()) + 1 : 0;
  const nL = curvesLeft.length ? Math.max(...laneL.values()) + 1 : 0;
  const x0 = PAD + nL * LANE + (nL ? 10 : 0);
  const x1 = x0 + NODE_W;
  const labelX = x1 + 18 + nR * LANE + 8;
  const width = nR ? labelX + LABEL_W : x1 + PAD;
  const last = nodes[nodes.length - 1];
  const height = (last?.y ?? 0) + NODE_H + PAD;
  const endingsTop = nodes.find((nd) => nd.kind === "ending")?.y ?? height;

  const mid = (nd: MapNode) => nd.y + NODE_H / 2;
  const isActive = (e: { from: number; to: number }) => active?.from === e.from && active.to === e.to;

  // Rule labels sit in one column on the right; nudge them apart so none overlap.
  const labels = curvesRight
    .map((e, i) => {
      const a = byN.get(e.from);
      const b = byN.get(e.to);
      return a && b ? { e, i, y: (mid(a) + mid(b)) / 2 } : null;
    })
    .filter((l) => l !== null)
    .sort((p, q) => p.y - q.y);
  for (let i = 1; i < labels.length; i++) {
    const prev = labels[i - 1];
    const cur = labels[i];
    if (prev && cur && cur.y - prev.y < 22) cur.y = prev.y + 22;
  }
  const labelY = new Map(labels.map((l) => [l.e, l.y]));
  const fullHeight = Math.max(height, ...labels.map((l) => l.y + 16));

  // Spread several curves leaving or entering one node so their ends do not stack.
  const spread = (list: FlowEdge[], end: "from" | "to") => {
    const groups = new Map<number, FlowEdge[]>();
    for (const e of list) groups.set(e[end], [...(groups.get(e[end]) ?? []), e]);
    const off = new Map<FlowEdge, number>();
    for (const g of groups.values()) g.forEach((e, k) => off.set(e, (k - (g.length - 1) / 2) * 7));
    return off;
  };
  const outR = spread(curvesRight, "from");
  const inR = spread(curvesRight, "to");
  const outL = spread(curvesLeft, "from");
  const inL = spread(curvesLeft, "to");

  const pick = (nd: MapNode) => {
    if (nd.target) onPick(nd.target);
  };
  const onKey = (e: KeyboardEvent<SVGGElement>, nd: MapNode) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(nd);
    }
  };

  const straight: { key: string; ax: number; ay: number; by: number; dashed: boolean; on: boolean }[] = [];
  if (welcome && byN.get(0)) {
    const w = byN.get(-1);
    const f = byN.get(0);
    if (w && f) straight.push({ key: "w", ax: x0 + NODE_W / 2, ay: w.y + NODE_H, by: f.y, dashed: false, on: false });
  }
  for (const e of edges) {
    if (e.kind === "rule" || (e.kind === "otherwise" && e.to !== e.from + 1)) continue;
    const a = byN.get(e.from);
    const b = byN.get(e.to);
    if (!a || !b) continue;
    straight.push({
      key: `s${e.from}`,
      ax: x0 + NODE_W / 2,
      ay: a.y + NODE_H,
      by: b.y,
      dashed: e.kind === "otherwise",
      on: isActive(e),
    });
  }

  const summary = nodes
    .filter((nd) => nd.kind !== "ending")
    .map((nd) => {
      if (nd.kind === "welcome") return { key: nd.key, text: `${nd.full}, then the first screen.` };
      const out = edges.filter((e) => e.from === nd.n);
      const describe = (e: FlowEdge) => {
        const to = byN.get(e.to)?.full ?? "the end";
        if (e.kind === "rule" && e.after !== undefined && e.rule !== undefined) {
          const r = def.logic.find((l) => l.after === e.after)?.rules[e.rule];
          return r ? `${ruleSentence(def, r)}.` : "";
        }
        if (e.kind === "otherwise") return `All other cases go to ${to}.`;
        return out.length > 1 ? `Otherwise on to ${to}.` : `Then on to ${to}.`;
      };
      return {
        key: nd.key,
        text: `${nd.full}${nd.lost ? " (nobody reaches this screen)" : ""}. ${out.map(describe).join(" ")}`,
      };
    });

  return (
    <figure className={s.map} aria-labelledby={`${uid}-cap`}>
      <figcaption id={`${uid}-cap`} className="sr-only">
        Flow map of the form. Pick a screen to see its rules.
      </figcaption>
      <div className={s.mapScroll}>
        <svg
          className={s.mapSvg}
          width={width}
          height={fullHeight}
          viewBox={`0 0 ${width} ${fullHeight}`}
          role="group"
          aria-labelledby={`${uid}-cap`}
          aria-describedby={`${uid}-sum`}
        >
          <defs>
            {["var(--ink)", "var(--ink-subtle)", ...RULE_COLOURS].map((c, i) => (
              <marker
                key={c}
                id={`${uid}-m${i}`}
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto-start-reverse"
              >
                <path d="M1 1 L9 5 L1 9 Z" fill={c} />
              </marker>
            ))}
          </defs>

          {nodes.some((nd) => nd.kind === "ending") ? (
            <g aria-hidden="true">
              <line
                x1={PAD}
                x2={x1}
                y1={endingsTop - END_GAP / 2 - 6}
                y2={endingsTop - END_GAP / 2 - 6}
                className={s.mapDivider}
              />
              <text x={x0} y={endingsTop - 8} className={s.mapSection}>
                Endings
              </text>
            </g>
          ) : null}

          <g aria-hidden="true">
            {straight.map((l) => (
              <line
                key={l.key}
                x1={l.ax}
                x2={l.ax}
                y1={l.ay + 2}
                y2={l.by - 3}
                className={[s.edge, l.dashed ? s.edgeDashed : "", l.on ? s.edgeOn : ""].join(" ")}
                stroke={l.dashed ? "var(--ink-subtle)" : "var(--ink)"}
                markerEnd={`url(#${uid}-m${l.dashed ? 1 : 0})`}
              />
            ))}

            {curvesLeft.map((e) => {
              const a = byN.get(e.from);
              const b = byN.get(e.to);
              if (!a || !b) return null;
              const lane = laneL.get(e) ?? 0;
              const apex = x0 - 14 - lane * LANE;
              const c = x0 - (x0 - apex) / 0.75;
              const ya = mid(a) + (outL.get(e) ?? 0);
              const yb = mid(b) + (inL.get(e) ?? 0);
              return (
                <path
                  key={`o${e.from}`}
                  d={`M ${x0} ${ya} C ${c} ${ya}, ${c} ${yb}, ${x0 - 2} ${yb}`}
                  className={[s.edge, s.edgeDashed, isActive(e) ? s.edgeOn : ""].join(" ")}
                  stroke="var(--ink-subtle)"
                  markerEnd={`url(#${uid}-m1)`}
                />
              );
            })}

            {curvesRight.map((e, i) => {
              const a = byN.get(e.from);
              const b = byN.get(e.to);
              if (!a || !b) return null;
              const colour = RULE_COLOURS[i % RULE_COLOURS.length] ?? "var(--cord)";
              const lane = laneR.get(e) ?? 0;
              const apex = x1 + 18 + lane * LANE;
              const c = x1 + (apex - x1) / 0.75;
              const ya = mid(a) + (outR.get(e) ?? 0);
              const yb = mid(b) + (inR.get(e) ?? 0);
              const ly = labelY.get(e) ?? (ya + yb) / 2;
              const apexY = (ya + yb) / 2;
              return (
                <g key={`r${e.from}-${e.after ?? ""}-${e.rule ?? 0}`} className={isActive(e) ? s.edgeOn : ""}>
                  <path
                    d={`M ${x1} ${ya} C ${c} ${ya}, ${c} ${yb}, ${x1 + 2} ${yb}`}
                    className={s.edge}
                    stroke={colour}
                    markerEnd={`url(#${uid}-m${(i % RULE_COLOURS.length) + 2})`}
                  />
                  <path d={`M ${apex} ${apexY} L ${labelX - 6} ${ly}`} className={s.leader} stroke={colour} />
                  <text x={labelX} y={ly + 4} className={s.edgeLabel} fill={colour}>
                    {e.label}
                  </text>
                </g>
              );
            })}
          </g>

          {nodes.map((nd) => {
            const tone =
              nd.kind === "welcome" ? s.nodeWelcome : nd.kind === "ending" ? s.nodeEnding : nd.lost ? s.nodeLost : "";
            const label = `${nd.full}${nd.lost ? ". Nobody reaches this screen" : ""}${nd.target ? ". Show its rules" : ""}`;
            const body = (
              <>
                <title>{label}</title>
                <rect x={x0} y={nd.y} width={NODE_W} height={NODE_H} rx={NODE_H / 2} className={s.nodeBox} />
                <circle cx={x0 + 23} cy={nd.y + NODE_H / 2} r={15} className={s.nodeBadge} />
                <text x={x0 + 23} y={nd.y + NODE_H / 2 + 4} textAnchor="middle" className={s.nodeCode}>
                  {nd.code}
                </text>
                <Icon name={nd.icon} size={15} x={x0 + 46} y={nd.y + NODE_H / 2 - 7.5} className={s.nodeIcon} />
                <text x={x0 + 67} y={nd.y + NODE_H / 2 + 4.5} className={s.nodeTitle}>
                  {nd.title}
                </text>
              </>
            );
            return nd.target ? (
              <g
                key={nd.key}
                role="button"
                tabIndex={0}
                aria-label={label}
                className={[s.node, s.nodeTap, tone].join(" ")}
                onClick={() => pick(nd)}
                onKeyDown={(e) => onKey(e, nd)}
              >
                {body}
              </g>
            ) : (
              <g key={nd.key} className={[s.node, tone].join(" ")} role="img" aria-label={label}>
                {body}
              </g>
            );
          })}
        </svg>
      </div>
      <ul className={s.legend} aria-hidden="true">
        <li>
          <svg width="26" height="10">
            <line x1="1" x2="25" y1="5" y2="5" stroke="var(--ink)" strokeWidth="2.5" />
          </svg>
          Next
        </li>
        <li>
          <svg width="26" height="10">
            <path d="M1 9 Q13 -3 25 9" fill="none" stroke="var(--cord)" strokeWidth="2.5" />
          </svg>
          Rule
        </li>
        <li>
          <svg width="26" height="10">
            <line x1="1" x2="25" y1="5" y2="5" stroke="var(--ink-subtle)" strokeWidth="2.5" strokeDasharray="5 4" />
          </svg>
          All other cases
        </li>
        {lost.size ? (
          <li>
            <svg width="26" height="10">
              <rect
                x="1"
                y="1"
                width="24"
                height="8"
                rx="4"
                fill="none"
                stroke="var(--ink-subtle)"
                strokeDasharray="3 3"
              />
            </svg>
            Nobody gets here
          </li>
        ) : null}
      </ul>
      <ol id={`${uid}-sum`} className="sr-only">
        {summary.map((x) => (
          <li key={x.key}>{x.text}</li>
        ))}
      </ol>
    </figure>
  );
}
