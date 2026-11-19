import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import type { FormAnswerPayload, Question } from "@mizuhiki/core";
import {
  answerText,
  buildTable,
  clock,
  completionRate,
  funnel,
  matches,
  pct,
  summarize,
  type OpenedResponse,
} from "../../src/forms/results/aggregate";
import { csvField, defuse, toCsv } from "../../src/forms/results/csv";
import { colName, sheetName, xlsx, xlsxParts, xmlEscape } from "../../src/forms/results/xlsx";
import { SnapshotSchema } from "../../src/forms/results/schema";

const common = { description: "", required: true, hidden: false, half: false };
const questions: Question[] = [
  { ...common, id: "name", kind: "short", title: "Your name", placeholder: "" },
  {
    ...common,
    id: "budget",
    kind: "choice",
    title: "Budget",
    choices: [
      { id: "lo", label: "Under 500" },
      { id: "hi", label: "500 or more" },
    ],
    other: true,
    randomize: false,
  },
  {
    ...common,
    id: "svc",
    kind: "checkboxes",
    title: "Services",
    choices: [
      { id: "logo", label: "Logo" },
      { id: "web", label: "Website" },
    ],
    other: false,
    none: true,
    randomize: false,
  },
  { ...common, id: "ok", kind: "yesno", title: "Worked with us before?" },
  { ...common, id: "stars", kind: "rating", title: "How was it?", max: 5, icon: "star" },
  { ...common, id: "guests", kind: "number", title: "Guests" },
  { ...common, id: "cv", kind: "file", title: "CV", maxFiles: 1, maxMB: 25 },
];

const payload = (answers: FormAnswerPayload["answers"], extra: Partial<FormAnswerPayload> = {}): FormAnswerPayload => ({
  v: 1,
  formId: "f1",
  formVersion: 1,
  answers,
  files: {},
  hidden: {},
  ending: "e1",
  startedAt: "2026-11-19T10:00:00.000Z",
  submittedAt: "2026-11-19T10:01:25.000Z",
  ...extra,
});

const responses: OpenedResponse[] = [
  {
    hash: "a".repeat(64),
    at: "2026-11-19T10:01:26.000Z",
    readers: 1,
    payload: payload({ name: "Rohan", budget: "lo", svc: ["logo", "web"], ok: true, stars: 4, guests: 2 }),
  },
  {
    hash: "b".repeat(64),
    at: "2026-11-19T11:00:00.000Z",
    readers: 1,
    payload: payload(
      {
        name: '=HYPERLINK("x")',
        budget: "other",
        "budget:other": "Depends, really",
        svc: ["none"],
        ok: false,
        stars: 5,
        guests: 7,
      },
      { files: { cv: [{ name: "cv.pdf", type: "application/pdf", size: 10 }] }, hidden: { from: "profile" } },
    ),
  },
  {
    hash: "c".repeat(64),
    at: "2026-11-19T09:00:00.000Z",
    readers: 1,
    payload: payload({ name: "Aiko", svc: ["gone"] }),
  },
];

describe("results aggregation", () => {
  it("counts choices, others, removed choices and averages", () => {
    const sum = summarize(questions, responses);
    const budget = sum.find((q) => q.id === "budget");
    expect(budget).toMatchObject({
      type: "bars",
      answered: 2,
      total: 3,
      bars: [
        { label: "Under 500", count: 1 },
        { label: "500 or more", count: 0 },
        { label: "Other", count: 1 },
      ],
      others: ["Depends, really"],
    });
    const svc = sum.find((q) => q.id === "svc");
    expect(svc).toMatchObject({
      multi: true,
      answered: 3,
      bars: [
        { label: "Logo", count: 1 },
        { label: "Website", count: 1 },
        { label: "None of the above", count: 1 },
        { label: "A choice no longer in the form", count: 1 },
      ],
    });
    expect(sum.find((q) => q.id === "stars")).toMatchObject({ average: 4.5, scaleMax: 5, answered: 2 });
    expect(sum.find((q) => q.id === "guests")).toMatchObject({ type: "numbers", min: 2, avg: 4.5, max: 7 });
    expect(sum.find((q) => q.id === "cv")).toMatchObject({ type: "files", files: 1, answered: 1 });
    const name = sum.find((q) => q.id === "name");
    expect(name?.type === "texts" && name.latest.map((t) => t.text)).toEqual(['=HYPERLINK("x")', "Rohan", "Aiko"]);
  });

  it("writes labels, not ids", () => {
    const [, budget, svc, ok] = questions;
    const p = responses[1]?.payload;
    if (!budget || !svc || !ok || !p) throw new Error("fixture");
    expect(answerText(budget, p)).toBe("Other: Depends, really");
    expect(answerText(svc, p)).toBe("None of the above");
    expect(answerText(ok, p)).toBe("No");
  });

  it("builds the table newest first with ending, hidden fields and tags", () => {
    const t = buildTable({
      questions,
      responses,
      endings: [{ id: "e1", title: "Thanks!", body: "" }],
      tags: { ["b".repeat(64)]: ["follow up"] },
      forFile: true,
    });
    expect(t.columns.map((c) => c.label)).toEqual([
      "Submitted (UTC)",
      "Your name",
      "Budget",
      "Services",
      "Worked with us before?",
      "How was it?",
      "Guests",
      "CV",
      "Ending reached",
      "Hidden field: from",
      "Tags",
    ]);
    expect(t.rows.map((r) => r.hash[0])).toEqual(["b", "a", "c"]);
    expect(t.rows[0]?.cells).toEqual([
      "2026-11-19 11:00:00",
      '=HYPERLINK("x")',
      "Other: Depends, really",
      "None of the above",
      "No",
      5,
      7,
      "cv.pdf",
      "Thanks!",
      "profile",
      "follow up",
    ]);
  });

  it("filters with 'is any of' and searches locally", () => {
    const hit = (r: OpenedResponse, keys: string[], search = "") =>
      matches({ response: r, questions, filters: [{ qid: "svc", keys }], search, haystack: JSON.stringify(r.payload) });
    const [a, b] = responses;
    if (!a || !b) throw new Error("fixture");
    expect(hit(a, ["web"])).toBe(true);
    expect(hit(b, ["web"])).toBe(false);
    expect(hit(b, ["web", "none"])).toBe(true);
    expect(hit(a, [], "rohan")).toBe(true);
    expect(hit(a, [], "aiko")).toBe(false);
  });

  it("works out drop-off, completion and time", () => {
    const rows = funnel(questions.slice(0, 3), { starts: 10, reach: { name: 10, budget: 7, svc: 7 } });
    expect(rows.map((r) => [r.reached, r.drop])).toEqual([
      [10, 0],
      [7, 3],
      [7, 0],
    ]);
    expect(pct(rows[1]?.dropShare ?? 0, 1)).toBe("30%");
    expect(completionRate({ starts: 11, submissions: 6 })).toBeCloseTo(0.545, 3);
    expect(completionRate({ starts: 0, submissions: 0 })).toBeNull();
    expect(clock(85)).toBe("01:25");
    expect(clock(3725)).toBe("1:02:05");
  });
});

describe("CSV", () => {
  it("quotes per RFC 4180 and starts with a BOM", () => {
    expect(csvField('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
    expect(csvField(-5)).toBe("-5");
    const file = toCsv([
      ["a", "b"],
      ["1", 2],
    ]);
    expect(file.charCodeAt(0)).toBe(0xfeff);
    expect(file.slice(1)).toBe("a,b\r\n1,2\r\n");
  });

  it("defuses formulas from respondents but keeps plain numbers", () => {
    expect(defuse('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(defuse("+81 90")).toBe("'+81 90");
    expect(defuse("@me")).toBe("'@me");
    expect(defuse("-12.5")).toBe("-12.5");
    expect(defuse("hello")).toBe("hello");
  });
});

describe("XLSX", () => {
  it("names columns and sheets the way Excel expects", () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(colName)).toEqual(["A", "Z", "AA", "AZ", "BA", "ZZ", "AAA"]);
    expect(sheetName("a/b:c*d?e[f]g\\h")).toBe("a b c d e f g h");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
    expect(xmlEscape(`<a & "b">\u0001`)).toBe("&lt;a &amp; &quot;b&quot;&gt;");
  });

  it("packages a workbook with bold frozen headers, inline strings and numbers", () => {
    const rows: (string | number)[][] = [
      ["Name", "Guests"],
      ["=SUM(1)", 7],
    ];
    const parts = xlsxParts([
      { name: "Responses", rows },
      { name: "Responses", rows: [["x"]] },
    ]);
    expect(Object.keys(parts)).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]);
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Responses" sheetId="1" r:id="rId1"/>');
    expect(parts["xl/workbook.xml"]).toContain('<sheet name="Responses 2" sheetId="2" r:id="rId2"/>');
    const sheet = parts["xl/worksheets/sheet1.xml"] ?? "";
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">=SUM(1)</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>7</v></c>');
    expect(sheet).toContain('state="frozen"');
    const unzipped = unzipSync(xlsx([{ name: "Responses", rows }]));
    expect(Object.keys(unzipped)[0]).toBe("[Content_Types].xml");
    expect(strFromU8(unzipped["xl/worksheets/sheet1.xml"] ?? new Uint8Array())).toBe(
      xlsxParts([{ name: "Responses", rows }])["xl/worksheets/sheet1.xml"],
    );
  });
});

describe("snapshot schema", () => {
  it("accepts what the owner builds and refuses junk", () => {
    const snap = {
      v: 1,
      kind: "form-snapshot",
      formId: "f1",
      title: "Client intake",
      description: "",
      createdAt: "2026-11-19T12:00:00.000Z",
      responses: responses.length,
      counters: { views: 13, starts: 11, submissions: 6, secondsTotal: 510 },
      summary: summarize(questions, responses),
      table: null,
    };
    expect(SnapshotSchema.safeParse(snap).success).toBe(true);
    expect(SnapshotSchema.safeParse({ ...snap, kind: "invoice" }).success).toBe(false);
    expect(SnapshotSchema.safeParse({ ...snap, summary: [{ type: "bars" }] }).success).toBe(false);
  });
});
