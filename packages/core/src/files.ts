/**
 * Chunked file sealing (our own construction on standard primitives; see
 * THREAT_MODEL.md A8). A random 32-byte key encrypts the file with AES-256-GCM
 * in 4 MiB chunks. Each chunk's IV is an 8-byte random per-file prefix plus a
 * 4-byte big-endian counter, and its AAD names the file, the chunk index and
 * the chunk count, so chunks cannot be reordered, dropped, added or moved to
 * another file without failing authentication. The key and the file's facts
 * travel in a small QoreSeal envelope; the server stores only ciphertext.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { MizuhikiError } from "./errors";
import { ab, fromBase64Url, randomBytes, sha256Hex, toBase64Url, toHex, utf8 } from "./bytes";

export const CHUNK_SIZE = 4 * 1024 * 1024;
const TAG = 16;

export interface FileFacts {
  v: 1;
  fileId: string;
  name: string;
  type: string;
  size: number;
  /** SHA-256 of the whole plaintext, hex. */
  sha256: string;
  chunkSize: number;
  /** SHA-256 of each ciphertext chunk, hex, in order: the blob store keys. */
  chunks: string[];
  /** base64url AES-256 key. Lives only inside the sealed envelope. */
  key: string;
  /** base64url 8-byte IV prefix. */
  ivPrefix: string;
}

export interface EncryptedChunk {
  index: number;
  hash: string;
  bytes: Uint8Array;
}

type Source = Blob | Uint8Array;

function sliceOf(src: Source, start: number, end: number): Promise<Uint8Array> {
  if (src instanceof Uint8Array) return Promise.resolve(src.subarray(start, end));
  return src
    .slice(start, end)
    .arrayBuffer()
    .then((b) => new Uint8Array(b));
}
const sizeOf = (src: Source): number => (src instanceof Uint8Array ? src.length : src.size);

function ivFor(prefix: Uint8Array, index: number): Uint8Array<ArrayBuffer> {
  const iv = new Uint8Array(new ArrayBuffer(12));
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, index, false);
  return iv;
}
const aadFor = (fileId: string, index: number, count: number): Uint8Array<ArrayBuffer> =>
  ab(utf8(`mzk:file|${fileId}|${index}|${count}`));

async function importKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey("raw", ab(raw), "AES-GCM", false, [usage]);
}

/**
 * Encrypt a file chunk by chunk. `onChunk` receives each ciphertext chunk as it
 * is made (upload it, then let it go), so memory stays flat for large files.
 */
export async function encryptFile(args: {
  source: Source;
  name: string;
  type: string;
  maxBytes?: number;
  onChunk: (c: EncryptedChunk) => Promise<void>;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<FileFacts> {
  const size = sizeOf(args.source);
  if (args.maxBytes !== undefined && size > args.maxBytes) {
    throw new MizuhikiError("FILE_TOO_LARGE", `"${args.name}" is larger than the limit. Nothing left your device.`, {
      dataState: "nothing-left-device",
    });
  }
  const rawKey = randomBytes(32);
  const prefix = randomBytes(8);
  const fileId = toHex(randomBytes(16));
  const key = await importKey(rawKey, "encrypt");
  const count = Math.max(1, Math.ceil(size / CHUNK_SIZE));
  const whole = sha256.create();
  const hashes: string[] = [];
  for (let i = 0; i < count; i++) {
    if (args.signal?.aborted)
      throw new MizuhikiError("INVALID_INPUT", "Cancelled.", { dataState: "nothing-left-device" });
    const plain = await sliceOf(args.source, i * CHUNK_SIZE, Math.min(size, (i + 1) * CHUNK_SIZE));
    whole.update(plain);
    const ct = new Uint8Array(
      await globalThis.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: ivFor(prefix, i), additionalData: aadFor(fileId, i, count) },
        key,
        ab(plain),
      ),
    );
    const hash = sha256Hex(ct);
    hashes.push(hash);
    await args.onChunk({ index: i, hash, bytes: ct });
    args.onProgress?.(Math.min(size, (i + 1) * CHUNK_SIZE), size);
  }
  return {
    v: 1,
    fileId,
    name: args.name,
    type: args.type || "application/octet-stream",
    size,
    sha256: toHex(whole.digest()),
    chunkSize: CHUNK_SIZE,
    chunks: hashes,
    key: toBase64Url(rawKey),
    ivPrefix: toBase64Url(prefix),
  };
}

export function parseFileFacts(bytes: Uint8Array): FileFacts {
  let f: unknown;
  try {
    f = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw new MizuhikiError("TAMPERED", "The file's sealed details are damaged.", {
      dataState: "unreadable-here",
      cause: e,
    });
  }
  const o = f as Partial<FileFacts>;
  const ok =
    o.v === 1 &&
    typeof o.fileId === "string" &&
    /^[0-9a-f]{32}$/.test(o.fileId) &&
    typeof o.name === "string" &&
    typeof o.type === "string" &&
    Number.isSafeInteger(o.size) &&
    (o.size ?? -1) >= 0 &&
    typeof o.sha256 === "string" &&
    o.chunkSize === CHUNK_SIZE &&
    Array.isArray(o.chunks) &&
    o.chunks.length === Math.max(1, Math.ceil((o.size ?? 0) / CHUNK_SIZE)) &&
    o.chunks.every((h) => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) &&
    typeof o.key === "string" &&
    typeof o.ivPrefix === "string";
  if (!ok)
    throw new MizuhikiError("TAMPERED", "The file's sealed details are damaged.", { dataState: "unreadable-here" });
  return o as FileFacts;
}

/**
 * Decrypt chunk by chunk. `fetchChunk` returns the ciphertext for a hash; each
 * chunk's hash and tag are checked, then the whole file's SHA-256.
 */
export async function decryptFile(args: {
  facts: FileFacts;
  fetchChunk: (hash: string, index: number) => Promise<Uint8Array>;
  onProgress?: (done: number, total: number) => void;
}): Promise<Uint8Array[]> {
  const f = args.facts;
  const key = await importKey(fromBase64Url(f.key), "decrypt");
  const prefix = fromBase64Url(f.ivPrefix);
  if (prefix.length !== 8)
    throw new MizuhikiError("TAMPERED", "The file's sealed details are damaged.", { dataState: "unreadable-here" });
  const whole = sha256.create();
  const parts: Uint8Array[] = [];
  const count = f.chunks.length;
  let done = 0;
  for (let i = 0; i < count; i++) {
    const expected = f.chunks[i] ?? "";
    const ct = await args.fetchChunk(expected, i);
    if (sha256Hex(ct) !== expected) {
      throw new MizuhikiError("TAMPERED", "Part of this file was changed in storage. It was not opened.", {
        dataState: "unreadable-here",
      });
    }
    if (ct.length < TAG)
      throw new MizuhikiError("TAMPERED", "Part of this file is damaged.", { dataState: "unreadable-here" });
    let plain: Uint8Array;
    try {
      plain = new Uint8Array(
        await globalThis.crypto.subtle.decrypt(
          { name: "AES-GCM", iv: ivFor(prefix, i), additionalData: aadFor(f.fileId, i, count) },
          key,
          ab(ct),
        ),
      );
    } catch (e) {
      throw new MizuhikiError("TAMPERED", "Part of this file failed its check. It was not opened.", {
        dataState: "unreadable-here",
        cause: e,
      });
    }
    whole.update(plain);
    parts.push(plain);
    done += plain.length;
    args.onProgress?.(done, f.size);
  }
  if (done !== f.size || toHex(whole.digest()) !== f.sha256) {
    throw new MizuhikiError("TAMPERED", "This file does not match its sealed fingerprint. It was not opened.", {
      dataState: "unreadable-here",
    });
  }
  return parts;
}

/**
 * SHA-256 of a whole file, read in 4 MiB slices so a large file never sits in
 * memory at once. The same digest `encryptFile` records as `FileFacts.sha256`.
 */
export async function sha256File(
  source: Blob,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const h = sha256.create();
  const step = 4 * 1024 * 1024;
  for (let at = 0; at < source.size; at += step) {
    signal?.throwIfAborted();
    h.update(new Uint8Array(await source.slice(at, Math.min(source.size, at + step)).arrayBuffer()));
    onProgress?.(Math.min(source.size, at + step), source.size);
  }
  return toHex(h.digest());
}
