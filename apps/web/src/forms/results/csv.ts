/**
 * CSV for spreadsheets (RFC 4180): comma separated, CRLF line ends, fields
 * with a comma, quote or line break wrapped in double quotes and inner quotes
 * doubled. A UTF-8 byte order mark makes Excel read accents and Japanese right.
 *
 * Answers come from strangers, so a text cell that a spreadsheet would run as a
 * formula (starting with = + - @, tab or carriage return) gets a leading
 * apostrophe (OWASP CSV injection guidance). Plain numbers are left alone.
 */

/** Byte order mark: tells Excel the file is UTF-8. */
const BOM = String.fromCharCode(0xfeff);
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** Neutralise a text cell a spreadsheet would treat as a formula. */
export function defuse(text: string): string {
  return FORMULA_START.test(text) && !PLAIN_NUMBER.test(text) ? `'${text}` : text;
}

/** One RFC 4180 field. */
export function csvField(value: string | number): string {
  const text = typeof value === "number" ? String(value) : defuse(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole file: header row first, BOM in front, CRLF after every record. */
export function toCsv(rows: (string | number)[][]): string {
  return `${BOM}${rows.map((r) => r.map(csvField).join(",")).join("\r\n")}\r\n`;
}
