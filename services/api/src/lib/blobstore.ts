/**
 * Content-addressed blob store (ARCHITECTURE.md 2.5). Keys are the SHA-256 of
 * the bytes, so the store cannot be asked to hold one thing under another's
 * name, and identical uploads collapse. Writes are atomic (temp file + rename).
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface BlobStore {
  put(bytes: Uint8Array): Promise<{ hash: string; size: number; existed: boolean }>;
  get(hash: string): Promise<Uint8Array | undefined>;
  has(hash: string): Promise<boolean>;
  delete(hash: string): Promise<void>;
}

const HASH = /^[0-9a-f]{64}$/;
export const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

export class FsBlobStore implements BlobStore {
  constructor(private readonly root: string) {}

  private path(hash: string): string {
    if (!HASH.test(hash)) throw new Error("bad blob hash");
    return join(this.root, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async put(bytes: Uint8Array) {
    const hash = sha256Hex(bytes);
    const p = this.path(hash);
    if (await this.has(hash)) return { hash, size: bytes.length, existed: true };
    await mkdir(join(this.root, hash.slice(0, 2), hash.slice(2, 4)), { recursive: true });
    const tmp = `${p}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmp, bytes, { flag: "wx" });
    await rename(tmp, p);
    return { hash, size: bytes.length, existed: false };
  }

  async get(hash: string) {
    try {
      const b = await readFile(this.path(hash));
      if (sha256Hex(b) !== hash) throw new Error(`blob ${hash} failed its integrity check`);
      return new Uint8Array(b);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  async has(hash: string) {
    try {
      await stat(this.path(hash));
      return true;
    } catch {
      return false;
    }
  }

  async delete(hash: string) {
    await rm(this.path(hash), { force: true });
  }
}
