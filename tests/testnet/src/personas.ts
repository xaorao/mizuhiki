/**
 * Disposable testnet personas for integration and end-to-end tests. Each has
 * its own phrase (stored only under var/, gitignored, testnet only), is funded
 * from the dev wallet, has both keys registered, and optionally a name and a
 * card on MizuhikiRegistry. Re-used across runs so tests stay cheap.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signRecipientCard } from "@qorechain/qoreseal";
import { cardHash, newPhrase } from "@mizuhiki/core";
import {
  DENOMS,
  NETWORK,
  balanceOf,
  cardHashHex,
  ensureKeys,
  ensureWindow,
  msgSend,
  registerName,
  resolveOnChain,
  sendTx,
} from "@mizuhiki/chain";
import { devWallet, persona, type Persona } from "./devwallet";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = resolve(root, "var/personas.json");

function load(): Record<string, { phrase: string; name?: string }> {
  return existsSync(FILE)
    ? (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, { phrase: string; name?: string }>)
    : {};
}
function save(all: Record<string, { phrase: string; name?: string }>) {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

export interface ReadyPersona extends Persona {
  name?: string;
  card: ReturnType<typeof signRecipientCard>;
}

/** A persona with funds and keys; with `name`, also registered on the registry. */
export async function ensurePersona(
  label: string,
  opts: { name?: string; minQor?: bigint } = {},
): Promise<ReadyPersona> {
  const all = load();
  const entry = all[label] ?? { phrase: newPhrase() };
  all[label] = entry;
  save(all);
  const p = persona(entry.phrase, label);
  const need = (opts.minQor ?? 2n) * 1_000_000n;
  const have = await balanceOf(p.address, DENOMS.QOR.denom);
  if (have < need) {
    const dev = devWallet();
    await sendTx(
      dev,
      [msgSend(dev.address, p.address, DENOMS.QOR.denom, need - have + 1_000_000n)],
      `mzk:test-fund:${label}`,
    );
  }
  await ensureKeys(p, p.seal);
  const card = signRecipientCard({
    chainId: NETWORK.chainId,
    address: p.address,
    keys: p.seal,
    classicalKey: p.classical,
    pqKey: p.pq,
  });
  const out: ReadyPersona = { ...p, card };
  const wanted = opts.name ?? entry.name;
  if (wanted) {
    const onChain = await resolveOnChain(wanted);
    if (!onChain.owner) {
      await ensureWindow(p, 2);
      await registerName(p, wanted, cardHashHex(cardHash(card)));
    } else if (onChain.owner.toLowerCase() !== p.evm.toLowerCase()) {
      throw new Error(`@${wanted} belongs to someone else on testnet`);
    }
    entry.name = wanted;
    save(all);
    out.name = wanted;
  }
  return out;
}

/**
 * A stored 24-word phrase for a label, created on first use (gitignored file,
 * mode 600). For wallets derived elsewhere, such as the QoreX test wallet.
 */
export function personaPhrase(label: string): string {
  const all = load();
  const entry = all[label] ?? { phrase: newPhrase() };
  all[label] = entry;
  save(all);
  return entry.phrase;
}

/** Top up an address from the dev wallet to at least `minUnits` of `denom`. */
export async function topUp(address: string, denom: string, minUnits: bigint, memoLabel: string): Promise<void> {
  const have = await balanceOf(address, denom);
  if (have >= minUnits) return;
  const dev = devWallet();
  await sendTx(dev, [msgSend(dev.address, address, denom, minUnits - have)], `mzk:test-fund:${memoLabel}`);
}
