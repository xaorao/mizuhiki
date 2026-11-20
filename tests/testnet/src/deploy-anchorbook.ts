/**
 * Deploy AnchorBook (security review M2: one anchor per account per fingerprint) to testnet from the dev
 * wallet, and add its address to contracts/deployments/testnet.json next to the registry and the vault.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { closeWindow, openWindow, publicClient, readWindow, walletFor } from "@mizuhiki/chain";
import { anchorBookAbi, anchorBookBytecode } from "../../../packages/chain/src/bytecode-bundle.js";
import { devWallet } from "./devwallet";

const FILE = "../../contracts/deployments/testnet.json";
const dev = devWallet();
const pub = publicClient();
const w0 = await readWindow(dev.address);
if (w0.found && w0.live) await closeWindow(dev);
// Contract creation needs an unscoped window (a scoped one refuses creation: spec section 10, test 4).
await openWindow(dev, { minutes: 20, maxTxs: 1, maxValueUqor: 400_000_000n, targets: [] });
const hash = await walletFor(dev).deployContract({ abi: anchorBookAbi, bytecode: anchorBookBytecode, args: [] });
const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
await closeWindow(dev);
if (r.status !== "success" || !r.contractAddress) throw new Error(`AnchorBook deploy failed: ${hash}`);
console.log("AnchorBook", r.contractAddress, hash, "gas", r.gasUsed.toString());
const d = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, unknown> & { deployedAt: Record<string, string> };
d.anchorBook = r.contractAddress;
d.deployedAt.anchorBookTx = hash;
d.deployedAt.anchorBookBlock = r.blockNumber.toString();
writeFileSync(FILE, JSON.stringify(d, null, 2) + "\n");
console.log("updated", FILE);
