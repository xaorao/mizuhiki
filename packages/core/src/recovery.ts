/**
 * Spare key and recovery (spec 5.13, ARCHITECTURE 8d): signed contact invites
 * and acceptances, the words a one-time recovery key is checked by, and the
 * pieces of the phrase sealed to each contact.
 */
import { z } from "zod";
import { sha256 } from "@noble/hashes/sha2.js";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { MizuhikiError } from "./errors";

const addr = z.string().regex(/^qor1[02-9ac-hj-np-z]{38}$/);

/** The owner names a recovery contact. */
export const RecoveryInviteSchema = z.object({
  v: z.literal(1),
  type: z.literal("contact-invite"),
  owner: addr,
  contact: addr,
  note: z.string().max(300).default(""),
  at: z.iso.datetime(),
});
export type RecoveryInvite = z.infer<typeof RecoveryInviteSchema>;

/** The contact agrees to hold a piece. */
export const RecoveryAcceptSchema = z.object({
  v: z.literal(1),
  type: z.literal("contact-accept"),
  owner: addr,
  contact: addr,
  at: z.iso.datetime(),
});
export type RecoveryAccept = z.infer<typeof RecoveryAcceptSchema>;

/** The wait before pieces are released to a new device (QoreX uses 48 hours). */
export const RECOVERY_DELAY_HOURS = 48;

/** Six words for any seal key, read aloud to check a one-time recovery key. */
export function keyWords(r: { mlkemPublicKey: Uint8Array; x25519PublicKey: Uint8Array }): string {
  const h = sha256(new Uint8Array([...r.mlkemPublicKey, ...r.x25519PublicKey]));
  const words: string[] = [];
  for (let i = 0; i < 6; i++) words.push(wordlist[((h[i * 2] ?? 0) << 3) | ((h[i * 2 + 1] ?? 0) >> 5)] ?? "?");
  return words.join(" ");
}

/** A piece as it travels: which piece set it belongs to, the threshold, and the Shamir share. */
export interface PiecePayload {
  v: 1;
  owner: string;
  version: number;
  threshold: number;
  share: string;
}

/** The offline reader key, written as 24 words (its 32-byte seed as BIP-39 entropy). */
export function seedToWords(seed: Uint8Array): string {
  if (seed.length !== 32) throw new MizuhikiError("INVALID_INPUT", "An offline key is 32 bytes.");
  return entropyToMnemonic(seed, wordlist);
}
export function wordsToSeed(words: string): Uint8Array {
  try {
    const e = mnemonicToEntropy(words.trim().toLowerCase().split(/\s+/).join(" "), wordlist);
    if (e.length !== 32) throw new Error("length");
    return e;
  } catch (e) {
    throw new MizuhikiError("INVALID_PHRASE", "Those 24 words are not an offline key. Check each word and its order.", {
      cause: e,
    });
  }
}
