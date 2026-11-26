// Turns the proof-deck screenshots (tests/e2e/demo/tour-shots.spec.ts) into the WebP images the /tour page imports.
// Dialog screens are cropped to the dialog (boxes in tools/tour-crops.json, in screenshot pixels) so they stay legible.
// Usage: node tools/tour-images.mjs [pngDir]   (default var/tour-png). Needs cwebp (brew install webp).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

const src = process.argv[2] ?? "var/tour-png";
const out = "apps/web/src/tour/shots";
mkdirSync(out, { recursive: true });
const crops = JSON.parse(readFileSync(new URL("./tour-crops.json", import.meta.url), "utf8"));
// Captured for the record but not shown: the desktop page repeats the phone view, and the paid-invoice receipt
// predates the "No note" wording.
const SKIP = new Set(["page-desktop.png", "invoice-4-paid.png"]);
const pngs = readdirSync(src).filter((f) => f.endsWith(".png") && !SKIP.has(f));
if (pngs.length === 0) throw new Error(`no screenshots in ${src}; run pnpm --filter @mizuhiki/e2e demo:tour first`);
for (const f of pngs) {
  execFileSync("cwebp", [
    "-quiet",
    "-q",
    "84",
    "-m",
    "6",
    ...(crops[basename(f, ".png")] ? ["-crop", ...crops[basename(f, ".png")].map(String)] : []),
    join(src, f),
    "-o",
    join(out, `${basename(f, ".png")}.webp`),
  ]);
}
console.log(`wrote ${pngs.length} images to ${out}`);
