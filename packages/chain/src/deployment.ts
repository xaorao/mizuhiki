import type { Address, Hex } from "viem";
import d from "./deployment.testnet.json" with { type: "json" };

/** Our contracts on QoreChain testnet (written by tests/testnet/src/deploy.ts). */
export const CONTRACTS = {
  registry: d.registry as Address,
  vault: d.vault as Address,
  deployBlock: BigInt(d.deployedAt.block),
  registryTx: d.deployedAt.registryTx as Hex,
  vaultTx: d.deployedAt.vaultTx as Hex,
} as const;
