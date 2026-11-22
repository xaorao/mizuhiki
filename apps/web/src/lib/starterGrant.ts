/**
 * Starter test QOR at sign-up (ARCHITECTURE 8h): the new account proves it controls its address with its classical
 * key over a one-time challenge, plus a proof of work, and the testnet sponsor sends a small amount once. When the
 * sponsor is off, empty or at its limit, the funding step shows the faucet with the reason.
 */
import { signSiwq } from "@qorechain/qoresign";
import { sha256Hex, solvePowAsync, utf8 } from "@mizuhiki/core";
import type { Account } from "@/account/AccountProvider";
import { api, ApiFailure } from "./api";

export type GrantOutcome =
  { s: "sent"; txHash: string; amount: bigint } | { s: "off" } | { s: "refused"; why: string; code: string };

export async function askStarterGrant(a: Account, signal?: AbortSignal): Promise<GrantOutcome> {
  try {
    const cfg = await api.get<{ enabled: boolean; powBits?: number }>("/grants/starter");
    if (!cfg.enabled || cfg.powBits === undefined) return { s: "off" };
    const ch = await api.post<{ message: string; nonce: string }>("/auth/challenge", { address: a.owner.address });
    const signature = signSiwq({ message: ch.message, classicalKey: a.keys.classical });
    const pow = await solvePowAsync(a.owner.address, sha256Hex(utf8(ch.nonce)), cfg.powBits, signal);
    const r = await api.post<{ txHash: string; amount: string }>("/grants/starter", {
      nonce: ch.nonce,
      signature,
      pow,
    });
    return { s: "sent", txHash: r.txHash, amount: BigInt(r.amount) };
  } catch (e) {
    if (e instanceof ApiFailure) return { s: "refused", why: e.message, code: e.code };
    if (signal?.aborted) return { s: "off" };
    return { s: "refused", why: "Mizuhiki could not be reached just now.", code: "UNREACHABLE" };
  }
}
