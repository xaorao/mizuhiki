/**
 * One-time setup of the helper's account on testnet: a phrase kept only in
 * services/delivery-agent/.env.local (gitignored, mode 600), test QOR for fees,
 * both keys registered on QoreChain, and a signed sealing card so sellers can
 * seal product keys to it. Prints the helper's address, never the phrase.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { signRecipientCard } from "@qorechain/qoreseal";
import { signSiwq } from "@qorechain/qoresign";
import { DENOMS, NETWORK, balanceOf, ensureKeys, msgSend, sendTx } from "@mizuhiki/chain";
import { deriveAccount, newPhrase } from "@mizuhiki/core";

const file = new URL("../.env.local", import.meta.url);
const api = process.env.API_URL ?? "http://127.0.0.1:4000";
let phrase = existsSync(file) ? /^AGENT_PHRASE="?([^"\n]+)"?/m.exec(readFileSync(file, "utf8"))?.[1] : undefined;
if (!phrase) {
  phrase = newPhrase(24);
  writeFileSync(file, `AGENT_PHRASE="${phrase}"\nAPI_URL=${api}\n`, { mode: 0o600 });
}
const a = deriveAccount(phrase);
const signer = { address: a.address.bech32, classical: a.classical, pq: a.pq };
console.log(`helper address: ${signer.address}`);

// Testnet only: top up from the developer's own testnet wallet when its file is present.
const devFile = `${homedir()}/.secrets/qorechain/testnet-wallet.env`;
const have = await balanceOf(signer.address, DENOMS.QOR.denom);
if (have < 2_000_000n) {
  if (!existsSync(devFile)) {
    console.error(`The helper needs about 2 test QOR for key registration fees. Send some to ${signer.address} and run setup again.`);
    process.exit(1);
  }
  const m = /^QORE_MNEMONIC="?([^"\n]+)"?/m.exec(readFileSync(devFile, "utf8"))?.[1];
  if (!m) throw new Error("QORE_MNEMONIC missing from the testnet wallet file");
  const dev = deriveAccount(m);
  await sendTx({ address: dev.address.bech32, classical: dev.classical, pq: dev.pq }, [msgSend(dev.address.bech32, signer.address, DENOMS.QOR.denom, 3_000_000n)], "mzk:test-fund:delivery-helper");
}
await ensureKeys(signer, a.seal);
const card = signRecipientCard({ chainId: NETWORK.chainId, address: signer.address, keys: a.seal, classicalKey: a.classical, pqKey: a.pq });
const ch = (await (await fetch(`${api}/auth/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: signer.address }) })).json()) as { message: string; nonce: string };
const signature = signSiwq({ message: ch.message, classicalKey: a.classical, pqKey: a.pq });
const { token } = (await (await fetch(`${api}/auth/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nonce: ch.nonce, signature }) })).json()) as { token: string };
const r = await fetch(`${api}/cards`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ card }) });
if (!r.ok) throw new Error(`storing the helper's card failed: ${r.status} ${await r.text()}`);
console.log("helper keys and card are ready on testnet");
