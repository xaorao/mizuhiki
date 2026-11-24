import type { Address, Hex } from "viem";
import d from "./deployment.testnet.json" with { type: "json" };

/** Our contracts on QoreChain testnet (written by tests/testnet/src/deploy.ts). */
export const CONTRACTS = {
  registry: d.registry as Address,
  /** The registry before the commit fix (security review finding 1); its proof anchors are still read. */
  legacyRegistry: d.legacyRegistry as Address,
  vault: d.vault as Address,
  /** One proof anchor per account per fingerprint (security review M2); the registry's anchors stay readable. */
  anchorBook: d.anchorBook as Address,
  deployBlock: BigInt(d.deployedAt.block),
  registryTx: d.deployedAt.registryTx as Hex,
  legacyRegistryTx: d.deployedAt.legacyRegistryTx as Hex,
  vaultTx: d.deployedAt.vaultTx as Hex,
  anchorBookTx: d.deployedAt.anchorBookTx as Hex,
} as const;
