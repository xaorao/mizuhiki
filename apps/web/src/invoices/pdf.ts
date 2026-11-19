/**
 * Invoice PDF, built in the owner's browser (spec 5.6): nothing about the
 * invoice is sent anywhere to make it. The brand font is embedded (subset) so
 * names and notes in any script the font covers come out right; characters the
 * font lacks (emoji) are dropped rather than breaking the file.
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import QRCode from "qrcode";
import { DUE_LABEL, STATUS_LABEL, dueDate, money, numberLabel, totals, type InvoiceDoc, type Status } from "./model";

const INK = rgb(0.17, 0.14, 0.25);
const MUTED = rgb(0.36, 0.29, 0.38);
const CORD = rgb(0.76, 0.19, 0.06);
const LINE = rgb(0.95, 0.89, 0.91);

async function font(doc: PDFDocument, file: string): Promise<PDFFont> {
  const bytes = new Uint8Array(await (await fetch(`/fonts/${file}`)).arrayBuffer());
  return doc.embedFont(bytes, { subset: true });
}

function clean(f: PDFFont, s: string): string {
  const have = new Set(f.getCharacterSet());
  return Array.from(s)
    .filter((ch) => ch === " " || have.has(ch.codePointAt(0) ?? -1))
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
    }
    out.push(line);
  }
  return out;
}

export async function invoicePdf(args: {
  doc: InvoiceDoc;
  status: Status;
  link: string | null;
  sentAt: string | null;
}): Promise<Uint8Array> {
  const { doc } = args;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(`Invoice ${numberLabel(doc.number)}`);
  pdf.setProducer("Mizuhiki");
  const [reg, bold, black] = await Promise.all([
    font(pdf, "MPLUSRounded1c-Regular.ttf"),
    font(pdf, "MPLUSRounded1c-Bold.ttf"),
    font(pdf, "MPLUSRounded1c-Black.ttf"),
  ]);
  let page: PDFPage = pdf.addPage([595.28, 841.89]); // A4
  const M = 48;
  let y = 841.89 - M;
  const W = 595.28 - 2 * M;
  const text = (s: string, x: number, size: number, f: PDFFont, color = INK) =>
    page.drawText(clean(f, s), { x, y, size, font: f, color });
  const right = (s: string, xr: number, size: number, f: PDFFont, color = INK) => {
    const c = clean(f, s);
    page.drawText(c, { x: xr - f.widthOfTextAtSize(c, size), y, size, font: f, color });
  };
  const need = (h: number) => {
    if (y - h < M) {
      page = pdf.addPage([595.28, 841.89]);
      y = 841.89 - M;
    }
  };

  text("INVOICE", M, 10, bold, CORD);
  right(doc.from.business || doc.from.displayName, M + W, 13, bold);
  y -= 30;
  text(numberLabel(doc.number), M, 28, black);
  right(doc.from.name ? `@${doc.from.name}` : "", M + W, 10, reg, MUTED);
  y -= 18;
  text(STATUS_LABEL[args.status], M, 11, bold, args.status === "paid" ? rgb(0.16, 0.45, 0.2) : MUTED);
  right(doc.from.address, M + W, 8, reg, MUTED);
  y -= 30;

  const due = dueDate(doc, args.sentAt);
  const meta: [string, string][] = [
    [
      "Bill to",
      [
        doc.billTo.business,
        doc.billTo.kind === "name" && doc.billTo.name
          ? `@${doc.billTo.name}`
          : doc.billTo.kind === "address"
            ? doc.billTo.address
            : doc.billTo.label || "Anyone with the link",
      ]
        .filter(Boolean)
        .join(" · "),
    ],
    [
      "Issued",
      new Date(args.sentAt ?? doc.issued).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      }),
    ],
    [
      "Due",
      due
        ? doc.due.preset === "receipt"
          ? "On receipt"
          : due.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
        : DUE_LABEL.none,
    ],
  ];
  for (const [k, v] of meta) {
    text(k, M, 9, bold, MUTED);
    for (const l of wrap(reg, v, 10, W - 90)) {
      page.drawText(l, { x: M + 90, y, size: 10, font: reg, color: INK });
      y -= 14;
    }
    y -= 2;
  }
  y -= 10;

  const t = totals(doc);
  const cols = { qty: M + W - 210, price: M + W - 130, amount: M + W };
  text("Item", M, 9, bold, MUTED);
  right("Qty", cols.qty, 9, bold, MUTED);
  right("Price", cols.price, 9, bold, MUTED);
  right("Amount", cols.amount, 9, bold, MUTED);
  y -= 8;
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 1, color: LINE });
  y -= 16;
  doc.items.forEach((it, i) => {
    const desc = it.description ? wrap(reg, it.description, 8.5, W - 230) : [];
    need(18 + desc.length * 11);
    text(it.name || "Untitled item", M, 10.5, bold);
    right(it.qty, cols.qty, 10, reg);
    right(it.price, cols.price, 10, reg);
    right(money(t.lines[i] ?? 0n, doc.token), cols.amount, 10, reg);
    y -= 13;
    for (const l of desc) {
      page.drawText(l, { x: M, y, size: 8.5, font: reg, color: MUTED });
      y -= 11;
    }
    y -= 6;
  });
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: M + W, y: y + 6 }, thickness: 1, color: LINE });
  y -= 10;

  const sums: [string, string, boolean][] = [["Subtotal", money(t.subtotal, doc.token), false]];
  if (t.discount > 0n) sums.push(["Discount", `−${money(t.discount, doc.token)}`, false]);
  if (t.other > 0n) sums.push([doc.otherLabel || "Other", money(t.other, doc.token), false]);
  sums.push(["Total", money(t.total, doc.token), true]);
  for (const [k, v, big] of sums) {
    need(22);
    right(k, cols.price, big ? 12 : 10, big ? bold : reg, big ? INK : MUTED);
    right(v, cols.amount, big ? 14 : 10, big ? black : reg);
    y -= big ? 22 : 15;
  }

  if (doc.message) {
    y -= 10;
    need(30);
    text("Message", M, 9, bold, MUTED);
    y -= 14;
    for (const l of wrap(reg, doc.message, 10, W)) {
      need(14);
      page.drawText(l, { x: M, y, size: 10, font: reg, color: INK });
      y -= 14;
    }
  }

  if (args.link) {
    need(150);
    y -= 20;
    const png = await QRCode.toDataURL(args.link, { margin: 1, width: 300 });
    const img = await pdf.embedPng(png);
    page.drawImage(img, { x: M, y: y - 110, width: 110, height: 110 });
    page.drawText(clean(bold, "Pay or open this invoice"), { x: M + 124, y: y - 20, size: 11, font: bold, color: INK });
    let yy = y - 38;
    for (const l of wrap(
      reg,
      "Scan or open the link. Anyone with this link can read this invoice: share it only with the person who should pay.",
      9,
      W - 130,
    )) {
      page.drawText(l, { x: M + 124, y: yy, size: 9, font: reg, color: MUTED });
      yy -= 12;
    }
    y -= 130;
  }
  need(20);
  page.drawText(
    clean(reg, `Paid in ${doc.token} on QoreChain testnet with the reference ${doc.id}. Made with Mizuhiki.`),
    { x: M, y: M - 10, size: 8, font: reg, color: MUTED },
  );
  return pdf.save();
}
