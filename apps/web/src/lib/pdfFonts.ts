/**
 * Brand fonts for PDFs built in the browser. Each font is cut down with
 * HarfBuzz (fontSubset.ts) to every printable ASCII character plus every
 * character in `corpus` (the document's own text), then embedded whole, so
 * names and notes in any script the font covers render, and the file stays small.
 */
import type { PDFDocument, PDFFont } from "pdf-lib";
import { subsetFont } from "./fontSubset";

const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("");
const EXTRA = "·—–−…“”‘’€¥£°×÷→←↑↓✓✔•";

export async function embedBrandFont(pdf: PDFDocument, file: string, corpus: string): Promise<PDFFont> {
  const ttf = new Uint8Array(await (await fetch(`/fonts/${file}`)).arrayBuffer());
  const cut = await subsetFont(ttf, `${ASCII}${EXTRA}${corpus}`);
  return pdf.embedFont(cut, { subset: false });
}
