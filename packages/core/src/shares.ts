/**
 * Spare key and capsule shares: Shamir secret sharing over GF(256) with the
 * audited `shamir-secret-sharing` library (Privy; Cure53 and Zellic reviews).
 * Phrases are split as their BIP-39 entropy, so a share reveals nothing about
 * any word.
 */
import { combine, split } from "shamir-secret-sharing";
import { entropyToMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MizuhikiError } from "./errors";
import { normalizePhrase } from "./account";

export interface ShareSet {
  threshold: number;
  shares: Uint8Array[];
}

export async function splitSecret(secret: Uint8Array, shares: number, threshold: number): Promise<ShareSet> {
  if (!Number.isInteger(threshold) || threshold < 2 || threshold > shares || shares > 255) {
    throw new MizuhikiError(
      "INVALID_INPUT",
      "Choose at least 2 helpers needed, and no more than the number of helpers.",
    );
  }
  return { threshold, shares: await split(secret, shares, threshold) };
}

export async function combineShares(parts: Uint8Array[], threshold: number): Promise<Uint8Array> {
  if (parts.length < threshold) {
    throw new MizuhikiError(
      "SHARES_INSUFFICIENT",
      `${threshold} helpers are needed; ${parts.length} have answered so far.`,
    );
  }
  try {
    return await combine(parts);
  } catch (e) {
    throw new MizuhikiError("SHARES_INSUFFICIENT", "These pieces do not fit together.", { cause: e });
  }
}

export async function splitPhrase(phrase: string, shares: number, threshold: number): Promise<ShareSet> {
  return splitSecret(mnemonicToEntropy(normalizePhrase(phrase), wordlist), shares, threshold);
}

export async function combinePhrase(parts: Uint8Array[], threshold: number): Promise<string> {
  const entropy = await combineShares(parts, threshold);
  try {
    return entropyToMnemonic(entropy, wordlist);
  } catch (e) {
    throw new MizuhikiError("SHARES_INSUFFICIENT", "These pieces do not rebuild a phrase.", { cause: e });
  }
}
