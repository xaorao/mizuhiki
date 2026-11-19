/**
 * Live contract tests on QoreChain testnet with real ML-DSA-87 signatures:
 * the happy path and the attacks (bad signature, replay, wrong signer, wrong
 * contract, classical key alone, out-of-scope target). Prints tx hashes as proof.
 */
import { randomBytes, toHex as hexOf } from "@mizuhiki/core";
import {
  Action,
  CONTRACTS,
  capsuleVaultAbi,
  closeWindow,
  ensureKeys,
  mizuhikiRegistryAbi,
  nameHash,
  openWindow,
  publicClient,
  signAction,
  walletFor,
  writeContract,
  isChainError,
  bytes32Text,
} from "@mizuhiki/chain";
import { keccak256, encodeAbiParameters, toHex, type Hex } from "viem";
import { pqSign } from "@qorechain/qoresign";
import { fundedPersona, type Persona } from "./devwallet";

const results: { name: string; ok: boolean; detail: string }[] = [];
const pass = (name: string, detail: string) => (
  results.push({ name, ok: true, detail }),
  console.log("PASS", name, detail)
);
const fail = (name: string, detail: string) => (
  results.push({ name, ok: false, detail }),
  console.log("FAIL", name, detail)
);
async function expectRevert(name: string, errorName: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    fail(name, "was accepted");
  } catch (e) {
    const d = isChainError(e) ? `${e.code} ${e.detail ?? ""}` : String(e);
    if (d.includes(errorName)) pass(name, `refused: ${errorName}`);
    else fail(name, `refused for another reason: ${d.slice(0, 200)}`);
  }
}

const pub = publicClient();
const reg = { address: CONTRACTS.registry, abi: mizuhikiRegistryAbi } as const;

async function setUp(label: string): Promise<Persona> {
  const p = await fundedPersona(label, 4n);
  await ensureKeys(p, p.seal, { onStep: (s, r) => console.log(`  ${label} ${s}:`, r === "already" ? r : r.txHash) });
  return p;
}

const aria = await setUp("aria");
const mallory = await setUp("mallory");
const status = await pub.readContract({
  address: "0x0000000000000000000000000000000000000a02",
  abi: [
    {
      type: "function",
      name: "pqcKeyStatus",
      stateMutability: "view",
      inputs: [{ type: "address" }],
      outputs: [{ type: "bool" }, { type: "uint8" }, { type: "bytes" }, { type: "bool" }],
    },
  ] as const,
  functionName: "pqcKeyStatus",
  args: [aria.evm],
});
status[0] && status[3]
  ? pass("possession proven on chain", `alg ${status[1]}`)
  : fail("possession proven on chain", `registered ${status[0]} proven ${status[3]}`);

// classical key alone: no window -> the chain refuses the EVM transaction
try {
  // explicit gas so the refusal comes from the chain's admission check, not from gas estimation
  await walletFor(aria).sendTransaction({ to: aria.evm, value: 1n, gas: 21_000n } as never);
  fail("classical key alone (no window)", "admitted");
} catch (e) {
  const m = (e as { details?: string }).details ?? (e as Error).message;
  /window/i.test(m)
    ? pass("classical key alone (no window)", m.split("\n")[0]?.slice(0, 160) ?? "")
    : fail("classical key alone (no window)", m.slice(0, 300));
}

for (const p of [aria, mallory]) {
  const { result } = await openWindow(p, {
    minutes: 30,
    maxTxs: 12,
    maxValueUqor: 2_000_000_000n,
    targets: [CONTRACTS.registry, CONTRACTS.vault],
  });
  console.log(`  ${p.label} window: ${result.txHash}`);
}

// out-of-scope target inside a scoped window
try {
  await walletFor(aria).sendTransaction({ to: mallory.evm, value: 1n, gas: 21_000n } as never);
  fail("scoped window refuses other targets", "admitted");
} catch (e) {
  const m = (e as { details?: string }).details ?? (e as Error).message;
  /target|allowed|window/i.test(m)
    ? pass("scoped window refuses other targets", m.split("\n")[0]?.slice(0, 160) ?? "")
    : fail("scoped window refuses other targets", m.slice(0, 300));
}

const name = `aria${hexOf(randomBytes(3))}`;
const secret = toHex(randomBytes(32));
const card = keccak256(toHex("card-v1"));
const commitment = keccak256(
  encodeAbiParameters([{ type: "string" }, { type: "address" }, { type: "bytes32" }], [name, aria.evm, secret]),
);
const c = await writeContract(aria, { ...reg, functionName: "commit", args: [commitment] });
console.log("  commit", c.txHash);
await new Promise((r) => setTimeout(r, 3000));

// mallory front-runs with aria's name and her own valid signature, no commitment
const malSig = await signAction(
  mallory,
  CONTRACTS.registry,
  mizuhikiRegistryAbi,
  Action.register(nameHash(name), card),
);
await expectRevert("front-runner without commitment", "NoCommitment", () =>
  writeContract(mallory, { ...reg, functionName: "register", args: [mallory.evm, name, card, secret, malSig] }),
);

// mallory signs for aria (wrong signer)
const forged = await (async () => {
  const nonce = await pub.readContract({ ...reg, functionName: "nonceOf", args: [aria.evm] });
  const { localDigest } = await import("@mizuhiki/chain");
  return toHex(
    pqSign(
      mallory.pq.secretKey,
      Buffer.from(
        localDigest(CONTRACTS.registry, aria.evm, nonce, Action.register(nameHash(name), card)).slice(2),
        "hex",
      ),
    ),
  );
})();
await expectRevert("wrong signer (mallory signs for aria)", "BadSignature", () =>
  writeContract(mallory, { ...reg, functionName: "register", args: [aria.evm, name, card, secret, forged] }),
);

// a garbage signature
await expectRevert("bad signature bytes", "BadSignature", () =>
  writeContract(aria, {
    ...reg,
    functionName: "register",
    args: [aria.evm, name, card, secret, toHex(randomBytes(4627))],
  }),
);

// signature for a different action
const otherSig = await signAction(
  aria,
  CONTRACTS.registry,
  mizuhikiRegistryAbi,
  Action.register(nameHash(name + "x"), card),
);
await expectRevert("signature for another action", "BadSignature", () =>
  writeContract(aria, { ...reg, functionName: "register", args: [aria.evm, name, card, secret, otherSig] }),
);

// happy path, relayed by mallory: anyone may relay, authority is the PQ signature
const goodSig = await signAction(aria, CONTRACTS.registry, mizuhikiRegistryAbi, Action.register(nameHash(name), card));
const r = await writeContract(mallory, {
  ...reg,
  functionName: "register",
  args: [aria.evm, name, card, secret, goodSig],
});
const [owner, cardBack] = (await pub.readContract({ ...reg, functionName: "resolve", args: [name] })) as [Hex, Hex];
owner.toLowerCase() === aria.evm.toLowerCase() && cardBack === card
  ? pass("register relayed by another account", `${name} ${r.txHash} gas ${r.gasUsed}`)
  : fail("register", owner);

// replay of the same signature
await expectRevert("replay of a used signature", "BadSignature", () =>
  writeContract(aria, { ...reg, functionName: "setCard", args: [aria.evm, card, goodSig] }),
);

// anchor, then the same anchor again
const doc = keccak256(toHex(`doc-${Date.now()}`));
const a1 = await writeContract(aria, {
  ...reg,
  functionName: "anchor",
  args: [
    aria.evm,
    doc,
    bytes32Text("file"),
    await signAction(aria, CONTRACTS.registry, mizuhikiRegistryAbi, Action.anchor(doc, bytes32Text("file"))),
  ],
});
pass("anchor", a1.txHash);
await expectRevert("anchor twice", "AlreadyAnchored", async () =>
  writeContract(mallory, {
    ...reg,
    functionName: "anchor",
    args: [
      mallory.evm,
      doc,
      bytes32Text("file"),
      await signAction(mallory, CONTRACTS.registry, mizuhikiRegistryAbi, Action.anchor(doc, bytes32Text("file"))),
    ],
  }),
);

// signature made for the registry, sent to the vault (cross-contract replay)
const crossSig = await signAction(aria, CONTRACTS.registry, mizuhikiRegistryAbi, Action.checkIn());
await expectRevert("cross-contract replay", "BadSignature", () =>
  writeContract(aria, {
    address: CONTRACTS.vault,
    abi: capsuleVaultAbi,
    functionName: "checkIn",
    args: [aria.evm, crossSig],
  }),
);
const ci = await writeContract(mallory, {
  address: CONTRACTS.vault,
  abi: capsuleVaultAbi,
  functionName: "checkIn",
  args: [aria.evm, await signAction(aria, CONTRACTS.vault, capsuleVaultAbi, Action.checkIn())],
});
pass("vault check-in relayed", ci.txHash);

for (const p of [aria, mallory]) await closeWindow(p);
const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
