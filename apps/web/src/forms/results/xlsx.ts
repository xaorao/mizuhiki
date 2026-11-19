/**
 * A real Excel workbook (Office Open XML, ECMA-376 SpreadsheetML), built in
 * the browser: the smallest set of parts Excel, Numbers and LibreOffice open
 * without repair ([Content_Types].xml, package and workbook relationships,
 * workbook, styles, one worksheet per sheet), zipped with fflate. Text goes in
 * inline strings, so no cell is ever read as a formula; numbers stay numbers.
 * The header row is bold and frozen.
 */
import { strToU8, zipSync } from "fflate";

export interface SheetData {
  name: string;
  /** First row is the header. */
  rows: (string | number)[][];
}

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** Excel's limit for one cell's text. */
const MAX_CELL = 32_767;

/** Column letters: 0 → A, 25 → Z, 26 → AA. */
export function colName(index: number): string {
  let n = index + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Escape for XML text and attributes, dropping characters XML 1.0 forbids. */
export function xmlEscape(s: string): string {
  return (
    s
      // eslint-disable-next-line no-control-regex -- removing the control characters XML 1.0 does not allow
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
  );
}

/** A sheet name Excel accepts: no []:*?/\, at most 31 characters, never empty. */
export function sheetName(name: string): string {
  const s = name
    .replace(/[[\]:*?/\\]/g, " ")
    .trim()
    .slice(0, 31);
  return s || "Sheet";
}

function cell(ref: string, v: string | number, style: number): string {
  const s = style ? ` s="${style}"` : "";
  if (typeof v === "number" && Number.isFinite(v)) return `<c r="${ref}"${s}><v>${v}</v></c>`;
  const text = xmlEscape(String(v)).slice(0, MAX_CELL);
  if (!text) return "";
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

/** Column widths from the longest value, between 10 and 60 characters. */
function widths(rows: (string | number)[][]): number[] {
  const out: number[] = [];
  for (const r of rows)
    r.forEach((v, i) => {
      const longest = Math.max(
        ...String(v)
          .split("\n")
          .map((l) => l.length),
      );
      out[i] = Math.max(out[i] ?? 10, Math.min(60, longest + 2));
    });
  return out;
}

export function sheetXml(rows: (string | number)[][]): string {
  const cols = widths(rows)
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");
  const body = rows
    .map((r, ri) => {
      const cells = r.map((v, ci) => cell(`${colName(ci)}${ri + 1}`, v, ri === 0 ? 1 : 0)).join("");
      return `<row r="${ri + 1}">${cells}</row>`;
    })
    .join("");
  const frozen =
    rows.length > 1
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
  return (
    `${HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">${frozen}` +
    `<sheetFormatPr defaultRowHeight="15"/>${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${body}</sheetData></worksheet>`
  );
}

const STYLES =
  `${HEAD}<styleSheet xmlns="${NS_MAIN}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  "</styleSheet>";

/** Every part of the package, path → XML. Exposed for tests. */
export function xlsxParts(sheets: SheetData[]): Record<string, string> {
  const list = sheets.length ? sheets : [{ name: "Sheet", rows: [] }];
  const used = new Set<string>();
  const names = list.map((s) => {
    const base = sheetName(s.name);
    let name = base;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
    used.add(name.toLowerCase());
    return name;
  });
  const parts: Record<string, string> = {
    "[Content_Types].xml":
      `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      list
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join("") +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      "</Types>",
    "_rels/.rels":
      `${HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml":
      `${HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
      names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
      "</sheets></workbook>",
    "xl/_rels/workbook.xml.rels":
      `${HEAD}<Relationships xmlns="${NS_PKG_REL}">` +
      list
        .map(
          (_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join("") +
      `<Relationship Id="rId${list.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": STYLES,
  };
  list.forEach((s, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = sheetXml(s.rows);
  });
  return parts;
}

/** The .xlsx file's bytes. */
export function xlsx(sheets: SheetData[]): Uint8Array {
  const parts = xlsxParts(sheets);
  const files: Record<string, Uint8Array> = {};
  for (const [path, xml] of Object.entries(parts)) files[path] = strToU8(xml);
  return zipSync(files, { level: 6 });
}
