/**
 * Shapes shared by the owner's Results tab and the public snapshot page.
 * A snapshot arrives from a link anyone can make, so its contents are checked
 * against these schemas before a single value is shown.
 */
import { z } from "zod";

const title = z.string().max(600);
const count = z.number().int().min(0).max(100_000_000);

export const BarSchema = z.object({ label: z.string().max(400), count });
export type Bar = z.infer<typeof BarSchema>;

const base = { id: z.string().max(60), title, kind: z.string().max(20), answered: count, total: count };

/** One question's summary, computed in the owner's browser from opened answers. */
export const QuestionSummarySchema = z.discriminatedUnion("type", [
  z.object({
    ...base,
    type: z.literal("bars"),
    /** Several picks per person (checkboxes): percentages may add up to more than 100. */
    multi: z.boolean(),
    bars: z.array(BarSchema).max(260),
    /** What people typed under "Other", newest first. */
    others: z.array(z.string().max(25_000)).max(5000),
    /** Rating and opinion scale: the mean of the picked values. */
    average: z.number().nullable(),
    /** Rating and opinion scale: the highest possible value, for "4.2 of 5". */
    scaleMax: z.number().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal("numbers"),
    min: z.number().nullable(),
    avg: z.number().nullable(),
    max: z.number().nullable(),
  }),
  z.object({
    ...base,
    type: z.literal("texts"),
    latest: z.array(z.object({ text: z.string().max(25_000), at: z.string().max(40) })).max(5000),
  }),
  z.object({ ...base, type: z.literal("files"), files: count }),
]);
export type QuestionSummary = z.infer<typeof QuestionSummarySchema>;

export const CountersSchema = z.object({
  views: count,
  starts: count,
  submissions: count,
  secondsTotal: z.number().int().min(0),
});
export type Counters = z.infer<typeof CountersSchema>;

/** What a shared snapshot holds. Nothing else is in the sealed copy. */
export const SnapshotSchema = z.object({
  v: z.literal(1),
  kind: z.literal("form-snapshot"),
  formId: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  title: z.string().max(200),
  description: z.string().max(1000),
  createdAt: z.string().max(40),
  /** Answers opened on the owner's device when the snapshot was made. */
  responses: count,
  counters: CountersSchema,
  summary: z.array(QuestionSummarySchema).max(260),
  /** The full responses table, only when the owner chose to include it. */
  table: z
    .object({
      columns: z.array(z.string().max(600)).max(400),
      rows: z.array(z.array(z.string().max(25_000)).max(400)).max(20_000),
    })
    .nullable(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
