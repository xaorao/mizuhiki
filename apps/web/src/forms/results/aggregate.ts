/**
 * Results worked out in the owner's browser (spec 5.9), from answers opened on
 * this device. Pure functions: no network, no storage. Labels, never ids, are
 * what people see and what the exports carry.
 */
import {
  isAnswered,
  isQuestion,
  type AnswerValue,
  type FormAnswerPayload,
  type FormDef,
  type Question,
} from "@mizuhiki/core";
import type { Bar, QuestionSummary } from "./schema";
import { toDisplay } from "../mentions";

/** One answer, opened here. `at` is when the server stored it (not the respondent's clock). */
export interface OpenedResponse {
  hash: string;
  at: string;
  readers: number;
  payload: FormAnswerPayload;
}

/** The content-blind counters `GET /owner/forms/:id/stats` returns. */
export interface FormStats {
  views: number;
  starts: number;
  submissions: number;
  secondsTotal: number;
  reach: Record<string, number>;
  responses: { hash: string; at: string; readers: number }[];
}

export interface FileFactsLite {
  name: string;
  type: string;
  size: number;
}

export const OTHER = "other";
export const NONE = "none";
export const NONE_LABEL = "None of the above";
export const REMOVED_CHOICE = "A choice no longer in the form";

/** The questions results are read against: the published form, or the draft if never published. */
export function resultQuestions(def: FormDef, published: FormDef | null): Question[] {
  const blocks = (published ?? def).blocks;
  // Mentions are stored as {{questionId}}; results show them the way the owner wrote them (@Q1).
  return blocks.filter(isQuestion).map((q) => ({ ...q, title: toDisplay(q.title, blocks) }));
}

/** Answer keys present in responses that match no current question (asked by an earlier version). */
export function earlierKeys(questions: Question[], responses: OpenedResponse[]): string[] {
  const known = new Set(questions.map((q) => q.id));
  const out = new Set<string>();
  for (const r of responses) {
    for (const k of Object.keys(r.payload.answers)) if (!k.includes(":") && !known.has(k)) out.add(k);
    for (const k of Object.keys(r.payload.files)) if (!known.has(k)) out.add(k);
  }
  return [...out].sort();
}

/** Every hidden field (URL parameter) any response carried, sorted. */
export function hiddenKeys(responses: OpenedResponse[]): string[] {
  const out = new Set<string>();
  for (const r of responses) for (const k of Object.keys(r.payload.hidden)) out.add(k);
  return [...out].sort();
}

const filesOf = (p: FormAnswerPayload, qid: string): FileFactsLite[] =>
  (p.files[qid] ?? []).filter(
    (f): f is FileFactsLite => typeof f === "object" && f !== null && typeof (f as FileFactsLite).name === "string",
  );

/** Whether this response answered the question (files count for file and signature questions). */
export function answered(q: Question, p: FormAnswerPayload): boolean {
  if (q.kind === "file" || q.kind === "signature") return filesOf(p, q.id).length > 0;
  return isAnswered(p.answers[q.id]);
}

/** The options a question can be filtered and charted by, in order. Null for free-text kinds. */
export function optionsOf(q: Question): { key: string; label: string }[] | null {
  switch (q.kind) {
    case "choice":
      return [
        ...q.choices.map((c) => ({ key: c.id, label: c.label })),
        ...(q.other ? [{ key: OTHER, label: "Other" }] : []),
      ];
    case "checkboxes":
      return [
        ...q.choices.map((c) => ({ key: c.id, label: c.label })),
        ...(q.other ? [{ key: OTHER, label: "Other" }] : []),
        ...(q.none ? [{ key: NONE, label: NONE_LABEL }] : []),
      ];
    case "dropdown":
      return q.choices.map((c) => ({ key: c.id, label: c.label }));
    case "yesno":
      return [
        { key: "yes", label: "Yes" },
        { key: "no", label: "No" },
      ];
    case "rating":
      return Array.from({ length: q.max }, (_, i) => ({ key: String(i + 1), label: String(i + 1) }));
    case "scale":
      return Array.from({ length: q.to - q.from + 1 }, (_, i) => {
        const n = q.from + i;
        const end = n === q.from ? q.left : n === q.to ? q.right : "";
        return { key: String(n), label: end ? `${n} · ${end}` : String(n) };
      });
    default:
      return null;
  }
}

/** The option keys one response picked for a question (empty when unanswered or free text). */
export function pickedKeys(q: Question, p: FormAnswerPayload): string[] {
  const v: AnswerValue | undefined = p.answers[q.id];
  if (!isAnswered(v) || v === undefined || v === null) return [];
  switch (q.kind) {
    case "choice":
    case "dropdown":
      return typeof v === "string" ? [v] : [];
    case "checkboxes":
      return Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    case "yesno":
      return typeof v === "boolean" ? [v ? "yes" : "no"] : [];
    case "rating":
    case "scale":
      return typeof v === "number" || typeof v === "string" ? [String(v)] : [];
    default:
      return [];
  }
}

function choiceLabel(q: Question, key: string, p: FormAnswerPayload): string {
  if (key === OTHER) {
    const t = p.answers[`${q.id}:${OTHER}`];
    return typeof t === "string" && t ? `Other: ${t}` : "Other";
  }
  if (key === NONE && q.kind === "checkboxes") return NONE_LABEL;
  if ("choices" in q) return q.choices.find((c) => c.id === key)?.label ?? REMOVED_CHOICE;
  return key;
}

/** One answer as plain text, labels not ids. Files are their names. */
export function answerText(q: Question, p: FormAnswerPayload): string {
  if (q.kind === "file" || q.kind === "signature")
    return filesOf(p, q.id)
      .map((f) => f.name)
      .join("; ");
  const v = p.answers[q.id];
  if (!isAnswered(v) || v === undefined || v === null) return "";
  switch (q.kind) {
    case "choice":
    case "dropdown":
    case "checkboxes":
      return pickedKeys(q, p)
        .map((k) => choiceLabel(q, k, p))
        .join("; ");
    case "yesno":
      return v === true ? "Yes" : v === false ? "No" : String(v);
    default:
      return Array.isArray(v) ? v.join("; ") : String(v);
  }
}

/** An answer for a spreadsheet cell: numbers stay numbers so they sum and sort. */
export function answerCell(q: Question, p: FormAnswerPayload): string | number {
  const v = p.answers[q.id];
  if ((q.kind === "number" || q.kind === "rating" || q.kind === "scale") && typeof v === "number" && Number.isFinite(v))
    return v;
  return answerText(q, p);
}

/** Answers left by an earlier version of the form, as text. */
export function rawText(p: FormAnswerPayload, key: string): string {
  const files = filesOf(p, key);
  if (files.length) return files.map((f) => f.name).join("; ");
  const v = p.answers[key];
  if (!isAnswered(v) || v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return Array.isArray(v) ? v.join("; ") : String(v);
}

const newestFirst = (a: OpenedResponse, b: OpenedResponse) => Date.parse(b.at) - Date.parse(a.at);

/** Per-question summary: bars for choices and scales, min/avg/max for numbers, latest answers for text. */
export function summarize(questions: Question[], responses: OpenedResponse[]): QuestionSummary[] {
  const total = responses.length;
  const sorted = [...responses].sort(newestFirst);
  return questions.map((q): QuestionSummary => {
    const got = sorted.filter((r) => answered(q, r.payload));
    const base = { id: q.id, title: q.title, kind: q.kind, answered: got.length, total };
    const options = optionsOf(q);
    if (options) {
      const counts = new Map<string, number>(options.map((o) => [o.key, 0]));
      let removed = 0;
      const others: string[] = [];
      let sum = 0;
      let n = 0;
      for (const r of got) {
        for (const k of new Set(pickedKeys(q, r.payload))) {
          if (counts.has(k)) counts.set(k, (counts.get(k) ?? 0) + 1);
          else removed++;
          if ((q.kind === "rating" || q.kind === "scale") && Number.isFinite(Number(k))) {
            sum += Number(k);
            n++;
          }
        }
        const t = r.payload.answers[`${q.id}:${OTHER}`];
        if (typeof t === "string" && t.trim()) others.push(t.trim());
      }
      const bars: Bar[] = options.map((o) => ({ label: o.label, count: counts.get(o.key) ?? 0 }));
      if (removed > 0) bars.push({ label: REMOVED_CHOICE, count: removed });
      const scaled = q.kind === "rating" || q.kind === "scale";
      return {
        ...base,
        type: "bars",
        multi: q.kind === "checkboxes",
        bars,
        others,
        average: scaled && n > 0 ? sum / n : null,
        scaleMax: q.kind === "rating" ? q.max : q.kind === "scale" ? q.to : null,
      };
    }
    if (q.kind === "number") {
      const nums = got.map((r) => Number(r.payload.answers[q.id])).filter((x) => Number.isFinite(x));
      return {
        ...base,
        type: "numbers",
        min: nums.length ? Math.min(...nums) : null,
        avg: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
        max: nums.length ? Math.max(...nums) : null,
      };
    }
    if (q.kind === "file" || q.kind === "signature") {
      return { ...base, type: "files", files: got.reduce((n2, r) => n2 + filesOf(r.payload, q.id).length, 0) };
    }
    return {
      ...base,
      type: "texts",
      latest: got.map((r) => ({ text: answerText(q, r.payload), at: r.at })),
    };
  });
}

export interface FunnelRow {
  id: string;
  title: string;
  reached: number;
  /** People lost since the step before (starts, for the first question). */
  drop: number;
  /** `drop` as a share of the step before, 0..1. */
  dropShare: number;
}

/** Typeform's "Question by question": how many reached each question, and the drop-off. */
export function funnel(questions: Question[], stats: Pick<FormStats, "starts" | "reach">): FunnelRow[] {
  let prev = stats.starts;
  return questions
    .filter((q) => !q.hidden)
    .map((q) => {
      const reached = stats.reach[q.id] ?? 0;
      const drop = Math.max(0, prev - reached);
      const row = { id: q.id, title: q.title, reached, drop, dropShare: prev > 0 ? drop / prev : 0 };
      prev = reached;
      return row;
    });
}

/** Completion rate, 0..1, or null before anyone started. */
export const completionRate = (s: Pick<FormStats, "starts" | "submissions">): number | null =>
  s.starts > 0 ? Math.min(1, s.submissions / s.starts) : null;

/** Seconds as mm:ss (h:mm:ss past an hour). */
export function clock(seconds: number): string {
  const t = Math.max(0, Math.round(seconds));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** Average time to complete in seconds, or null with no submissions. */
export const averageSeconds = (s: Pick<FormStats, "submissions" | "secondsTotal">): number | null =>
  s.submissions > 0 ? s.secondsTotal / s.submissions : null;

/** A UTC timestamp for files: "2026-11-19 14:03:05". */
export function utcStamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 19).replace("T", " ");
}

/** A local date and time for the screen: "19 Nov 2026, 14:03". */
export function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A short relative time for lists: "just now", "5 min ago", "3 h ago", "2 days ago", then the date. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) {
    const d = Math.floor(s / 86400);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export interface Column {
  key: string;
  label: string;
}

export interface TableModel {
  columns: Column[];
  rows: { hash: string; cells: (string | number)[] }[];
}

/**
 * The responses table: submitted time, one column per question (plus earlier
 * questions still present in old answers), the ending reached, hidden fields
 * and tags. Newest first. `forFile` uses UTC timestamps for exports.
 */
export function buildTable(args: {
  questions: Question[];
  responses: OpenedResponse[];
  endings: FormDef["endings"];
  tags: Record<string, string[]>;
  forFile: boolean;
}): TableModel {
  const { questions, responses, endings, tags, forFile } = args;
  const earlier = earlierKeys(questions, responses);
  const hidden = hiddenKeys(responses);
  const titled = (q: Question, i: number) => q.title.trim() || `Question ${i + 1}`;
  const columns: Column[] = [
    { key: "@submitted", label: forFile ? "Submitted (UTC)" : "Submitted" },
    ...questions.map((q, i) => ({ key: q.id, label: titled(q, i) })),
    ...earlier.map((k) => ({ key: `@earlier:${k}`, label: `Earlier question (${k})` })),
    { key: "@ending", label: "Ending reached" },
    ...hidden.map((k) => ({ key: `@hidden:${k}`, label: `Hidden field: ${k}` })),
    { key: "@tags", label: "Tags" },
  ];
  const rows = [...responses].sort(newestFirst).map((r) => {
    const p = r.payload;
    const ending = endings.find((e) => e.id === p.ending);
    return {
      hash: r.hash,
      cells: [
        forFile ? utcStamp(r.at) : localStamp(r.at),
        ...questions.map((q) => (forFile ? answerCell(q, p) : answerText(q, p))),
        ...earlier.map((k) => rawText(p, k)),
        ending ? ending.title || "Untitled ending" : p.ending ? "An ending no longer in the form" : "",
        ...hidden.map((k) => p.hidden[k] ?? ""),
        (tags[r.hash] ?? []).join("; "),
      ],
    };
  });
  return { columns, rows };
}

export interface Filter {
  qid: string;
  /** "is any of": the response matches when it picked at least one of these. */
  keys: string[];
}

/** Local search and "[question] is any of [answers]" filters; every filter must hold. */
export function matches(args: {
  response: OpenedResponse;
  questions: Question[];
  filters: Filter[];
  search: string;
  haystack: string;
}): boolean {
  for (const f of args.filters) {
    if (f.keys.length === 0) continue;
    const q = args.questions.find((x) => x.id === f.qid);
    if (!q) continue;
    const picked = pickedKeys(q, args.response.payload);
    if (!picked.some((k) => f.keys.includes(k))) return false;
  }
  const needle = args.search.trim().toLowerCase();
  return !needle || args.haystack.toLowerCase().includes(needle);
}

/** Percentage text: "42%", "4.5%" under ten, "0%" when nothing. */
export function pct(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const v = (part / whole) * 100;
  return v < 10 && v % 1 !== 0 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
}

/** "3 of 5 people answered this question". */
export function answeredLine(s: Pick<QuestionSummary, "answered" | "total">): string {
  return `${s.answered} of ${s.total} ${s.total === 1 ? "person" : "people"} answered this question`;
}
