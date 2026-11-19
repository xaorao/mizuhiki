import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  addressFromPublicKey,
  deriveCanonicalPqKey,
  deriveClassicalKey,
  type AccountAddress,
  type ClassicalKey,
  type PqKeyPair,
} from "@qorechain/qoresign";
import { deriveSealKeys, recipientOf, type SealKeyPair, type SealRecipient } from "@qorechain/qoreseal";
import { MizuhikiError } from "./errors";

/** 24 words: 256 bits of entropy. */
export const PHRASE_WORDS = 24;
/** First-time buyer keys use 12 words (128 bits). */
export const BUYER_PHRASE_WORDS = 12;

/** Every key an account derives from its phrase. Hold only in memory while unlocked. */
export interface AccountKeys {
  phrase: string;
  address: AccountAddress;
  /** eth_secp256k1, so the same 20 bytes serve the native and EVM lanes. */
  classical: ClassicalKey;
  /** The canonical ML-DSA-87 key QoreChain wallets derive for this address. */
  pq: PqKeyPair;
  /** Seal key at index 0: the owner's own sealing key. */
  seal: SealKeyPair;
}

export function newPhrase(words: 12 | 24 = PHRASE_WORDS): string {
  return generateMnemonic(wordlist, words === 24 ? 256 : 128);
}

/** Lower-case, single spaces, NFKD: the form BIP-39 hashes. */
export function normalizePhrase(input: string): string {
  return input.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidPhrase(input: string): boolean {
  const p = normalizePhrase(input);
  const n = p.split(" ").length;
  return (n === 12 || n === 24) && validateMnemonic(p, wordlist);
}

export function phraseWords(phrase: string): string[] {
  return normalizePhrase(phrase).split(" ");
}

/** Is `word` in the BIP-39 English list? Used for per-word feedback while typing. */
export function isPhraseWord(word: string): boolean {
  return wordlist.includes(word.trim().toLowerCase());
}

export function deriveAccount(phraseInput: string): AccountKeys {
  const phrase = normalizePhrase(phraseInput);
  if (!isValidPhrase(phrase)) {
    throw new MizuhikiError("INVALID_PHRASE", "That phrase is not valid. Check each word and its order.", {
      dataState: "nothing-changed",
    });
  }
  const classical = deriveClassicalKey({ mnemonic: phrase, type: "eth_secp256k1" });
  const address = addressFromPublicKey(classical.publicKey, "eth_secp256k1");
  const pq = deriveCanonicalPqKey({ mnemonic: phrase, address: address.bech32 });
  const seal = deriveSealKeys({ mnemonic: phrase, index: 0 });
  return { phrase, address, classical, pq, seal };
}

/**
 * A scoped seal key derived from the same phrase: period keys for passes,
 * the offline recovery reader. Index 0 is the owner's own key and is refused.
 */
export function deriveScopedSealKey(phraseInput: string, index: number): SealKeyPair {
  if (!Number.isInteger(index) || index < 1 || index > 0x7fffffff) {
    throw new MizuhikiError("INVALID_INPUT", "scoped key index must be a positive integer");
  }
  return deriveSealKeys({ mnemonic: normalizePhrase(phraseInput), index });
}

/** Period key index: one per calendar quarter, from 1,000,000 up, so it never meets other scoped indexes. */
export function periodIndex(year: number, quarter: 1 | 2 | 3 | 4): number {
  if (!Number.isInteger(year) || year < 2000 || year > 2999)
    throw new MizuhikiError("INVALID_INPUT", "year out of range");
  return 1_000_000 + (year - 2000) * 4 + (quarter - 1);
}

/** Offline recovery reader, a fixed index. */
export const RECOVERY_READER_INDEX = 1;

export function publicRecipient(keys: SealKeyPair): SealRecipient {
  return recipientOf(keys);
}

/** Pick `count` distinct word positions for the retype check (1-based in the UI). */
export function pickCheckPositions(count: number, total: number = PHRASE_WORDS): number[] {
  const picked = new Set<number>();
  if (count > total) throw new MizuhikiError("INVALID_INPUT", "cannot pick more positions than words");
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / total) * total; // rejection sampling: no modulo bias
  while (picked.size < count) {
    globalThis.crypto.getRandomValues(buf);
    const v = buf[0] ?? 0;
    if (v < limit) picked.add(v % total);
  }
  return [...picked].sort((a, b) => a - b);
}
