import { describe, expect, it } from "vitest";
import { generateSealKeys } from "@qorechain/qoreseal";
import { combinePhrase, keyWords, newPhrase, randomBytes, seedToWords, splitPhrase, wordsToSeed } from "../src";

describe("recovery words and pieces", () => {
  it("six words per key: stable for a key, different between keys", () => {
    const a = generateSealKeys();
    const b = generateSealKeys();
    expect(keyWords(a).split(" ")).toHaveLength(6);
    expect(keyWords(a)).toBe(keyWords({ mlkemPublicKey: a.mlkemPublicKey, x25519PublicKey: a.x25519PublicKey }));
    expect(keyWords(a)).not.toBe(keyWords(b));
  });

  it("an offline key round-trips through its 24 words; wrong words are refused plainly", () => {
    const seed = randomBytes(32);
    const words = seedToWords(seed);
    expect(words.split(" ")).toHaveLength(24);
    expect(Array.from(wordsToSeed(`  ${words.toUpperCase()}  `))).toEqual(Array.from(seed));
    expect(() => wordsToSeed(newPhrase().split(" ").reverse().join(" "))).toThrow(/not an offline key/);
    expect(() => wordsToSeed(newPhrase(12))).toThrow(/not an offline key/);
  });

  it("any 2 of 3 pieces rebuild the phrase; one does not", async () => {
    const phrase = newPhrase();
    const { shares } = await splitPhrase(phrase, 3, 2);
    const [a, b, c] = shares as [Uint8Array, Uint8Array, Uint8Array];
    expect(await combinePhrase([a, c], 2)).toBe(phrase);
    expect(await combinePhrase([b, c], 2)).toBe(phrase);
    await expect(combinePhrase([a], 2)).rejects.toThrow();
  });
});
