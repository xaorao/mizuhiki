/**
 * Proof-of-work stamp for content-blind spam control. The sender finds a nonce
 * so that SHA-256("mzk:pow:v1|" + recipient + "|" + envelopeHash + "|" + minute + "|" + nonce)
 * (bound to the exact envelope, so one stamp cannot be reused for another drop)
 * starts with `bits` zero bits. The server checks it in one hash.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { utf8 } from "./bytes";

export interface PowStamp {
  minute: number;
  nonce: number;
  bits: number;
}

const leadingZeroBits = (h: Uint8Array): number => {
  let n = 0;
  for (const b of h) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
};

const input = (recipient: string, envelopeHash: string, minute: number, nonce: number): Uint8Array =>
  utf8(`mzk:pow:v1|${recipient}|${envelopeHash}|${minute}|${nonce}`);

export function solvePow(recipient: string, envelopeHash: string, bits: number, now: number = Date.now()): PowStamp {
  const minute = Math.floor(now / 60_000);
  for (let nonce = 0; nonce < 0x7fffffff; nonce++) {
    if (leadingZeroBits(sha256(input(recipient, envelopeHash, minute, nonce))) >= bits) return { minute, nonce, bits };
  }
  throw new Error("proof of work not found");
}

/** Accepts stamps from the current or the previous two minutes. */
export function checkPow(
  stamp: PowStamp,
  recipient: string,
  envelopeHash: string,
  minBits: number,
  now: number = Date.now(),
): boolean {
  const minute = Math.floor(now / 60_000);
  if (!Number.isInteger(stamp.nonce) || stamp.nonce < 0 || stamp.bits < minBits) return false;
  if (stamp.minute > minute || stamp.minute < minute - 2) return false;
  return leadingZeroBits(sha256(input(recipient, envelopeHash, stamp.minute, stamp.nonce))) >= minBits;
}

/** Same as solvePow, but yields to the page every few thousand hashes so the UI keeps animating. */
export async function solvePowAsync(
  recipient: string,
  envelopeHash: string,
  bits: number,
  signal?: AbortSignal,
): Promise<PowStamp> {
  const minute = Math.floor(Date.now() / 60_000);
  for (let nonce = 0; nonce < 0x7fffffff; nonce++) {
    if (leadingZeroBits(sha256(input(recipient, envelopeHash, minute, nonce))) >= bits) return { minute, nonce, bits };
    if (nonce % 4096 === 4095) {
      signal?.throwIfAborted();
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  throw new Error("proof of work not found");
}
