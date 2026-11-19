/**
 * The testnet-only dev wallet, read from ~/.secrets/qorechain/testnet-wallet.env.
 * Used to deploy contracts and to fund disposable test personas. Its secret
 * values are never printed.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { deriveAccount, newPhrase, type AccountKeys } from "@mizuhiki/core";
import { DENOMS, msgSend, sendTx, type Signer } from "@mizuhiki/chain";
import type { Address } from "viem";

export type Persona = AccountKeys & Signer & { evm: Address; label: string };

export function asSigner(a: AccountKeys, label: string): Persona {
  return { ...a, address: a.address, evm: a.address.hex as Address, label } as unknown as Persona;
}

export function persona(phrase: string, label: string): Persona {
  const a = deriveAccount(phrase);
  return { ...a, address: a.address.bech32, evm: a.address.hex as Address, label } as unknown as Persona;
}

export function devWallet(): Persona {
  const path = `${homedir()}/.secrets/qorechain/testnet-wallet.env`;
  const env = Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
      }),
  ) as Record<string, string>;
  const m = env.QORE_MNEMONIC;
  if (!m) throw new Error("QORE_MNEMONIC missing from the testnet wallet file");
  return persona(m, "dev");
}

/** A fresh disposable persona funded with `qor` test QOR from the dev wallet. */
export async function fundedPersona(label: string, qor = 3n): Promise<Persona> {
  const p = persona(newPhrase(), label);
  const dev = devWallet();
  await sendTx(dev, [msgSend(dev.address, p.address, DENOMS.QOR.denom, qor * 1_000_000n)], `mzk:test-fund:${label}`);
  return p;
}
