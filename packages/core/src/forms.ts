/**
 * Forms (spec 5.9). A form definition holds only the questions, layout,
 * logic and settings; it is public, signed by the owner (kind "form") and
 * checked by respondents against the owner's key on chain. Answers never
 * appear here: they are sealed on the respondent's device under
 * `mzk:form:<id>` to the owner and any readers named below.
 */
import { z } from "zod";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const text = (max: number) => z.string().max(max);
const addr = z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/);
const httpsUrl = z.url({ protocol: /^https$/ });

export const QUESTION_KINDS = [
  "short",
  "long",
  "choice",
  "checkboxes",
  "dropdown",
  "yesno",
  "rating",
  "scale",
  "number",
  "email",
  "phone",
  "link",
  "date",
  "file",
  "signature",
  "wallet",
] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const ChoiceSchema = z.object({ id, label: text(200) });

const common = {
  id,
  /** Title may hold mentions of earlier answers as `{{questionId}}`. */
  title: text(500),
  description: text(1000).default(""),
  required: z.boolean().default(true),
  hidden: z.boolean().default(false),
  /** Sits beside the next half-width field on wide screens (two-column row). */
  half: z.boolean().default(false),
};

export const QuestionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...common,
    kind: z.literal("short"),
    placeholder: text(120).default(""),
    minChars: z.number().int().min(0).max(5000).optional(),
    maxChars: z.number().int().min(1).max(5000).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("long"),
    placeholder: text(120).default(""),
    minChars: z.number().int().min(0).max(20000).optional(),
    maxChars: z.number().int().min(1).max(20000).optional(),
  }),
  z.object({
    ...common,
    kind: z.literal("choice"),
    choices: z.array(ChoiceSchema).min(1).max(50),
    other: z.boolean().default(false),
    randomize: z.boolean().default(false),
  }),
  z.object({
    ...common,
    kind: z.literal("checkboxes"),
    choices: z.array(ChoiceSchema).min(1).max(50),
    other: z.boolean().default(false),
    none: z.boolean().default(false),
    randomize: z.boolean().default(false),
    minPick: z.number().int().min(0).max(50).optional(),
    maxPick: z.number().int().min(1).max(50).optional(),
  }),
  z.object({ ...common, kind: z.literal("dropdown"), choices: z.array(ChoiceSchema).min(1).max(200) }),
  z.object({ ...common, kind: z.literal("yesno") }),
  z.object({
    ...common,
    kind: z.literal("rating"),
    max: z.number().int().min(3).max(10).default(5),
    icon: z.enum(["star", "heart"]).default("star"),
  }),
  z.object({
    ...common,
    kind: z.literal("scale"),
    from: z.number().int().min(0).max(1).default(0),
    to: z.number().int().min(2).max(10).default(5),
    left: text(40).default(""),
    center: text(40).default(""),
    right: text(40).default(""),
  }),
  z.object({ ...common, kind: z.literal("number"), min: z.number().optional(), max: z.number().optional() }),
  z.object({ ...common, kind: z.literal("email") }),
  z.object({ ...common, kind: z.literal("phone") }),
  z.object({ ...common, kind: z.literal("link") }),
  z.object({ ...common, kind: z.literal("date") }),
  z.object({
    ...common,
    kind: z.literal("file"),
    maxFiles: z.number().int().min(1).max(10).default(1),
    maxMB: z.number().int().min(1).max(500).default(25),
  }),
  z.object({ ...common, kind: z.literal("signature") }),
  z.object({ ...common, kind: z.literal("wallet") }),
]);
export type Question = z.infer<typeof QuestionSchema>;

/** Layout blocks that are not questions. */
export const LayoutSchema = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("page") }),
  z.object({ id, kind: z.literal("heading"), title: text(200) }),
  z.object({ id, kind: z.literal("statement"), title: text(500), description: text(2000).default("") }),
]);
export type Layout = z.infer<typeof LayoutSchema>;

export const FormBlockSchema = z.union([QuestionSchema, LayoutSchema]);
export type FormBlock = z.infer<typeof FormBlockSchema>;

export const EndingSchema = z.object({
  id,
  title: text(300),
  body: text(2000).default(""),
  button: z.object({ label: text(40), url: httpsUrl }).optional(),
  /** Send people straight on instead of showing this screen. */
  redirect: httpsUrl.optional(),
});
export type Ending = z.infer<typeof EndingSchema>;

export const CONDITION_OPS = ["is", "is_not", "contains", "lt", "gt", "answered", "not_answered"] as const;
export const ConditionSchema = z.object({ q: id, op: z.enum(CONDITION_OPS), value: text(200).default("") });
export const RuleSchema = z.object({ when: z.array(ConditionSchema).min(1).max(10), to: id });
/** Branching after one question; `otherwise` empty means "go to the next block". */
export const LogicSchema = z.object({
  after: id,
  rules: z.array(RuleSchema).max(20),
  otherwise: z.string().max(40).default(""),
});
export type Logic = z.infer<typeof LogicSchema>;

export const FormDefSchema = z.object({
  v: z.literal(1),
  id,
  owner: addr,
  name: z.string().max(40),
  slug: z.string().regex(/^[a-z0-9-]{1,48}$/),
  title: text(200),
  description: text(1000).default(""),
  welcome: z.object({
    enabled: z.boolean().default(true),
    button: text(24).default("Start"),
    showTime: z.boolean().default(true),
  }),
  blocks: z.array(FormBlockSchema).max(200),
  endings: z.array(EndingSchema).min(1).max(10),
  logic: z.array(LogicSchema).max(200).default([]),
  settings: z.object({
    progress: z.boolean().default(true),
    numbers: z.boolean().default(true),
    closed: z.boolean().default(false),
    limit: z.number().int().min(1).max(1_000_000).optional(),
    closeAt: z.string().optional(),
    notify: z.boolean().default(true),
    language: z.enum(["en"]).default("en"),
  }),
  /** Extra readers (an assistant…): answers are sealed to them too. */
  readers: z
    .array(z.object({ address: addr, name: z.string().max(40), note: text(60).default("") }))
    .max(10)
    .default([]),
  /** Do not list the readers to respondents (their accounts remain in this public definition). */
  hideReaders: z.boolean().default(false),
  design: z.object({
    logo: z.object({ hash: z.string(), type: z.string() }).optional(),
    cover: z.object({ hash: z.string(), type: z.string() }).optional(),
    accent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/)
      .optional(),
  }),
  preview: z
    .object({ title: text(120).default(""), description: text(240).default("") })
    .default({ title: "", description: "" }),
  version: z.number().int().min(1),
  updatedAt: z.string(),
});
export type FormDef = z.infer<typeof FormDefSchema>;

export const isQuestion = (b: FormBlock): b is Question => (QUESTION_KINDS as readonly string[]).includes(b.kind);

/** Rough time to answer, for "Takes X min": seconds per question by kind. */
export function minutesToComplete(def: Pick<FormDef, "blocks">): number {
  const per: Partial<Record<QuestionKind, number>> = {
    long: 45,
    file: 30,
    signature: 20,
    checkboxes: 12,
    short: 10,
    email: 8,
    phone: 8,
  };
  const s = def.blocks
    .filter(isQuestion)
    .filter((q) => !q.hidden)
    .reduce((n, q) => n + (per[q.kind] ?? 7), 0);
  return Math.max(1, Math.round(s / 60));
}

/** Problems that stop publishing, in plain words. */
export function formProblems(def: FormDef): string[] {
  const p: string[] = [];
  const qs = def.blocks.filter(isQuestion);
  if (!def.title.trim()) p.push("Give the form a title.");
  if (qs.length === 0) p.push("Add at least one question.");
  qs.forEach((q, i) => {
    if (!q.title.trim()) p.push(`Question ${i + 1} needs a title.`);
    if ("choices" in q && q.choices.some((c) => !c.label.trim())) p.push(`Question ${i + 1} has an empty choice.`);
    if (q.kind === "checkboxes" && q.minPick !== undefined && q.maxPick !== undefined && q.minPick > q.maxPick)
      p.push(`Question ${i + 1}: the minimum choices is above the maximum.`);
  });
  const ids = new Set(def.blocks.map((b) => b.id));
  const endIds = new Set(def.endings.map((e) => e.id));
  for (const l of def.logic) {
    if (!ids.has(l.after)) p.push("A logic rule points at a question that no longer exists.");
    for (const r of l.rules)
      if (!ids.has(r.to) && !endIds.has(r.to)) p.push("A logic rule goes to a step that no longer exists.");
    if (l.otherwise && !ids.has(l.otherwise) && !endIds.has(l.otherwise))
      p.push("An “all other cases” step no longer exists.");
  }
  return [...new Set(p)];
}

export type AnswerValue = string | string[] | number | boolean | null;
export interface FormAnswerPayload {
  v: 1;
  formId: string;
  formVersion: number;
  answers: Record<string, AnswerValue>;
  /** File and signature answers: sealed pieces, keys inside this envelope. */
  files: Record<string, unknown[]>;
  /** URL parameters the link carried (where the respondent came from). */
  hidden: Record<string, string>;
  ending: string;
  startedAt: string;
  submittedAt: string;
}

// ---- the respondent's path through a form (pure; shared by runner, preview and flow map) ----

export const isAnswered = (v: AnswerValue | undefined): boolean =>
  v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0);

function answerText(q: Question | undefined, v: AnswerValue | undefined): string {
  if (!isAnswered(v) || v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  const label = (x: string) => (q && "choices" in q ? (q.choices.find((c) => c.id === x)?.label ?? x) : x);
  if (Array.isArray(v)) return v.map(label).join(", ");
  return label(String(v));
}

export function conditionHolds(
  def: Pick<FormDef, "blocks">,
  c: { q: string; op: (typeof CONDITION_OPS)[number]; value: string },
  answers: Record<string, AnswerValue>,
): boolean {
  const q = def.blocks.find((b): b is Question => b.id === c.q && isQuestion(b));
  const v = answers[c.q];
  switch (c.op) {
    case "answered":
      return isAnswered(v);
    case "not_answered":
      return !isAnswered(v);
    case "is":
    case "is_not": {
      const hit = Array.isArray(v)
        ? v.includes(c.value)
        : typeof v === "boolean"
          ? (v ? "yes" : "no") === c.value
          : String(v ?? "") === c.value;
      return c.op === "is" ? hit : !hit;
    }
    case "contains":
      return answerText(q, v).toLowerCase().includes(c.value.toLowerCase());
    case "lt":
    case "gt": {
      const n = Number(v);
      const t = Number(c.value);
      if (!isAnswered(v) || Number.isNaN(n) || Number.isNaN(t)) return false;
      return c.op === "lt" ? n < t : n > t;
    }
  }
}

/** Where to go after a block: a block id, an ending id, or "" for "the next block in order". */
export function nextAfter(
  def: Pick<FormDef, "blocks" | "logic">,
  blockId: string,
  answers: Record<string, AnswerValue>,
): string {
  const l = def.logic.find((x) => x.after === blockId);
  if (!l) return "";
  for (const r of l.rules) if (r.when.every((c) => conditionHolds(def, c, answers))) return r.to;
  return l.otherwise;
}

/** Replace `{{questionId}}` mentions with the respondent's answer (or nothing). */
export function recall(textIn: string, def: Pick<FormDef, "blocks">, answers: Record<string, AnswerValue>): string {
  return textIn.replace(/\{\{([A-Za-z0-9_-]{1,40})\}\}/g, (_, id: string) =>
    answerText(
      def.blocks.find((b): b is Question => b.id === id && isQuestion(b)),
      answers[id],
    ),
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;
const WALLET = /^qor1[02-9ac-hj-np-z]{38}$/;

/** The problem with one answer, in the respondent's words, or null when it can go. */
export function answerProblem(q: Question, v: AnswerValue | undefined, fileCount = 0): string | null {
  const empty = q.kind === "file" || q.kind === "signature" ? fileCount === 0 : !isAnswered(v);
  if (empty) return q.required ? "Please fill this in" : null;
  const s = typeof v === "string" ? v.trim() : "";
  switch (q.kind) {
    case "short":
    case "long":
      if (q.minChars !== undefined && s.length < q.minChars) return `Please write at least ${q.minChars} characters`;
      if (q.maxChars !== undefined && s.length > q.maxChars) return `Please keep it under ${q.maxChars} characters`;
      return null;
    case "email":
      return EMAIL.test(s) ? null : "Hmm, that email doesn't look right";
    case "phone":
      return PHONE.test(s) ? null : "Hmm, that phone number doesn't look right";
    case "link":
      try {
        const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
        return u.hostname.includes(".") ? null : "Hmm, that link doesn't look right";
      } catch {
        return "Hmm, that link doesn't look right";
      }
    case "number": {
      const n = Number(v);
      if (Number.isNaN(n)) return "Please enter a number";
      if (q.min !== undefined && n < q.min) return `Please enter ${q.min} or more`;
      if (q.max !== undefined && n > q.max) return `Please enter ${q.max} or less`;
      return null;
    }
    case "date":
      return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) ? null : "Please pick a date";
    case "wallet":
      return WALLET.test(s) ? null : "That is not a QoreChain address (qor1…)";
    case "checkboxes": {
      const n = Array.isArray(v) ? v.length : 0;
      if (q.minPick !== undefined && n < q.minPick) return pickHint(q) ?? "Please choose more";
      if (q.maxPick !== undefined && n > q.maxPick) return pickHint(q) ?? "Please choose fewer";
      return null;
    }
    default:
      return null;
  }
}

/** Typeform's selection hint: "Make between 1 and 2 choices". */
export function pickHint(q: Question): string | null {
  if (q.kind !== "checkboxes") return null;
  const { minPick: a, maxPick: b } = q;
  if (a !== undefined && b !== undefined)
    return a === b ? `Make ${a} choice${a === 1 ? "" : "s"}` : `Make between ${a} and ${b} choices`;
  if (a !== undefined) return `Make at least ${a} choice${a === 1 ? "" : "s"}`;
  if (b !== undefined) return `Make up to ${b} choice${b === 1 ? "" : "s"}`;
  return null;
}
