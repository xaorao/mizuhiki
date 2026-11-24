/**
 * Redeploy MizuhikiRegistry (security review finding 1: a live commitment keeps its block) to testnet from the dev
 * wallet. The vault and AnchorBook stay where they are. The previous registry's address and deploy transaction are
 * kept as `legacyRegistry`, because proof anchors made there before AnchorBook existed are still read from it.
 * Both copies of the deployment record are updated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { closeWindow, openWindow, publicClient, readWindow, walletFor } from "@mizuhiki/chain";
import { mizuhikiRegistryAbi, mizuhikiRegistryBytecode } from "../../../packages/chain/src/bytecode-bundle.js";
import { devWallet } from "./devwallet";

const FILES = ["../../contracts/deployments/testnet.json", "../../packages/chain/src/deployment.testnet.json"];
type Deployment = Record<string, unknown> & { registry: string; deployedAt: Record<string, string> };
const current = JSON.parse(readFileSync(FILES[0]!, "utf8")) as Deployment;
if (current.legacyRegistry) throw new Error("a legacy registry is already recorded; refusing to overwrite it");

const dev = devWallet();
const pub = publicClient();
const w0 = await readWindow(dev.address);
if (w0.found && w0.live) await closeWindow(dev);
// Contract creation needs an unscoped window (a scoped one refuses creation: spec section 10, test 4).
await openWindow(dev, { minutes: 20, maxTxs: 1, maxValueUqor: 400_000_000n, targets: [] });
const hash = await walletFor(dev).deployContract({
  abi: mizuhikiRegistryAbi,
  bytecode: mizuhikiRegistryBytecode,
  args: [],
});
const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
await closeWindow(dev);
if (r.status !== "success" || !r.contractAddress) throw new Error(`MizuhikiRegistry deploy failed: ${hash}`);
console.log(
  "MizuhikiRegistry",
  r.contractAddress,
  hash,
  "block",
  r.blockNumber.toString(),
  "gas",
  r.gasUsed.toString(),
);

const next: Deployment = {
  ...current,
  registry: r.contractAddress,
  legacyRegistry: current.registry,
  deployedAt: {
    ...current.deployedAt,
    registryTx: hash,
    registryBlock: r.blockNumber.toString(),
    legacyRegistryTx: current.deployedAt.registryTx!,
  },
};
for (const f of FILES) writeFileSync(f, JSON.stringify(next, null, 2) + "\n");
console.log("updated", FILES.join(" and "));
