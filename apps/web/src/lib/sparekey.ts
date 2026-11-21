/**
 * The spare-key sheet (1Password Emergency Kit pattern, spec 5.2 step 6 and
 * 5.13): page address, account address, the 24 words, a QR of the account
 * address, and blank lines for notes. Built entirely in this browser; the
 * phrase never leaves the device.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";

const INK = rgb(0x2b / 255, 0x23 / 255, 0x40 / 255);
const MUTED = rgb(0x5b / 255, 0x4a / 255, 0x62 / 255);
const CORD = rgb(0xe2 / 255, 0x48 / 255, 0x3d / 255);
const SAKURA = rgb(1, 0xe9 / 255, 0xee / 255);

export interface SheetInput {
  name: string;
  pageUrl: string;
  address: string;
  evm: string;
  phrase: string;
  createdAt: Date;
  /** "offline": the offline reader sheet (spec 5.13), which reads items but cannot sign in. */
  variant?: "spare" | "offline" | undefined;
}

const WORDING = {
  spare: {
    title: "Spare-key sheet",
    warn: "Without it, or your recovery contacts, no one can open your sealed items, including you.",
    warn2:
      "Give a copy to someone you trust, or add it to your will. Never type it into a site you did not open yourself.",
    words: "Recovery phrase (24 words, in order)",
    how: [
      "1. On a new device, open Mizuhiki, choose Log in and type these 24 words.",
      "2. Type the 24 words. Set a new device passphrase. Your sealed items open again.",
      "3. If someone else has this sheet, they can open everything. Store it like a passport.",
    ],
  },
  offline: {
    title: "Offline reader sheet",
    warn: "These words read what was sealed to this offline key. They cannot sign in, pay or change anything.",
    warn2:
      "Keep it offline, away from your spare-key sheet. Anyone holding it can read your items, so store it like a passport.",
    words: "Offline reader key (24 words, in order)",
    how: [
      "1. Open Mizuhiki on any device and choose Log in, then Read with an offline key.",
      "2. Type your @name and these 24 words. Items sealed to this key open on that device.",
      "3. If you turn the offline reader off or make a new one, this sheet stops receiving new items.",
    ],
  },
} as const;

function text(page: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color = INK) {
  page.drawText(s, { x, y, size, font, color });
}

function knot(page: PDFPage, cx: number, cy: number, r: number) {
  for (let i = 0; i < 5; i++) {
    const a = ((-90 + i * 72) * Math.PI) / 180;
    page.drawEllipse({
      x: cx + Math.cos(a) * r * 0.55,
      y: cy - Math.sin(a) * r * 0.55,
      xScale: r * 0.42,
      yScale: r * 0.42,
      borderColor: CORD,
      borderWidth: r * 0.12,
    });
  }
  page.drawCircle({ x: cx, y: cy, size: r * 0.2, color: INK });
}

export async function buildSpareKeySheet(input: SheetInput): Promise<Uint8Array> {
  const wd = WORDING[input.variant ?? "spare"];
  const doc = await PDFDocument.create();
  doc.setTitle(`Mizuhiki ${wd.title.toLowerCase()} for @${input.name}`);
  doc.setCreator("Mizuhiki");
  doc.setProducer("Mizuhiki");
  const page = doc.addPage([595.28, 841.89]); // A4
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const W = page.getWidth();
  let y = 790;
  knot(page, 64, y - 4, 18);
  text(page, "mizuhiki", 92, y - 12, 22, bold);
  text(page, wd.title, W - 48 - bold.widthOfTextAtSize(wd.title, 14), y - 10, 14, bold, CORD);
  y -= 50;
  text(page, `For @${input.name}`, 48, y, 26, bold);
  y -= 22;
  text(
    page,
    `Made ${input.createdAt.toISOString().slice(0, 10)} on your device. Mizuhiki never saw this phrase.`,
    48,
    y,
    10.5,
    reg,
    MUTED,
  );
  y -= 30;
  page.drawRectangle({
    x: 40,
    y: y - 46,
    width: W - 80,
    height: 58,
    color: SAKURA,
    borderColor: INK,
    borderWidth: 1.5,
  });
  text(page, wd.warn, 54, y - 10, wd.warn.length > 70 ? 10.5 : 12, bold);
  text(page, wd.warn2, 54, y - 30, 9.5, reg);
  y -= 80;
  text(page, "Your page", 48, y, 10, bold, MUTED);
  text(page, input.pageUrl, 48, y - 16, 12, reg);
  text(page, "Account address", 48, y - 40, 10, bold, MUTED);
  text(page, input.address, 48, y - 56, 10.5, mono);
  text(page, input.evm, 48, y - 70, 10.5, mono);
  // toDataURL works in browsers (toBuffer is Node-only in the qrcode package).
  const dataUrl = await QRCode.toDataURL(input.address, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 300,
    color: { dark: "#2b2340", light: "#ffffff" },
  });
  const qrImg = await doc.embedPng(dataUrl);
  page.drawImage(qrImg, { x: W - 150, y: y - 92, width: 104, height: 104 });
  y -= 118;
  text(page, wd.words, 48, y, 12, bold);
  y -= 12;
  const words = input.phrase.split(" ");
  const colW = (W - 96) / 4;
  page.drawRectangle({
    x: 40,
    y: y - 6 * 30 - 10,
    width: W - 80,
    height: 6 * 30 + 4,
    borderColor: INK,
    borderWidth: 1.5,
  });
  words.forEach((w, i) => {
    const col = Math.floor(i / 6);
    const row = i % 6;
    const x = 52 + col * colW;
    const yy = y - 22 - row * 30;
    text(page, `${String(i + 1).padStart(2, " ")}.`, x, yy, 10, reg, MUTED);
    text(page, w, x + 22, yy, 13, mono);
  });
  y -= 6 * 30 + 44;
  text(page, "How to use it", 48, y, 12, bold);
  wd.how.forEach((h, i) => text(page, h, 48, y - 18 - i * 15, 10, reg));
  y -= 80;
  text(page, "Notes", 48, y, 12, bold);
  for (let i = 0; i < 5; i++)
    page.drawLine({
      start: { x: 48, y: y - 26 - i * 24 },
      end: { x: W - 48, y: y - 26 - i * 24 },
      thickness: 0.7,
      color: MUTED,
    });
  text(
    page,
    "Public on chain: your address, payments and their amounts. Sealed: everything sent to your page.",
    48,
    40,
    8.5,
    reg,
    MUTED,
  );
  return doc.save();
}
