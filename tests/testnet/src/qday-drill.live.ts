/**
 * Q-Day Drill rehearsal on QoreChain testnet, following the fest's drill rules (QORECHAIN_COMPETITION.md): an
 * attacker has recovered the classical ECDSA key of a fresh account that registered an ML-DSA-87 key, and tries
 * everything that key alone can do: native transfers, opening an EVM window, EVM transfers, token approvals, and
 * drain calls on Mizuhiki's contracts. Each attack runs twice: with no EVM window open, and during a live window
 * opened by the owner the way the app does (our contracts only, a transaction cap). Then the owner makes a normal
 * transaction to show the account still works. Every attempt and its outcome is printed with its hash or refusal.
 *
 * Usage: pnpm --filter @mizuhiki/testnet drill   (testnet only; funds a disposable account from the dev wallet)
 */
import { erc20Abi, parseUnits, type Address } from "viem";
import { utf8, sha256Hex } from "@mizuhiki/core";
import {
  Action,
  CONTRACTS,
  DENOMS,
  anchorBookAbi,
  capsuleVaultAbi,
  closeWindow,
  ensureKeys,
  isChainError,
  mizuhikiRegistryAbi,
  msgSend,
  nameHash,
  openWindow,
  publicClient,
  readWindow,
  sendTx,
  signAction,
  walletFor,
} from "@mizuhiki/chain";
import { fundedPersona, persona } from "./devwallet";
import { newPhrase } from "@mizuhiki/core";

type Row = { phase: string; attack: string; held: boolean; detail: string };
const rows: Row[] = [];
const pub = publicClient();
const FUSD = DENOMS.fUSD.denom.slice("erc20:".length) as Address;

/** An attack must fail: `held` is true when the chain or a contract refused it and nothing moved. */
async function attack(phase: string, name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const hash = await fn();
    // Broadcast and committed: acceptable only if the receipt says a contract reverted it.
    if (hash.startsWith("0x")) {
      const r = await pub.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 90_000 });
      rows.push(
        r.status === "reverted"
          ? {
              phase,
              attack: name,
              held: true,
              detail: `broadcast, reverted by the contract in block ${r.blockNumber} (${hash})`,
            }
          : { phase, attack: name, held: false, detail: `WENT THROUGH in block ${r.blockNumber} (${hash})` },
      );
    } else rows.push({ phase, attack: name, held: false, detail: `WENT THROUGH: ${hash}` });
  } catch (e) {
    rows.push({ phase, attack: name, held: true, detail: `refused by QoreChain: ${reason(e)}` });
  }
}

/** The deepest message in an error chain: the chain's own words, not the client library's summary. */
function reason(e: unknown): string {
  if (isChainError(e)) return (e.detail ?? e.message).replace(/\s+/g, " ").slice(0, 200);
  let x: unknown = e;
  let last = "";
  while (x) {
    const o = x as { details?: string; shortMessage?: string; message?: string; cause?: unknown };
    last = o.details ?? o.shortMessage ?? o.message ?? last;
    x = o.cause;
  }
  return last
    .replace(/ \[cosmossdk[^\]]*\]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

// ---- the drill account: fresh, funded with test QOR, ML-DSA-87 and ML-KEM keys registered ------------------
const owner = await fundedPersona("qday-drill", 3n);
await ensureKeys(owner, owner.seal, { onStep: (s, r) => console.log(`setup ${s}:`, r === "already" ? r : r.txHash) });
console.log(`drill account ${owner.address} (${owner.evm})`);

// The attacker holds the classical key and nothing else: the ML-DSA-87 key is replaced by an unrelated one.
const stranger = persona(newPhrase(), "not-the-owner");
const attacker = { ...owner, pq: stranger.pq, label: "attacker" } as typeof owner;
const sink = stranger.address;
const sinkEvm = stranger.evm;
const name = `qday${Date.now().toString(36)}`;

async function attacks(phase: string): Promise<void> {
  await attack(
    phase,
    "native transfer, classical signature only",
    async () =>
      (
        await sendTx(attacker, [msgSend(owner.address, sink, DENOMS.QOR.denom, 1_000_000n)], "drill", {
          mode: "classicalOnly",
        })
      ).txHash,
  );
  await attack(
    phase,
    "native transfer, hybrid with a forged ML-DSA-87 key",
    async () => (await sendTx(attacker, [msgSend(owner.address, sink, DENOMS.QOR.denom, 1_000_000n)], "drill")).txHash,
  );
  await attack(
    phase,
    "open an EVM window, classical signature only",
    async () =>
      (
        await openWindow(
          attacker,
          { minutes: 60, maxTxs: 50, maxValueUqor: 2_000_000n, targets: [] },
          { mode: "classicalOnly" },
        )
      ).result.txHash,
  );
  await attack(phase, "EVM transfer of QOR to the attacker", async () =>
    walletFor(attacker).sendTransaction({ to: sinkEvm, value: parseUnits("0.5", 18), gas: 21_000n } as never),
  );
  await attack(phase, "ERC-20 approval of fUSD to the attacker", async () =>
    walletFor(attacker).writeContract({
      address: FUSD,
      abi: erc20Abi,
      functionName: "approve",
      args: [sinkEvm, 2n ** 255n],
      gas: 80_000n,
    } as never),
  );
  const forged = await signAction(
    attacker,
    CONTRACTS.registry,
    mizuhikiRegistryAbi,
    Action.releaseName(nameHash(name)),
  );
  await attack(phase, "drain call: MizuhikiRegistry.releaseName with a signature from another key", async () =>
    walletFor(attacker).writeContract({
      address: CONTRACTS.registry,
      abi: mizuhikiRegistryAbi,
      functionName: "releaseName",
      args: [owner.evm, name, forged],
      gas: 600_000n,
    } as never),
  );
  await attack(phase, "drain call: AnchorBook.anchor in the owner's name", async () =>
    walletFor(attacker).writeContract({
      address: CONTRACTS.anchorBook,
      abi: anchorBookAbi,
      functionName: "anchor",
      args: [owner.evm, `0x${sha256Hex(utf8(phase))}`, `0x${"00".repeat(32)}`, forged],
      gas: 600_000n,
    } as never),
  );
  await attack(phase, "drain call: CapsuleVault.checkIn in the owner's name", async () =>
    walletFor(attacker).writeContract({
      address: CONTRACTS.vault,
      abi: capsuleVaultAbi,
      functionName: "checkIn",
      args: [owner.evm, forged],
      gas: 600_000n,
    } as never),
  );
}

// ---- phase 1: no window open --------------------------------------------------------------------------------
const before = await readWindow(owner.address).catch(() => null);
if (before?.live) await closeWindow(owner);
await attacks("no window");

// ---- phase 2: a live window opened by the owner, as the app does during a session ----------------------------
const opened = await openWindow(owner, {
  minutes: 30,
  maxTxs: 20,
  maxValueUqor: 400_000n,
  targets: [CONTRACTS.registry, CONTRACTS.vault, CONTRACTS.anchorBook],
});
console.log(`owner opened a window: ${opened.result.txHash}`);
await attacks("live window");
await closeWindow(owner);

// ---- the account still works: a normal hybrid transaction by the owner --------------------------------------
const normal = await sendTx(owner, [msgSend(owner.address, owner.address, DENOMS.QOR.denom, 1n)], "drill: normal use");

// ---- balance check: nothing left the account except network fees --------------------------------------------
const sinkBalance = await pub.getBalance({ address: sinkEvm });

console.log("\nQ-Day Drill rehearsal");
for (const r of rows) console.log(`${r.held ? "HELD " : "FAIL "} [${r.phase}] ${r.attack} -> ${r.detail}`);
console.log(`normal transaction by the owner: ${normal.txHash}`);
console.log(`attacker address balance after all attempts: ${sinkBalance} wei`);
const failed = rows.filter((r) => !r.held).length + (sinkBalance > 0n ? 1 : 0);
console.log(failed === 0 ? `\nall ${rows.length} attacks held` : `\n${failed} attack(s) got through`);
process.exit(failed === 0 ? 0 : 1);
