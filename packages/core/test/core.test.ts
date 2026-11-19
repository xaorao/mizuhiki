import { describe, expect, it } from "vitest";
import { generateSealKeys, recipientOf, signRecipientCard } from "@qorechain/qoreseal";
import {
  answerProblem,
  conditionHolds,
  nextAfter,
  pickHint,
  recall,
  type FormDef,
  type Question,
  sha256File,
  sha256Hex,
  CHUNK_SIZE,
  Purpose,
  canonicalJson,
  checkPow,
  combinePhrase,
  createVault,
  decryptFile,
  deriveAccount,
  deriveScopedSealKey,
  encryptFile,
  envelopeFacts,
  isMizuhikiError,
  isValidPhrase,
  newPhrase,
  openItem,
  parseFileFacts,
  periodIndex,
  pickCheckPositions,
  recipientFromCard,
  sealItem,
  signRecord,
  solvePow,
  splitPhrase,
  unlockWithPassphrase,
  utf8,
  fromUtf8,
  verifyRecord,
  type EncryptedChunk,
} from "../src/index";

const PHRASE = newPhrase();
const owner = deriveAccount(PHRASE);

describe("account", () => {
  it("makes a valid 24-word phrase and derives one eth_secp256k1 account", () => {
    expect(PHRASE.split(" ")).toHaveLength(24);
    expect(isValidPhrase(PHRASE)).toBe(true);
    expect(owner.address.bech32).toMatch(/^qor1/);
    expect(owner.address.hex).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(owner.classical.type).toBe("eth_secp256k1");
    const again = deriveAccount(`  ${PHRASE.toUpperCase()}  `);
    expect(again.address.bech32).toBe(owner.address.bech32);
    expect(again.pq.publicKey).toEqual(owner.pq.publicKey);
  });
  it("refuses a phrase with a wrong checksum or wrong length", () => {
    const words = PHRASE.split(" ");
    const swapped = [...words.slice(0, 23), words[0] === "abandon" ? "zoo" : "abandon"].join(" ");
    expect(() => deriveAccount(swapped)).toThrow(/not valid/);
    expect(() => deriveAccount(words.slice(0, 20).join(" "))).toThrow(/not valid/);
  });
  it("keeps period keys distinct and refuses index 0", () => {
    expect(() => deriveScopedSealKey(PHRASE, 0)).toThrow();
    const q3 = deriveScopedSealKey(PHRASE, periodIndex(2026, 3));
    const q4 = deriveScopedSealKey(PHRASE, periodIndex(2026, 4));
    expect(q3.mlkemPublicKey).not.toEqual(q4.mlkemPublicKey);
    expect(q3.mlkemPublicKey).not.toEqual(owner.seal.mlkemPublicKey);
  });
  it("picks distinct check positions", () => {
    for (let i = 0; i < 50; i++) {
      const p = pickCheckPositions(3);
      expect(new Set(p).size).toBe(3);
      expect(p.every((x) => x >= 0 && x < 24)).toBe(true);
    }
  });
});

describe("sealing", () => {
  const me = recipientOf(owner.seal);
  it("seals to the owner and opens only for the owner", () => {
    const s = sealItem({ purpose: Purpose.message, readers: [me], plaintext: utf8("contract attached") });
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(envelopeFacts(s.envelope)).toMatchObject({ readers: 1, anonymous: true });
    expect(fromUtf8(openItem({ purpose: Purpose.message, envelope: s.envelope, keys: owner.seal }))).toBe(
      "contract attached",
    );
    const outsider = generateSealKeys();
    try {
      openItem({ purpose: Purpose.message, envelope: s.envelope, keys: outsider });
      expect.unreachable();
    } catch (e) {
      expect(isMizuhikiError(e, "NOT_A_READER")).toBe(true);
    }
  });
  it("binds purpose and context", () => {
    const s = sealItem({ purpose: Purpose.invoice("0007"), readers: [me], plaintext: utf8("x"), context: "INV-0007" });
    expect(() =>
      openItem({ purpose: Purpose.invoice("0008"), envelope: s.envelope, keys: owner.seal, context: "INV-0007" }),
    ).toThrow();
    expect(() =>
      openItem({ purpose: Purpose.invoice("0007"), envelope: s.envelope, keys: owner.seal, context: "INV-0008" }),
    ).toThrow();
    expect(
      fromUtf8(
        openItem({ purpose: Purpose.invoice("0007"), envelope: s.envelope, keys: owner.seal, context: "INV-0007" }),
      ),
    ).toBe("x");
  });
  it("detects a flipped byte", () => {
    const s = sealItem({ purpose: Purpose.message, readers: [me], plaintext: utf8("hello") });
    const bad = Uint8Array.from(s.envelope);
    bad[bad.length - 3] = (bad[bad.length - 3] ?? 0) ^ 1;
    expect(() => openItem({ purpose: Purpose.message, envelope: bad, keys: owner.seal })).toThrow();
  });
  it("a period reader opens only its own period", () => {
    const q3 = deriveScopedSealKey(PHRASE, periodIndex(2026, 3));
    const q4 = deriveScopedSealKey(PHRASE, periodIndex(2026, 4));
    const s = sealItem({
      purpose: Purpose.invoice("9"),
      readers: [me, recipientOf(q3)],
      plaintext: utf8("Q3"),
      context: "INV-9",
    });
    expect(
      fromUtf8(openItem({ purpose: Purpose.invoice("9"), envelope: s.envelope, keys: q3, context: "INV-9" })),
    ).toBe("Q3");
    expect(() =>
      openItem({ purpose: Purpose.invoice("9"), envelope: s.envelope, keys: q4, context: "INV-9" }),
    ).toThrow();
  });
  it("rejects bad purposes", () => {
    expect(() => Purpose.form("has space")).toThrow();
    expect(() => Purpose.room("")).toThrow();
  });
});

describe("recipient card", () => {
  it("accepts a card that matches the chain keys and refuses a forged one", () => {
    const card = signRecipientCard({
      chainId: "qorechain-diana",
      address: owner.address.bech32,
      keys: owner.seal,
      classicalKey: owner.classical,
      pqKey: owner.pq,
    });
    const r = recipientFromCard({
      card,
      address: owner.address.bech32,
      pqPublicKey: owner.pq.publicKey,
      mlkemPublicKey: owner.seal.mlkemPublicKey,
    });
    expect(r.x25519PublicKey).toEqual(owner.seal.x25519PublicKey);
    const attacker = generateSealKeys();
    const forged = { ...card, x25519PublicKey: Buffer.from(attacker.x25519PublicKey).toString("hex") };
    expect(() =>
      recipientFromCard({
        card: forged,
        address: owner.address.bech32,
        pqPublicKey: owner.pq.publicKey,
        mlkemPublicKey: owner.seal.mlkemPublicKey,
      }),
    ).toThrow(/does not match/);
    expect(() =>
      recipientFromCard({
        card,
        address: owner.address.bech32,
        pqPublicKey: owner.pq.publicKey,
        mlkemPublicKey: attacker.mlkemPublicKey,
      }),
    ).toThrow();
  });
});

describe("sha256File", () => {
  it("matches a one-shot SHA-256 across slice boundaries, and the empty file", async () => {
    const data = new Uint8Array(9 * 1024 * 1024 + 7);
    for (let i = 0; i < data.length; i += 65536)
      crypto.getRandomValues(data.subarray(i, Math.min(data.length, i + 65536)));
    const steps: number[] = [];
    const h = await sha256File(new Blob([data]), (d) => steps.push(d));
    expect(h).toBe(sha256Hex(data));
    expect(steps.at(-1)).toBe(data.length);
    expect(await sha256File(new Blob([]))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("files", () => {
  async function roundTrip(size: number) {
    const data = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536) crypto.getRandomValues(data.subarray(i, Math.min(size, i + 65536)));
    const store = new Map<string, Uint8Array>();
    const facts = await encryptFile({
      source: data,
      name: "contract.pdf",
      type: "application/pdf",
      onChunk: (c: EncryptedChunk) => {
        store.set(c.hash, c.bytes);
        return Promise.resolve();
      },
    });
    const parsed = parseFileFacts(utf8(JSON.stringify(facts)));
    const parts = await decryptFile({
      facts: parsed,
      fetchChunk: (h) => Promise.resolve(store.get(h) ?? new Uint8Array()),
    });
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    return { data, out, facts, store };
  }
  it("round-trips empty, small and multi-chunk files", async () => {
    for (const size of [0, 1, 1000, CHUNK_SIZE, CHUNK_SIZE + 7, 3 * CHUNK_SIZE - 1]) {
      const { data, out, facts } = await roundTrip(size);
      expect(out).toEqual(data);
      expect(facts.chunks).toHaveLength(Math.max(1, Math.ceil(size / CHUNK_SIZE)));
    }
  });
  it("refuses a tampered, swapped or truncated chunk", async () => {
    const { facts, store } = await roundTrip(2 * CHUNK_SIZE + 10);
    const [a, b] = facts.chunks;
    const swapped = { ...facts, chunks: [b ?? "", a ?? "", facts.chunks[2] ?? ""] };
    await expect(
      decryptFile({ facts: swapped, fetchChunk: (h) => Promise.resolve(store.get(h) ?? new Uint8Array()) }),
    ).rejects.toThrow();
    await expect(
      decryptFile({
        facts,
        fetchChunk: (h) => {
          const c = Uint8Array.from(store.get(h) ?? []);
          c[5] = (c[5] ?? 0) ^ 1;
          return Promise.resolve(c);
        },
      }),
    ).rejects.toThrow(/changed in storage/);
    const truncated = { ...facts, chunks: facts.chunks.slice(0, 2) };
    expect(() => parseFileFacts(utf8(JSON.stringify(truncated)))).toThrow();
  });
  it("enforces the size limit before anything is encrypted", async () => {
    let called = false;
    await expect(
      encryptFile({
        source: new Uint8Array(100),
        name: "a",
        type: "",
        maxBytes: 10,
        onChunk: () => {
          called = true;
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow(/larger than the limit/);
    expect(called).toBe(false);
  });
});

describe("vault", () => {
  it("unlocks with the right passphrase only", async () => {
    const v = await createVault({
      address: owner.address.bech32,
      phrase: PHRASE,
      passphrase: "lantern-river-maple",
      iterations: 1000,
    });
    expect(JSON.stringify(v)).not.toContain(`${PHRASE.split(" ")[0] ?? ""} `);
    expect(await unlockWithPassphrase(v, "lantern-river-maple")).toBe(PHRASE);
    await expect(unlockWithPassphrase(v, "lantern-river-mapl")).rejects.toThrow(/did not unlock/);
  });
  it("refuses a weak passphrase", async () => {
    await expect(createVault({ address: "x", phrase: PHRASE, passphrase: "short" })).rejects.toThrow(/10 characters/);
  });
});

describe("shares", () => {
  it("any 2 of 3 rebuild the phrase; 1 does not", async () => {
    const s = await splitPhrase(PHRASE, 3, 2);
    expect(await combinePhrase([s.shares[0]!, s.shares[2]!], 2)).toBe(PHRASE);
    expect(await combinePhrase([s.shares[1]!, s.shares[0]!], 2)).toBe(PHRASE);
    await expect(combinePhrase([s.shares[1]!], 2)).rejects.toThrow(/2 helpers are needed/);
  });
});

describe("proof of work", () => {
  it("is bound to recipient, envelope and minute", () => {
    const now = Date.now();
    const st = solvePow("qor1abc", "ab".repeat(32), 12, now);
    expect(checkPow(st, "qor1abc", "ab".repeat(32), 12, now)).toBe(true);
    expect(checkPow(st, "qor1abd", "ab".repeat(32), 12, now)).toBe(false);
    expect(checkPow(st, "qor1abc", "cd".repeat(32), 12, now)).toBe(false);
    expect(checkPow(st, "qor1abc", "ab".repeat(32), 12, now + 4 * 60_000)).toBe(false);
  });
});

describe("signed records", () => {
  it("verifies against the owner's key and refuses changes or another key", () => {
    const rec = signRecord({
      kind: "manifest",
      body: { name: "aria", blocks: [{ id: "b1", on: true }] },
      signer: owner.address.bech32,
      classical: owner.classical,
      pq: owner.pq,
    });
    expect(
      verifyRecord(rec, { kind: "manifest", signer: owner.address.bech32, pqPublicKey: owner.pq.publicKey }),
    ).toEqual(rec.body);
    const changed = { ...rec, body: { ...rec.body, name: "mallory" } };
    expect(() => verifyRecord(changed, { kind: "manifest", pqPublicKey: owner.pq.publicKey })).toThrow();
    const other = deriveAccount(newPhrase());
    expect(() => verifyRecord(rec, { kind: "manifest", pqPublicKey: other.pq.publicKey })).toThrow();
    expect(() => verifyRecord(rec, { kind: "sender", pqPublicKey: owner.pq.publicKey })).toThrow();
  });
  it("canonical JSON ignores key order", () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(canonicalJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
  });
});

describe("forms: logic, recall, validation", () => {
  const def = {
    blocks: [
      {
        id: "name",
        kind: "short",
        title: "Name",
        description: "",
        required: true,
        hidden: false,
        half: false,
        placeholder: "",
      },
      {
        id: "score",
        kind: "scale",
        title: "How was it, {{name}}?",
        description: "",
        required: true,
        hidden: false,
        half: false,
        from: 0,
        to: 5,
        left: "",
        center: "",
        right: "",
      },
      {
        id: "why",
        kind: "long",
        title: "Sorry to hear that. Why?",
        description: "",
        required: false,
        hidden: false,
        half: false,
        placeholder: "",
        maxChars: 10,
      },
      {
        id: "pick",
        kind: "checkboxes",
        title: "Pick",
        description: "",
        required: true,
        hidden: false,
        half: false,
        choices: [
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
          { id: "c", label: "Gamma" },
        ],
        other: false,
        none: false,
        randomize: false,
        minPick: 1,
        maxPick: 2,
      },
    ],
    logic: [
      {
        after: "score",
        rules: [{ when: [{ q: "score", op: "lt" as const, value: "3" }], to: "why" }],
        otherwise: "end-happy",
      },
    ],
  } satisfies Pick<FormDef, "blocks" | "logic">;

  it("branches by rule, falls back to all other cases, and goes on in order without logic", () => {
    expect(nextAfter(def, "score", { score: 2 })).toBe("why");
    expect(nextAfter(def, "score", { score: 5 })).toBe("end-happy");
    expect(nextAfter(def, "name", { name: "Rohan" })).toBe("");
    expect(conditionHolds(def, { q: "pick", op: "is", value: "b" }, { pick: ["a", "b"] })).toBe(true);
    expect(conditionHolds(def, { q: "pick", op: "contains", value: "gam" }, { pick: ["c"] })).toBe(true);
    expect(conditionHolds(def, { q: "name", op: "not_answered", value: "" }, {})).toBe(true);
  });

  it("recalls earlier answers by label", () => {
    expect(recall("How was it, {{name}}?", def, { name: "Rohan" })).toBe("How was it, Rohan?");
    expect(recall("You picked {{pick}}", def, { pick: ["a", "c"] })).toBe("You picked Alpha, Gamma");
    expect(recall("Hi {{missing}}!", def, {})).toBe("Hi !");
  });

  it("explains every invalid answer the way Typeform does", () => {
    const q = (id: string) => def.blocks.find((b) => b.id === id) as Question;
    expect(answerProblem(q("name"), "")).toBe("Please fill this in");
    expect(answerProblem(q("why"), "")).toBeNull();
    expect(answerProblem(q("why"), "far too long here")).toBe("Please keep it under 10 characters");
    expect(answerProblem(q("pick"), ["a", "b", "c"])).toBe("Make between 1 and 2 choices");
    expect(pickHint(q("pick"))).toBe("Make between 1 and 2 choices");
    const email = { ...q("name"), kind: "email" } as Question;
    expect(answerProblem(email, "a@b")).toBe("Hmm, that email doesn't look right");
    expect(answerProblem(email, "a@b.co")).toBeNull();
    const wallet = { ...q("name"), kind: "wallet" } as Question;
    expect(answerProblem(wallet, "0x1234")).toBe("That is not a QoreChain address (qor1…)");
    const file = {
      id: "f",
      kind: "file",
      title: "CV",
      description: "",
      required: true,
      hidden: false,
      half: false,
      maxFiles: 1,
      maxMB: 5,
    } as Question;
    expect(answerProblem(file, null, 0)).toBe("Please fill this in");
    expect(answerProblem(file, null, 1)).toBeNull();
  });
});
