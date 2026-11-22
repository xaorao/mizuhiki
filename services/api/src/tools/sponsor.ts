/**
 * One-time setup of the starter-grant sponsor (ARCHITECTURE 8h) on testnet: a phrase appended to
 * services/api/.env.local (git-ignored, mode 600), its ML-DSA key registered so its sends carry the hybrid signature,
 * and test QOR to give out. Prints the sponsor's address and balance, never the phrase. Run again to top it up.
 * Usage: pnpm --filter @mizuhiki/api sponsor:provision [QOR to add, default 30]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { DENOMS, balanceOf, ensureKeys, fromBaseUnits, msgSend, sendTx } from "@mizuhiki/chain";
import { deriveAccount, newPhrase } from "@mizuhiki/core";

const file = new URL("../../.env.local", import.meta.url);
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
let phrase = /^SPONSOR_PHRASE="?([^"\n]+)"?/m.exec(text)?.[1];
if (!phrase) {
  phrase = newPhrase(24);
  appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}SPONSOR_PHRASE="${phrase}"\n`, { mode: 0o600 });
}
const a = deriveAccount(phrase);
const signer = { address: a.address.bech32, classical: a.classical, pq: a.pq };
console.log(`sponsor address: ${signer.address}`);

const add = BigInt(Math.round(Number(process.argv[2] ?? "30") * 1_000_000));
// Testnet only: funded from the developer's own testnet wallet, whose phrase is read here and never printed.
const devFile = `${homedir()}/.secrets/qorechain/testnet-wallet.env`;
if (add > 0n) {
  if (!existsSync(devFile)) {
    console.error(`Send test QOR to ${signer.address} to give out, then run this again with 0.`);
    process.exit(1);
  }
  const env = Object.fromEntries(
    readFileSync(devFile, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).replace(/^"|"$/g, "")]),
  ) as Record<string, string | undefined>;
  const m = env["QORE_MNEMONIC"];
  if (!m) throw new Error("QORE_MNEMONIC missing from the testnet wallet file");
  const dev = deriveAccount(m);
  await sendTx(
    { address: dev.address.bech32, classical: dev.classical, pq: dev.pq },
    [msgSend(dev.address.bech32, signer.address, DENOMS.QOR.denom, add)],
    "mzk:test-fund:starter-sponsor",
  );
}
await ensureKeys(signer, a.seal);
const have = await balanceOf(signer.address, DENOMS.QOR.denom);
console.log(`sponsor balance: ${fromBaseUnits(have, DENOMS.QOR.decimals)} test QOR, keys registered`);
