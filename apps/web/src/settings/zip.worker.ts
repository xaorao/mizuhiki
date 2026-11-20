/**
 * Packs the export zip off the page's main thread. A same-origin module worker, so the Content-Security-Policy
 * (`worker-src 'self'`) allows it; fflate's own async zip starts workers from blob: URLs, which that policy refuses
 * (and fflate then never answers).
 */
import { zipSync, type Zippable } from "fflate";

type Reply = { ok: true; bytes: Uint8Array } | { ok: false; message: string };

self.onmessage = (e: MessageEvent<Zippable>) => {
  let reply: Reply;
  try {
    reply = { ok: true, bytes: zipSync(e.data, { level: 6 }) };
  } catch (err) {
    reply = { ok: false, message: err instanceof Error ? err.message : "The zip could not be made." };
  }
  if (reply.ok) (self as unknown as Worker).postMessage(reply, [reply.bytes.buffer]);
  else (self as unknown as Worker).postMessage(reply);
};
