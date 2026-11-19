/** Deploy MizuhikiRegistry and CapsuleVault to testnet from the dev wallet and record the addresses. */
import { writeFileSync, mkdirSync } from "node:fs";
import { closeWindow, openWindow, publicClient, readWindow, walletFor } from "@mizuhiki/chain";
import {
  mizuhikiRegistryAbi,
  mizuhikiRegistryBytecode,
  capsuleVaultAbi,
  capsuleVaultBytecode,
} from "../../../packages/chain/src/bytecode-bundle.js";
import { devWallet } from "./devwallet";

const dev = devWallet();
const pub = publicClient();
const w0 = await readWindow(dev.address);
if (w0.found && w0.live) await closeWindow(dev);
// Contract creation needs an unscoped window (a scoped one refuses creation: spec section 10, test 4).
const { window } = await openWindow(dev, { minutes: 20, maxTxs: 2, maxValueUqor: 400_000_000n, targets: [] });
console.log("window open:", { remainingTxs: window.remainingTxs.toString(), expiry: window.expiryHeight.toString() });
const wallet = walletFor(dev);
async function deploy(name: string, abi: readonly unknown[], bytecode: `0x${string}`) {
  const hash = await wallet.deployContract({ abi, bytecode, args: [] });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`${name} deploy failed: ${hash}`);
  console.log(name, r.contractAddress, hash, "gas", r.gasUsed.toString());
  return { address: r.contractAddress, hash, block: r.blockNumber };
}
const registry = await deploy("MizuhikiRegistry", mizuhikiRegistryAbi, mizuhikiRegistryBytecode);
const vault = await deploy("CapsuleVault", capsuleVaultAbi, capsuleVaultBytecode);
await closeWindow(dev);
mkdirSync("../../contracts/deployments", { recursive: true });
const out = {
  network: "qorechain-diana",
  evmChainId: 9800,
  registry: registry.address,
  vault: vault.address,
  deployedAt: { registryTx: registry.hash, vaultTx: vault.hash, block: registry.block.toString() },
  deployer: dev.evm,
};
writeFileSync("../../contracts/deployments/testnet.json", JSON.stringify(out, null, 2) + "\n");
console.log("wrote contracts/deployments/testnet.json");
