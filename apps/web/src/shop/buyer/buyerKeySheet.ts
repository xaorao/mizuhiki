/**
 * The buyer-key sheet: a one-page PDF of the 12 words, made in this browser
 * (the words never leave the device). Same look as the spare-key sheet.
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const INK = rgb(0x2b / 255, 0x23 / 255, 0x40 / 255);
const MUTED = rgb(0x5b / 255, 0x4a / 255, 0x62 / 255);
const CORD = rgb(0xe2 / 255, 0x48 / 255, 0x3d / 255);
const SAKURA = rgb(1, 0xe9 / 255, 0xee / 255);

function text(page: PDFPage, s: string, x: number, y: number, size: number, font: PDFFont, color = INK) {
  page.drawText(s, { x, y, size, font, color });
}

export async function buildBuyerKeySheet(input: {
  phrase: string;
  fingerprint: string;
  shop: string;
  site: string;
  createdAt: Date;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("Mizuhiki buyer key");
  doc.setCreator("Mizuhiki");
  doc.setProducer("Mizuhiki");
  const page = doc.addPage([595.28, 841.89]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const W = page.getWidth();
  let y = 790;
  for (let i = 0; i < 5; i++) {
    const a = ((-90 + i * 72) * Math.PI) / 180;
    page.drawEllipse({
      x: 64 + Math.cos(a) * 10,
      y: y - 4 - Math.sin(a) * 10,
      xScale: 7.5,
      yScale: 7.5,
      borderColor: CORD,
      borderWidth: 2.2,
    });
  }
  page.drawCircle({ x: 64, y: y - 4, size: 3.6, color: INK });
  text(page, "mizuhiki", 92, y - 12, 22, bold);
  text(page, "Buyer key", W - 150, y - 10, 14, bold, CORD);
  y -= 52;
  text(page, "Your purchases open with these 12 words", 48, y, 22, bold);
  y -= 20;
  text(
    page,
    `Made ${input.createdAt.toISOString().slice(0, 10)} on your device while buying from @${input.shop}. Mizuhiki never saw them.`,
    48,
    y,
    10,
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
  text(page, "Anyone with these words can open what you bought. Without them, nobody can.", 54, y - 10, 11.5, bold);
  text(
    page,
    "Mizuhiki cannot reset them. Keep this sheet somewhere safe, like a receipt you cannot reprint.",
    54,
    y - 30,
    9.5,
    reg,
  );
  y -= 84;
  text(page, "Key fingerprint", 48, y, 10, bold, MUTED);
  text(page, input.fingerprint, 48, y - 16, 12, mono);
  y -= 46;
  text(page, "Buyer key (12 words, in order)", 48, y, 12, bold);
  y -= 12;
  const words = input.phrase.split(" ");
  const colW = (W - 96) / 3;
  page.drawRectangle({
    x: 40,
    y: y - 4 * 30 - 10,
    width: W - 80,
    height: 4 * 30 + 4,
    borderColor: INK,
    borderWidth: 1.5,
  });
  words.forEach((w, i) => {
    const col = Math.floor(i / 4);
    const row = i % 4;
    const x = 52 + col * colW;
    const yy = y - 22 - row * 30;
    text(page, `${String(i + 1).padStart(2, " ")}.`, x, yy, 10, reg, MUTED);
    text(page, w, x + 22, yy, 14, mono);
  });
  y -= 4 * 30 + 44;
  text(page, "How to use it", 48, y, 12, bold);
  [
    `1. On any device, open ${input.site}/library and choose Open with my 12 words.`,
    "2. Type the words in order. Your purchases open on that device; nothing is sent.",
    "3. Want a full Mizuhiki account? Log in with Use your recovery phrase and these same words.",
  ].forEach((h, i) => text(page, h, 48, y - 18 - i * 15, 10, reg));
  text(
    page,
    "Public on chain: the payment, its amount and the paying address. Sealed: what you bought.",
    48,
    40,
    8.5,
    reg,
    MUTED,
  );
  return doc.save();
}
