/**
 * Calls to MizuhikiRegistry and CapsuleVault. Every action is authorised by an
 * ML-DSA-87 signature over the contract's action digest, computed here from
 * the contract's own encoding and cross-checked against the contract's
 * `actionDigest` view before signing, so a lying RPC cannot get a different
 * action signed. The EVM transaction itself runs inside the owner's window.
 */
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  http,
  keccak256,
  toBytes,
  toHex as vToHex,
  BaseError,
  ContractFunctionRevertedError,
  type Address,
  type Hex,
  type PublicClient,
  type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pqSign } from "@qorechain/qoresign";
import { NETWORK } from "./config";
import { ChainError } from "./errors";
import { mizuhikiRegistryAbi, capsuleVaultAbi, anchorBookAbi } from "./abi";
import type { Signer } from "./native";

export const qorechainTestnet = defineChain({
  id: NETWORK.evmChainId,
  name: "QoreChain testnet (diana)",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NETWORK.evmRpc] } },
  blockExplorers: { default: { name: "QoreScan", url: NETWORK.explorer } },
});

export interface Deployment {
  registry: Address;
  vault: Address;
  deployedAt: { registryTx: Hex; vaultTx: Hex; block: string };
}

/**
 * The testnet RPC sits behind several nodes; one a block behind answers a read at "latest" with "header not found"
 * (JSON-RPC -32602, which viem treats as final and does not retry). That is lag, not a bad call: wait for the node to
 * catch up and ask again, a few times, before giving up. Every other error passes through unchanged.
 */
export function lagTolerant(base: Transport, o: { attempts?: number; delayMs?: number } = {}): Transport {
  const attempts = o.attempts ?? 4;
  const delayMs = o.delayMs ?? 600;
  return (config) => {
    const t = base(config);
    const request: typeof t.request = async (args, opts) => {
      for (let i = 1; ; i++) {
        try {
          return await t.request(args, opts);
        } catch (e) {
          const lag = e instanceof Error && /header not found/i.test(e.message);
          if (!lag || i >= attempts) throw e;
          await new Promise((r) => setTimeout(r, delayMs * i));
        }
      }
    };
    return { ...t, request };
  };
}

let cachedPublic: PublicClient | undefined;
export function publicClient(): PublicClient {
  cachedPublic ??= createPublicClient({
    chain: qorechainTestnet,
    // JSON-RPC batching (the endpoint accepts batches, checked): one request carries the calls made together.
    transport: lagTolerant(
      http(NETWORK.evmRpc, { retryCount: 3, retryDelay: 400, batch: { batchSize: 25, wait: 16 } }),
    ),
  }) as PublicClient;
  return cachedPublic;
}

export const DOMAIN = keccak256(toBytes("MIZUHIKI_PQ_AUTH_V1"));
const tag = (s: string): Hex => keccak256(toBytes(s));
const enc = (types: string[], values: unknown[]): Hex =>
  encodeAbiParameters(
    types.map((t) => ({ type: t })),
    values as never,
  );

/** Action hashes, byte for byte the Solidity `keccak256(abi.encode(keccak256("<fn>"), ...))`. */
export const Action = {
  register: (nameHash: Hex, cardHash: Hex) =>
    keccak256(enc(["bytes32", "bytes32", "bytes32"], [tag("register"), nameHash, cardHash])),
  claimName: (nameHash: Hex, primary: boolean) =>
    keccak256(enc(["bytes32", "bytes32", "bool"], [tag("claimName"), nameHash, primary])),
  releaseName: (nameHash: Hex) => keccak256(enc(["bytes32", "bytes32"], [tag("releaseName"), nameHash])),
  setPrimaryName: (nameHash: Hex) => keccak256(enc(["bytes32", "bytes32"], [tag("setPrimaryName"), nameHash])),
  setCard: (cardHash: Hex) => keccak256(enc(["bytes32", "bytes32"], [tag("setCard"), cardHash])),
  anchor: (contentHash: Hex, kind: Hex) =>
    keccak256(enc(["bytes32", "bytes32", "bytes32"], [tag("anchor"), contentHash, kind])),
  createRoom: (roomId: Hex, m: Hex, d: Hex) =>
    keccak256(enc(["bytes32", "bytes32", "bytes32", "bytes32"], [tag("createRoom"), roomId, m, d])),
  rotateRoom: (roomId: Hex, epoch: bigint, m: Hex, d: Hex, reason: Hex) =>
    keccak256(
      enc(
        ["bytes32", "bytes32", "uint64", "bytes32", "bytes32", "bytes32"],
        [tag("rotateRoom"), roomId, epoch, m, d, reason],
      ),
    ),
  setRole: (roomId: Hex, member: Address, role: number) =>
    keccak256(enc(["bytes32", "bytes32", "address", "uint8"], [tag("setRole"), roomId, member, role])),
  transferRoom: (roomId: Hex, newOwner: Address) =>
    keccak256(enc(["bytes32", "bytes32", "address"], [tag("transferRoom"), roomId, newOwner])),
  closeRoom: (roomId: Hex) => keccak256(enc(["bytes32", "bytes32"], [tag("closeRoom"), roomId])),
  publish: (kind: Hex, id: Hex, contentHash: Hex, active: boolean) =>
    keccak256(
      enc(["bytes32", "bytes32", "bytes32", "bytes32", "bool"], [tag("publish"), kind, id, contentHash, active]),
    ),
  capsuleCreate: (a: CapsulePlan) =>
    keccak256(
      enc(
        ["bytes32", "bytes32", "uint8", "address[]", "uint8", "uint64", "uint64", "uint64", "uint64", "bytes32"],
        [
          tag("create"),
          a.id,
          a.mode,
          a.guardians,
          a.threshold,
          a.releaseAt,
          a.waitSeconds,
          a.quietSeconds,
          a.accessSeconds,
          a.planHash,
        ],
      ),
    ),
  setGuardians: (id: Hex, guardians: Address[], threshold: number, planHash: Hex) =>
    keccak256(
      enc(
        ["bytes32", "bytes32", "address[]", "uint8", "bytes32"],
        [tag("setGuardians"), id, guardians, threshold, planHash],
      ),
    ),
  checkIn: () => keccak256(enc(["bytes32"], [tag("checkIn")])),
  reject: (id: Hex) => keccak256(enc(["bytes32", "bytes32"], [tag("reject"), id])),
  releaseNow: (id: Hex) => keccak256(enc(["bytes32", "bytes32"], [tag("releaseNow"), id])),
  cancel: (id: Hex) => keccak256(enc(["bytes32", "bytes32"], [tag("cancel"), id])),
  request: (id: Hex) => keccak256(enc(["bytes32", "bytes32"], [tag("request"), id])),
};

export interface CapsulePlan {
  id: Hex;
  mode: 0 | 1 | 2;
  guardians: Address[];
  threshold: number;
  releaseAt: bigint;
  waitSeconds: bigint;
  quietSeconds: bigint;
  accessSeconds: bigint;
  planHash: Hex;
}

export const nameHash = (name: string): Hex => keccak256(toBytes(name));
export const bytes32Text = (s: string): Hex => {
  const b = toBytes(s);
  if (b.length > 32) throw new Error("label longer than 32 bytes");
  const out = new Uint8Array(32);
  out.set(b);
  return vToHex(out);
};

/** keccak256(abi.encode(DOMAIN, chainid, contract, signer, nonce, actionHash)). */
export function localDigest(contract: Address, signer: Address, nonce: bigint, actionHash: Hex): Hex {
  return keccak256(
    enc(
      ["bytes32", "uint256", "address", "address", "uint256", "bytes32"],
      [DOMAIN, BigInt(NETWORK.evmChainId), contract, signer, nonce, actionHash],
    ),
  );
}

type Abi = typeof mizuhikiRegistryAbi | typeof capsuleVaultAbi | typeof anchorBookAbi;

/** Sign the next action for `signer` on `contract`, after checking our digest equals the contract's. */
export async function signAction(
  signer: Signer & { evm: Address },
  contract: Address,
  abi: Abi,
  actionHash: Hex,
): Promise<Hex> {
  const pub = publicClient();
  const nonce: unknown = await pub.readContract({
    address: contract,
    abi,
    functionName: "nonceOf",
    args: [signer.evm],
  });
  if (typeof nonce !== "bigint") throw new ChainError("NETWORK", "Could not read the account's action counter.");
  const mine = localDigest(contract, signer.evm, nonce, actionHash);
  const theirs: unknown = await pub.readContract({
    address: contract,
    abi,
    functionName: "actionDigest",
    args: [signer.evm, actionHash],
  });
  if (typeof theirs !== "string" || mine !== theirs) {
    throw new ChainError(
      "REFUSED",
      "The contract described this action differently than expected. Nothing was signed.",
    );
  }
  return vToHex(pqSign(signer.pq.secretKey, toBytes(mine)));
}

export function walletFor(signer: Signer) {
  const account = privateKeyToAccount(vToHex(signer.classical.privateKey));
  return createWalletClient({ chain: qorechainTestnet, transport: http(NETWORK.evmRpc, { retryCount: 2 }), account });
}

/** Turn a viem failure into a ChainError that says whether anything happened. */
export function explainEvmError(e: unknown, txHash?: Hex): ChainError {
  if (e instanceof ChainError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/authori[sz]ation window/i.test(msg)) {
    return new ChainError("NO_WINDOW", "On-chain actions need a fresh permission window. Nothing was sent.", {
      detail: msg,
    });
  }
  if (/window/i.test(msg) && /(exhaust|exceed|limit|budget)/i.test(msg)) {
    return new ChainError("WINDOW_EXHAUSTED", "Your permission window has run out. Nothing was sent.", { detail: msg });
  }
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (rev instanceof ContractFunctionRevertedError) {
      const name = rev.data?.errorName ?? "reverted";
      // After a broadcast the fee is spent, so "nothing was changed" would not be true.
      const sentence = txHash
        ? revertSentence(name).replace(/ Nothing was changed\.$/, " Only the network fee was spent.")
        : revertSentence(name);
      return new ChainError("CONTRACT_REVERT", sentence, {
        detail: name,
        ...(txHash ? { txHash, moved: "yes" as const } : {}),
      });
    }
  }
  if (/insufficient funds/i.test(msg))
    return new ChainError("NO_FUNDS", "Not enough test QOR for the network fee. Nothing was sent.", { detail: msg });
  return new ChainError(
    "NETWORK",
    txHash
      ? "This on-chain step did not finish. Check the transaction before trying again."
      : "Could not complete this on-chain step. Nothing was changed.",
    {
      detail: msg,
      ...(txHash ? { txHash, moved: "unknown" as const } : {}),
    },
  );
}

export function revertSentence(errorName: string): string {
  switch (errorName) {
    case "NameTaken":
      return "That name was just taken. Nothing was charged except the fee.";
    case "InvalidName":
      return "Names use 3 to 30 lowercase letters, numbers, dots, dashes or underscores.";
    case "NoCommitment":
      return "The name reservation expired. Please try again.";
    case "BadSignature":
      return "The post-quantum signature did not match. Nothing was changed.";
    case "NoPqKey":
    case "PossessionNotProven":
      return "This account's post-quantum key is not registered yet.";
    case "StaleEpoch":
      return "Someone else changed this room at the same moment. Refresh and try again.";
    case "NotRoomAdmin":
      return "Only room admins can do that.";
    case "NotGuardian":
      return "Only this capsule's guardians can do that.";
    case "NotOwner":
      return "Only the capsule's owner can do that.";
    case "WrongState":
      return "This capsule is no longer in a state that allows that.";
    case "NotYet":
      return "It is not time to open this capsule yet.";
    case "AlreadyAnchored":
      return "You anchored this file already. Its certificate exists.";
    default:
      return "The contract refused this step. Nothing was changed.";
  }
}

/**
 * Simulate, then send a contract write from the signer's own EVM account
 * (inside its window), then wait for the receipt.
 */
export async function writeContract(
  signer: Signer & { evm: Address },
  args: { address: Address; abi: Abi; functionName: string; args: readonly unknown[] },
): Promise<{ txHash: Hex; blockNumber: bigint; gasUsed: bigint }> {
  const pub = publicClient();
  const wallet = walletFor(signer);
  let txHash: Hex | undefined;
  try {
    const { request } = await pub.simulateContract({ ...args, account: wallet.account } as never);
    txHash = await wallet.writeContract(request as never);
    const r = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    if (r.status !== "success")
      throw new ChainError("FAILED_IN_BLOCK", "The step failed on chain. Only the fee was spent.", {
        moved: "yes",
        txHash,
      });
    return { txHash, blockNumber: r.blockNumber, gasUsed: r.gasUsed };
  } catch (e) {
    throw explainEvmError(e, txHash);
  }
}
