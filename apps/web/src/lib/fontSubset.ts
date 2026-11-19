/**
 * Font subsetting with HarfBuzz's hb-subset (harfbuzzjs 1.6.4, wasm served from
 * /vendor/harfbuzz). pdf-lib's own subsetter (fontkit 1.x) drops most glyphs of
 * the brand font, so PDFs embed a correct subset made here instead. Call
 * sequence follows the hb-subset C API as used by subset-font 2.9.0.
 */
interface HbExports {
  memory: WebAssembly.Memory;
  _initialize: () => void;
  malloc: (n: number) => number;
  free: (p: number) => void;
  hb_blob_create: (data: number, len: number, mode: number, user: number, destroy: number) => number;
  hb_blob_destroy: (b: number) => void;
  hb_blob_get_data: (b: number, len: number) => number;
  hb_blob_get_length: (b: number) => number;
  hb_face_create: (blob: number, index: number) => number;
  hb_face_destroy: (f: number) => void;
  hb_face_reference_blob: (f: number) => number;
  hb_set_add: (set: number, v: number) => void;
  hb_set_clear: (set: number) => void;
  hb_set_invert: (set: number) => void;
  hb_subset_input_create_or_fail: () => number;
  hb_subset_input_destroy: (i: number) => void;
  hb_subset_input_set: (i: number, which: number) => number;
  hb_subset_input_unicode_set: (i: number) => number;
  hb_subset_or_fail: (face: number, input: number) => number;
}

const HB_MEMORY_MODE_WRITABLE = 2;
const HB_SUBSET_SETS_LAYOUT_FEATURE_TAG = 6;

let loading: Promise<HbExports> | null = null;

export function loadHarfbuzz(wasm?: ArrayBuffer): Promise<HbExports> {
  loading ??= (async () => {
    const bytes: BufferSource = wasm ?? (await (await fetch("/vendor/harfbuzz/harfbuzz-subset.wasm")).arrayBuffer());
    const { instance } = await WebAssembly.instantiate(bytes, {});
    const hb = instance.exports as unknown as HbExports;
    hb._initialize();
    return hb;
  })();
  return loading;
}

/** A TrueType font cut down to the characters in `text` (plus what layout needs). */
export async function subsetFont(ttf: Uint8Array, text: string, wasm?: ArrayBuffer): Promise<Uint8Array> {
  const hb = await loadHarfbuzz(wasm);
  const heap = () => new Uint8Array(hb.memory.buffer); // memory may grow; take a fresh view each time
  const input = hb.hb_subset_input_create_or_fail();
  if (input === 0) throw new Error("Font subsetting could not start.");
  const buf = hb.malloc(ttf.byteLength);
  heap().set(ttf, buf);
  const blob = hb.hb_blob_create(buf, ttf.byteLength, HB_MEMORY_MODE_WRITABLE, 0, 0);
  const face = hb.hb_face_create(blob, 0);
  hb.hb_blob_destroy(blob);
  try {
    // Keep every layout feature (kerning, ligatures), like --layout-features=*.
    const feats = hb.hb_subset_input_set(input, HB_SUBSET_SETS_LAYOUT_FEATURE_TAG);
    hb.hb_set_clear(feats);
    hb.hb_set_invert(feats);
    const unicodes = hb.hb_subset_input_unicode_set(input);
    for (const ch of new Set(Array.from(text))) hb.hb_set_add(unicodes, ch.codePointAt(0) ?? 32);
    const subset = hb.hb_subset_or_fail(face, input);
    if (subset === 0) throw new Error("Font subsetting failed.");
    const result = hb.hb_face_reference_blob(subset);
    const off = hb.hb_blob_get_data(result, 0);
    const len = hb.hb_blob_get_length(result);
    const out = heap().slice(off, off + len);
    hb.hb_blob_destroy(result);
    hb.hb_face_destroy(subset);
    if (len === 0) throw new Error("Font subsetting produced nothing.");
    return out;
  } finally {
    hb.hb_subset_input_destroy(input);
    hb.hb_face_destroy(face);
    hb.free(buf);
  }
}
