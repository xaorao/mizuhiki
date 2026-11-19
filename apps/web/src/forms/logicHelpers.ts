/**
 * Pure helpers for the Logic tab and its flow map (spec 5.9). They follow the
 * runner exactly: rules are checked in order and the first match wins, `to`
 * is a block id or an ending id, `otherwise` "" means the next screen, a
 * target the runner cannot land on falls through to the next screen, and the
 * last screen goes to the first ending. Screens come from `buildSteps`.
 */
import {
  conditionHolds,
  isQuestion,
  nextAfter,
  type AnswerValue,
  type CONDITION_OPS,
  type FormBlock,
  type FormDef,
  type Logic,
  type Question,
} from "@mizuhiki/core";

export type Op = (typeof CONDITION_OPS)[number];
export type Condition = Logic["rules"][number]["when"][number];
export type Rule = Logic["rules"][number];
/** One respondent screen, as `buildSteps` makes them. */
export interface FlowStep {
  ids: string[];
}

export const MAX_RULES = 20;
export const MAX_CONDITIONS = 10;

/** What the value box of a condition looks like for a question. */
export type ValueKind = "choice" | "yesno" | "number" | "date" | "text" | "none";

/** Kinds whose answers live outside `answers` (sealed files), so a rule could never see them. */
const UNCHECKABLE = new Set<Question["kind"]>(["file", "signature"]);

export function valueKindOf(q: Question): ValueKind {
  switch (q.kind) {
    case "choice":
    case "checkboxes":
    case "dropdown":
      return "choice";
    case "yesno":
      return "yesno";
    case "rating":
    case "scale":
    case "number":
      return "number";
    case "date":
      return "date";
    case "file":
    case "signature":
      return "none";
    default:
      return "text";
  }
}

/** The operators that make sense for a question, in the order they are offered. */
export function opsFor(q: Question): Op[] {
  switch (valueKindOf(q)) {
    case "choice":
    case "yesno":
    case "date":
      return ["is", "is_not", "answered", "not_answered"];
    case "number":
      return ["is", "is_not", "lt", "gt", "answered", "not_answered"];
    case "text":
      return ["is", "is_not", "contains", "answered", "not_answered"];
    case "none":
      return [];
  }
}

/** Plain words for an operator; checkboxes read "includes" because several can be picked. */
export function opLabel(op: Op, q?: Question): string {
  const multi = q?.kind === "checkboxes";
  switch (op) {
    case "is":
      return multi ? "includes" : "is";
    case "is_not":
      return multi ? "does not include" : "is not";
    case "contains":
      return "contains";
    case "lt":
      return "is less than";
    case "gt":
      return "is greater than";
    case "answered":
      return "is answered";
    case "not_answered":
      return "is not answered";
  }
}

export const opNeedsValue = (op: Op): boolean => op !== "answered" && op !== "not_answered";

/** The values a choice-like question can hold, with their labels (ids are what the runner stores). */
export function valueOptions(q: Question): { value: string; label: string }[] {
  if (q.kind === "yesno")
    return [
      { value: "yes", label: "Yes" },
      { value: "no", label: "No" },
    ];
  if (!("choices" in q)) return [];
  const out = q.choices.map((c, i) => ({ value: c.id, label: c.label.trim() || `Choice ${i + 1}` }));
  if ((q.kind === "choice" || q.kind === "checkboxes") && q.other) out.push({ value: "other", label: "Other" });
  if (q.kind === "checkboxes" && q.none) out.push({ value: "none", label: "None of the above" });
  return out;
}

/** The value a fresh condition starts with. */
export function defaultValue(q: Question, op: Op): string {
  if (!opNeedsValue(op)) return "";
  const opts = valueOptions(q);
  if (opts.length) return opts[0]?.value ?? "";
  if (valueKindOf(q) === "number") {
    if (q.kind === "rating") return String(Math.ceil(q.max / 2));
    if (q.kind === "scale") return String(Math.round((q.from + q.to) / 2));
  }
  return "";
}

/** A fresh condition on a question (its first sensible operator and value). */
export function freshCondition(q: Question): Condition {
  const op = opsFor(q)[0] ?? "answered";
  return { q: q.id, op, value: defaultValue(q, op) };
}

/** Keep a condition valid after its question or operator changed. */
export function fitCondition(q: Question, c: Condition): Condition {
  const ops = opsFor(q);
  const op = ops.includes(c.op) ? c.op : (ops[0] ?? "answered");
  if (!opNeedsValue(op)) return { q: q.id, op, value: "" };
  const opts = valueOptions(q);
  if (opts.length && !opts.some((o) => o.value === c.value)) return { q: q.id, op, value: defaultValue(q, op) };
  if (valueKindOf(q) === "number" && c.value !== "" && Number.isNaN(Number(c.value)))
    return { q: q.id, op, value: defaultValue(q, op) };
  return { q: q.id, op, value: c.value };
}

// ---- numbering and labels -----------------------------------------------------------

/** Questions respondents see, in order (hidden ones are skipped by the runner). */
export const visibleQuestions = (def: Pick<FormDef, "blocks">): Question[] =>
  def.blocks.filter((b): b is Question => isQuestion(b) && !b.hidden);

/** The respondent's question number (matches the runner), or 0 when not shown to them. */
export function questionNumber(def: Pick<FormDef, "blocks">, id: string): number {
  return visibleQuestions(def).findIndex((q) => q.id === id) + 1;
}

const clip = (t: string, n: number): string => {
  const one = t
    .replace(/\{\{[A-Za-z0-9_-]{1,40}\}\}/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};

/** A block's name as people read it: "Q5 · Your budget", "Statement · Next, a few…". */
export function blockLabel(def: Pick<FormDef, "blocks">, b: FormBlock, max = 48): string {
  if (isQuestion(b)) {
    const n = questionNumber(def, b.id);
    const prefix = n > 0 ? `Q${n}` : "Hidden question";
    return `${prefix} · ${clip(b.title, max) || "Untitled question"}`;
  }
  if (b.kind === "statement") return `Statement · ${clip(b.title, max) || "Untitled statement"}`;
  if (b.kind === "heading") return `Heading · ${clip(b.title, max) || "Untitled heading"}`;
  return "New section";
}

export function endingLabel(def: Pick<FormDef, "endings">, id: string, max = 48): string {
  const i = def.endings.findIndex((e) => e.id === id);
  const e = def.endings[i];
  if (!e) return "A step that was deleted";
  const title = clip(e.title, max) || `Ending ${i + 1}`;
  return `Ending · ${title}`;
}

/** Label for any target id: a block, an ending, or "deleted". */
export function targetLabel(def: Pick<FormDef, "blocks" | "endings">, id: string, max = 48): string {
  const b = def.blocks.find((x) => x.id === id);
  if (b) return blockLabel(def, b, max);
  return endingLabel(def, id, max);
}

/** A short code for a target, for the flow map ("Q5", "End 2", "Statement"). */
export function targetShort(def: Pick<FormDef, "blocks" | "endings">, id: string): string {
  const b = def.blocks.find((x) => x.id === id);
  if (b) {
    if (isQuestion(b)) {
      const n = questionNumber(def, b.id);
      return n > 0 ? `Q${n}` : "Hidden";
    }
    return b.kind === "statement" ? "Statement" : "Section";
  }
  const i = def.endings.findIndex((e) => e.id === id);
  return i >= 0 ? `Ending ${i + 1}` : "Deleted";
}

// ---- screens --------------------------------------------------------------------------

export const stepIndexOf = (steps: FlowStep[], id: string): number => steps.findIndex((s) => s.ids.includes(id));

/** Questions a condition after `afterId` may check: this one and earlier ones respondents answer. */
export function conditionSources(def: Pick<FormDef, "blocks">, afterId: string): Question[] {
  const idx = def.blocks.findIndex((b) => b.id === afterId);
  if (idx < 0) return [];
  return def.blocks
    .slice(0, idx + 1)
    .filter((b): b is Question => isQuestion(b) && !b.hidden && !UNCHECKABLE.has(b.kind));
}

/**
 * Where a rule after `afterId` may send people: blocks on later screens (never
 * back, never the same screen, so a form cannot loop) and every ending.
 */
export function targetsAfter(
  def: Pick<FormDef, "blocks" | "endings">,
  steps: FlowStep[],
  afterId: string,
): { blocks: FormBlock[]; endings: FormDef["endings"] } {
  const at = stepIndexOf(steps, afterId);
  const blocks = at < 0 ? [] : steps.slice(at + 1).flatMap((s) => s.ids);
  return {
    blocks: blocks.map((id) => def.blocks.find((b) => b.id === id)).filter((b): b is FormBlock => b !== undefined),
    endings: def.endings,
  };
}

/** True when `to` is somewhere a rule after `afterId` may go. */
export function isForwardTarget(
  def: Pick<FormDef, "blocks" | "endings">,
  steps: FlowStep[],
  afterId: string,
  to: string,
): boolean {
  if (def.endings.some((e) => e.id === to)) return true;
  const from = stepIndexOf(steps, afterId);
  const t = stepIndexOf(steps, to);
  return from >= 0 && t > from;
}

// ---- editing ----------------------------------------------------------------------------

/** Drop entries with nothing in them (no rules and no "all other cases"). */
export const normaliseLogic = (logic: Logic[]): Logic[] =>
  logic.filter((l) => l.rules.length > 0 || l.otherwise !== "");

/** Change the logic after one block; a removed or empty entry disappears. */
export function withLogicFor(def: FormDef, after: string, fn: (l: Logic) => Logic | null): FormDef {
  const cur = def.logic.find((l) => l.after === after) ?? { after, rules: [], otherwise: "" };
  const next = fn(cur);
  const exists = def.logic.some((l) => l.after === after);
  const logic = exists
    ? def.logic.flatMap((l) => (l.after === after ? (next ? [next] : []) : [l]))
    : next
      ? [...def.logic, next]
      : def.logic;
  return { ...def, logic: normaliseLogic(logic) };
}

/** A new rule after a question: "When <this question> is <first answer> go to <first later step>". */
export function freshRule(def: Pick<FormDef, "blocks" | "endings">, steps: FlowStep[], q: Question): Rule | null {
  const src = conditionSources(def, q.id);
  const on = src.find((x) => x.id === q.id) ?? src[src.length - 1];
  if (!on) return null;
  const t = targetsAfter(def, steps, q.id);
  const to = t.blocks[0]?.id ?? t.endings[0]?.id;
  if (!to) return null;
  return { when: [freshCondition(on)], to };
}

// ---- problems -----------------------------------------------------------------------------

export type LogicProblem =
  | { kind: "after"; after: string; text: string }
  | { kind: "rule"; after: string; rule: number; text: string }
  | { kind: "condition"; after: string; rule: number; cond: number; text: string }
  | { kind: "otherwise"; after: string; text: string };

/**
 * Everything in the logic that cannot work as written, each with a precise
 * fix. Covers the logic lines of `formProblems` (deleted questions and steps)
 * and also steps that go backwards, rules after hidden questions, and
 * conditions on deleted questions or deleted choices.
 */
export function logicProblems(def: FormDef, steps: FlowStep[]): LogicProblem[] {
  const out: LogicProblem[] = [];
  const blocks = new Map(def.blocks.map((b) => [b.id, b]));
  const ends = new Set(def.endings.map((e) => e.id));
  for (const l of def.logic) {
    const b = blocks.get(l.after);
    if (!b) {
      out.push({ kind: "after", after: l.after, text: "Rules after a question that was deleted." });
      continue;
    }
    const name = blockLabel(def, b, 32);
    if (isQuestion(b) && b.hidden) {
      out.push({ kind: "after", after: l.after, text: `${name} is hidden, so its rules never run.` });
      continue;
    }
    l.rules.forEach((r, ri) => {
      const label = `${name}, rule ${ri + 1}`;
      if (!blocks.has(r.to) && !ends.has(r.to))
        out.push({ kind: "rule", after: l.after, rule: ri, text: `${label} goes to a step that was deleted.` });
      else if (!isForwardTarget(def, steps, l.after, r.to))
        out.push({
          kind: "rule",
          after: l.after,
          rule: ri,
          text: `${label} goes back to ${targetLabel(def, r.to, 24)}, which could make people go round in circles.`,
        });
      r.when.forEach((c, ci) => {
        const q = blocks.get(c.q);
        if (!q || !isQuestion(q))
          out.push({
            kind: "condition",
            after: l.after,
            rule: ri,
            cond: ci,
            text: `${label} checks a question that was deleted.`,
          });
        else if (q.hidden || UNCHECKABLE.has(q.kind) || !opsFor(q).includes(c.op))
          out.push({
            kind: "condition",
            after: l.after,
            rule: ri,
            cond: ci,
            text: `${label} checks ${blockLabel(def, q, 24)} in a way that can never match.`,
          });
        else if (opNeedsValue(c.op) && valueOptions(q).length && !valueOptions(q).some((o) => o.value === c.value))
          out.push({
            kind: "condition",
            after: l.after,
            rule: ri,
            cond: ci,
            text: `${label} checks an answer that was removed.`,
          });
      });
    });
    if (l.otherwise) {
      if (!blocks.has(l.otherwise) && !ends.has(l.otherwise))
        out.push({
          kind: "otherwise",
          after: l.after,
          text: `${name}: “all other cases” goes to a step that was deleted.`,
        });
      else if (!isForwardTarget(def, steps, l.after, l.otherwise))
        out.push({
          kind: "otherwise",
          after: l.after,
          text: `${name}: “all other cases” goes back to an earlier step, which could make people go round in circles.`,
        });
    }
  }
  return out;
}

/** Apply the one-click fix for a problem. */
export function fixProblem(def: FormDef, p: LogicProblem): FormDef {
  switch (p.kind) {
    case "after":
      return { ...def, logic: normaliseLogic(def.logic.filter((l) => l.after !== p.after)) };
    case "rule":
      return withLogicFor(def, p.after, (l) => ({ ...l, rules: l.rules.filter((_, i) => i !== p.rule) }));
    case "condition":
      return withLogicFor(def, p.after, (l) => ({
        ...l,
        rules: l.rules.flatMap((r, i) => {
          if (i !== p.rule) return [r];
          const when = r.when.filter((_, ci) => ci !== p.cond);
          return when.length ? [{ ...r, when }] : [];
        }),
      }));
    case "otherwise":
      return withLogicFor(def, p.after, (l) => ({ ...l, otherwise: "" }));
  }
}

// ---- sentences --------------------------------------------------------------------------

function valueText(q: Question | undefined, c: Condition): string {
  if (!opNeedsValue(c.op)) return "";
  if (q) {
    const o = valueOptions(q).find((x) => x.value === c.value);
    if (o) return o.label;
    if (valueOptions(q).length) return "a removed answer";
  }
  return c.value === "" ? "nothing" : `“${clip(c.value, 24)}”`;
}

/** "Q2 is Yes", "Q4 is less than 3", "Q1 is answered". */
export function conditionSentence(def: Pick<FormDef, "blocks">, c: Condition): string {
  const q = def.blocks.find((b): b is Question => b.id === c.q && isQuestion(b));
  const n = q ? questionNumber(def, q.id) : 0;
  const who = q ? (n > 0 ? `Q${n}` : "a hidden question") : "a deleted question";
  const v = valueText(q, c);
  return `${who} ${opLabel(c.op, q)}${v ? ` ${v}` : ""}`;
}

/** "When Q2 is Yes and Q3 is answered go to Q5 · Budget". */
export function ruleSentence(def: Pick<FormDef, "blocks" | "endings">, r: Rule): string {
  return `When ${r.when.map((c) => conditionSentence(def, c)).join(" and ")} go to ${targetLabel(def, r.to, 32)}`;
}

/** The short label on a flow-map curve: "Q2 = Yes", "Q4 < 3", "2 conditions". */
export function ruleShort(def: Pick<FormDef, "blocks">, r: Rule): string {
  if (r.when.length > 1) return `${r.when.length} conditions`;
  const c = r.when[0];
  if (!c) return "rule";
  const q = def.blocks.find((b): b is Question => b.id === c.q && isQuestion(b));
  const n = q ? questionNumber(def, q.id) : 0;
  const who = n > 0 ? `Q${n}` : "?";
  const sym: Record<Op, string> = {
    is: q?.kind === "checkboxes" ? "has" : "=",
    is_not: q?.kind === "checkboxes" ? "lacks" : "≠",
    contains: "has",
    lt: "<",
    gt: ">",
    answered: "answered",
    not_answered: "skipped",
  };
  const v = valueText(q, c);
  return clip(`${who} ${sym[c.op]}${v ? ` ${v}` : ""}`, 22);
}

// ---- the respondent's path ------------------------------------------------------------------

export type Destination = { kind: "step"; index: number; id: string } | { kind: "ending"; id: string };

export interface NextExplained {
  to: Destination;
  /** The question whose logic decided, and which rule matched (-1: none matched). */
  decidedBy: string | null;
  rule: number;
  /** How it was decided, in plain words. */
  why: "rule" | "otherwise" | "next";
}

/** Exactly what the runner does on Continue from screen `at` (see FormRunner `target`). */
export function explainNext(
  def: Pick<FormDef, "blocks" | "endings" | "logic">,
  steps: FlowStep[],
  at: number,
  answers: Record<string, AnswerValue>,
): NextExplained {
  const step = steps[at];
  const firstEnding = def.endings[0]?.id ?? "";
  const fallThrough: Destination =
    at + 1 < steps.length
      ? { kind: "step", index: at + 1, id: steps[at + 1]?.ids[0] ?? "" }
      : { kind: "ending", id: firstEnding };
  if (step)
    for (const id of step.ids) {
      const t = nextAfter(def, id, answers);
      if (!t) continue;
      const l = def.logic.find((x) => x.after === id);
      const rule = l ? l.rules.findIndex((r) => r.when.every((c) => conditionHolds(def, c, answers))) : -1;
      const why = rule >= 0 ? "rule" : "otherwise";
      if (def.endings.some((e) => e.id === t)) return { to: { kind: "ending", id: t }, decidedBy: id, rule, why };
      const idx = stepIndexOf(steps, t);
      if (idx >= 0) return { to: { kind: "step", index: idx, id: t }, decidedBy: id, rule, why };
    }
  return { to: fallThrough, decidedBy: null, rule: -1, why: "next" };
}

export interface FlowEdge {
  from: number;
  /** A screen index, or `steps.length + i` for ending i. */
  to: number;
  kind: "next" | "rule" | "otherwise";
  /** Owning question and rule index for "rule" edges. */
  after?: string;
  rule?: number;
  label: string;
}

/** Every path a respondent can take between screens and endings (what the flow map draws). */
export function flowEdges(def: FormDef, steps: FlowStep[]): FlowEdge[] {
  const out: FlowEdge[] = [];
  const node = (id: string): number => {
    const e = def.endings.findIndex((x) => x.id === id);
    if (e >= 0) return steps.length + e;
    return stepIndexOf(steps, id);
  };
  steps.forEach((s, i) => {
    let fallback: FlowEdge | null = null;
    for (const id of s.ids) {
      const l = def.logic.find((x) => x.after === id);
      if (!l) continue;
      l.rules.forEach((r, ri) => {
        const to = node(r.to);
        if (to > i) out.push({ from: i, to, kind: "rule", after: id, rule: ri, label: ruleShort(def, r) });
      });
      if (!fallback && l.otherwise) {
        const to = node(l.otherwise);
        if (to > i) fallback = { from: i, to, kind: "otherwise", after: id, label: "All other cases" };
      }
    }
    out.push(fallback ?? { from: i, to: i + 1 < steps.length ? i + 1 : steps.length, kind: "next", label: "Next" });
  });
  return out;
}

/** Screens and endings nobody can reach (welcome leads to screen 0). */
export function unreachable(def: FormDef, steps: FlowStep[]): Set<number> {
  const edges = flowEdges(def, steps);
  const total = steps.length + def.endings.length;
  const seen = new Set<number>();
  const queue = total > 0 ? [0] : [];
  while (queue.length) {
    const n = queue.shift() as number;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of edges) if (e.from === n && !seen.has(e.to)) queue.push(e.to);
  }
  const out = new Set<number>();
  for (let i = 0; i < total; i++) if (!seen.has(i)) out.add(i);
  return out;
}
