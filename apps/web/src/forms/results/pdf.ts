/**
 * Results PDF, built in the owner's browser (spec 5.9) with pdf-lib and the
 * brand font embedded, as in the invoice PDF: the counters,
 * every question's summary with bars, and, when chosen, every response.
 * Characters the font lacks (emoji) are dropped rather than breaking the file.
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { embedBrandFont } from "@/lib/pdfFonts";
import fontkit from "@pdf-lib/fontkit";
import { answeredLine, averageSeconds, clock, completionRate, localStamp, pct } from "./aggregate";
import type { Snapshot } from "./schema";

const INK = rgb(0.17, 0.14, 0.25);
const MUTED = rgb(0.36, 0.29, 0.38);
const CORD = rgb(0.76, 0.19, 0.06);
const LINE = rgb(0.95, 0.89, 0.91);
const BAR = rgb(1, 0.77, 0.82);
const TRACK = rgb(1, 0.95, 0.96);
const A4: [number, number] = [595.28, 841.89];

function clean(f: PDFFont, s: string): string {
  const have = new Set(f.getCharacterSet());
  return Array.from(s)
    .filter((ch) => ch === " " || ch === "\n" || have.has(ch.codePointAt(0) ?? -1))
    .join("");
}

function wrap(f: PDFFont, s: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of clean(f, s).split("\n")) {
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      const next = line + word;
      if (f.widthOfTextAtSize(next, size) > width && line.trim()) {
        out.push(line.trimEnd());
        line = word.trimStart();
      } else line = next;
      // A single word wider than the line (a long link): break it by characters.
      while (f.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && f.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

export async function resultsPdf(snap: Snapshot): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`${snap.title || "Form"} · results`);
  pdf.setProducer("Mizuhiki");
  const corpus = JSON.stringify(snap);
  const [reg, bold, black] = await Promise.all([
    embedBrandFont(pdf, "MPLUSRounded1c-Regular.ttf", corpus),
    embedBrandFont(pdf, "MPLUSRounded1c-Bold.ttf", corpus),
    embedBrandFont(pdf, "MPLUSRounded1c-Black.ttf", corpus),
  ]);
  const M = 48;
  const W = A4[0] - 2 * M;
  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const need = (h: number) => {
    if (y - h < M) {
      page = pdf.addPage(A4);
      y = A4[1] - M;
    }
  };
  const lines = (s: string, size: number, f: PDFFont, color = INK, x = M, width = W, lead = 1.4) => {
    for (const l of wrap(f, s, size, width)) {
      need(size * lead);
      page.drawText(l, { x, y: y - size, size, font: f, color });
      y -= size * lead;
    }
  };
  const rule = () => {
    need(14);
    y -= 6;
    page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 1, color: LINE });
    y -= 8;
  };

  lines("FORM RESULTS", 10, bold, CORD);
  y -= 4;
  lines(snap.title || "Untitled form", 24, black);
  if (snap.description) lines(snap.description, 10, reg, MUTED);
  y -= 4;
  lines(
    `Made ${localStamp(snap.createdAt)} from ${snap.responses} answer${snap.responses === 1 ? "" : "s"} opened on the owner's device. Mizuhiki cannot read these answers.`,
    9,
    reg,
    MUTED,
  );
  rule();

  // Counters, five across.
  const c = snap.counters;
  const rate = completionRate(c);
  const avg = averageSeconds(c);
  const tiles: [string, string][] = [
    ["Views", String(c.views)],
    ["Starts", String(c.starts)],
    ["Submissions", String(c.submissions)],
    ["Completion rate", rate === null ? "–" : pct(rate, 1)],
    ["Time to complete", avg === null ? "–" : clock(avg)],
  ];
  need(52);
  const tw = W / tiles.length;
  tiles.forEach(([k, v], i) => {
    page.drawText(clean(bold, k), { x: M + i * tw, y: y - 9, size: 8.5, font: bold, color: MUTED });
    page.drawText(clean(black, v), { x: M + i * tw, y: y - 32, size: 18, font: black, color: INK });
  });
  y -= 44;
  lines("Counted without reading answers.", 8.5, reg, MUTED);
  rule();

  lines("Summary", 15, black);
  y -= 6;
  for (const s of snap.summary) {
    need(46);
    lines(s.title || "Untitled question", 11.5, bold);
    lines(answeredLine(s), 8.5, reg, MUTED);
    y -= 4;
    if (s.type === "bars") {
      const labelW = 170;
      const numW = 70;
      const barW = W - labelW - numW - 12;
      const base = s.answered;
      for (const b of s.bars) {
        const label = wrap(reg, b.label, 9, labelW);
        const h = Math.max(14, label.length * 12);
        need(h + 2);
        label.forEach((l, i) => page.drawText(l, { x: M, y: y - 10 - i * 12, size: 9, font: reg, color: INK }));
        page.drawRectangle({ x: M + labelW + 6, y: y - 12, width: barW, height: 9, color: TRACK });
        const share = base > 0 ? b.count / base : 0;
        if (share > 0)
          page.drawRectangle({ x: M + labelW + 6, y: y - 12, width: Math.max(2, barW * share), height: 9, color: BAR });
        const num = clean(reg, `${b.count} · ${pct(b.count, base)}`);
        page.drawText(num, {
          x: M + W - reg.widthOfTextAtSize(num, 9),
          y: y - 10,
          size: 9,
          font: reg,
          color: MUTED,
        });
        y -= h + 2;
      }
      if (s.average !== null)
        lines(`Average ${s.average.toFixed(1)}${s.scaleMax !== null ? ` of ${s.scaleMax}` : ""}`, 9, bold, MUTED);
      if (s.others.length) {
        lines("Other answers", 9, bold, MUTED);
        for (const o of s.others.slice(0, 20)) lines(`• ${o}`, 9, reg, INK, M + 8, W - 8);
        if (s.others.length > 20) lines(`and ${s.others.length - 20} more`, 8.5, reg, MUTED, M + 8);
      }
    } else if (s.type === "numbers") {
      const f = (n: number | null) => (n === null ? "–" : Number.isInteger(n) ? String(n) : n.toFixed(2));
      lines(`Lowest ${f(s.min)} · Average ${f(s.avg)} · Highest ${f(s.max)}`, 10, reg);
    } else if (s.type === "files") {
      lines(`${s.files} sealed file${s.files === 1 ? "" : "s"}. Files are never part of a summary.`, 9.5, reg, MUTED);
    } else {
      for (const t of s.latest.slice(0, 12)) {
        need(26);
        lines(t.text, 9.5, reg, INK, M + 8, W - 8);
        lines(localStamp(t.at), 7.5, reg, MUTED, M + 8, W - 8);
        y -= 2;
      }
      if (s.latest.length > 12) lines(`and ${s.latest.length - 12} more in the responses`, 8.5, reg, MUTED, M + 8);
    }
    y -= 8;
  }

  if (snap.table) {
    page = pdf.addPage(A4);
    y = A4[1] - M;
    lines("Responses", 15, black);
    y -= 4;
    const { columns, rows } = snap.table;
    rows.forEach((r, i) => {
      need(40);
      rule();
      lines(`Response ${rows.length - i} · ${r[0] ?? ""} UTC`, 11, bold);
      y -= 2;
      columns.forEach((col, ci) => {
        if (ci === 0) return;
        const v = r[ci] ?? "";
        if (!v) return;
        need(24);
        lines(col, 8, bold, MUTED);
        lines(v, 9.5, reg, INK, M, W, 1.35);
        y -= 3;
      });
    });
  }

  const pages = pdf.getPages();
  pages.forEach((p, i) => {
    p.drawText(clean(reg, `${snap.title || "Form"} · page ${i + 1} of ${pages.length} · made with Mizuhiki`), {
      x: M,
      y: M - 24,
      size: 7.5,
      font: reg,
      color: MUTED,
    });
  });
  return pdf.save();
}
