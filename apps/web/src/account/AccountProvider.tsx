"use client";
/**
 * The in-app wallet. The 24-word phrase lives only in this browser, wrapped by
 * the device passphrase (and optionally a passkey). Unlocked keys are held in
 * memory in this tab and dropped on Lock, on idle, and when the tab closes.
 * One tab at a time holds the account (Web Locks); others show "Open elsewhere".
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { signSiwq } from "@qorechain/qoresign";
import {
  addPasskeyWrap,
  createVault,
  deriveAccount,
  parseVault,
  unlockWithPassphrase,
  unlockWithPasskeySecret,
  changePassphrase as rewrap,
  fromBase64Url,
  type AccountKeys,
  type Vault,
} from "@mizuhiki/core";
import type { Owner } from "@mizuhiki/chain";
import { idb } from "@/lib/idb";
import { api, ApiFailure } from "@/lib/api";
import { createPasskey, passkeySecret, passkeyIdFromWrap } from "@/lib/passkey";

export type AccountStatus = "loading" | "none" | "locked" | "unlocked" | "elsewhere";

export interface Account {
  keys: AccountKeys;
  owner: Owner;
}

interface Ctx {
  status: AccountStatus;
  vault: Vault | undefined;
  account: Account | undefined;
  /** Create the device vault for a new phrase and unlock it. */
  create: (phrase: string, passphrase: string) => Promise<Account>;
  /** Import an existing phrase on this device. */
  importPhrase: (phrase: string, passphrase: string) => Promise<Account>;
  unlock: (passphrase: string) => Promise<Account>;
  unlockWithPasskey: () => Promise<Account>;
  addPasskey: (name: string) => Promise<void>;
  changePassphrase: (passphrase: string) => Promise<void>;
  lock: () => void;
  /**
   * Remove this device's key. With `then`, finish with a full page load there: no key stays in memory and no
   * screen that needed the account can react to it first.
   */
  forgetDevice: (then?: string) => Promise<void>;
  takeOver: () => void;
  /** A signed-in API session token (Sign In With QoreChain), made on demand. */
  token: () => Promise<string>;
  /** Drop the cached API token (after a 401). */
  dropToken: () => void;
}

const AccountCtx = createContext<Ctx | null>(null);
const VAULT_KEY = "vault";
const LOCK_NAME = "mizuhiki-account";
const IDLE_MS = 15 * 60_000;
const PRF_SALT = new TextEncoder().encode("mizuhiki:vault:passkey:v1");

function toAccount(keys: AccountKeys): Account {
  return {
    keys,
    owner: { address: keys.address.bech32, classical: keys.classical, pq: keys.pq, evm: keys.address.hex as Address },
  };
}

export function AccountProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AccountStatus>("loading");
  const [vault, setVault] = useState<Vault | undefined>(undefined);
  const [account, setAccount] = useState<Account | undefined>(undefined);
  const tokenRef = useRef<{ token: string; address: string; at: number } | undefined>(undefined);
  const signingIn = useRef<{ address: string; promise: Promise<string> } | undefined>(undefined);
  const releaseLock = useRef<(() => void) | undefined>(undefined);
  const statusRef = useRef<AccountStatus>("loading");
  statusRef.current = status;

  /**
   * Take the one-tab lock. Returns whether it was granted, and a cancel that
   * lets go of it, including when the grant arrives after the cancel (React's
   * development double-mount cancels the first request before it is granted).
   */
  const holdTabLock = useCallback((steal: boolean): { granted: Promise<boolean>; cancel: () => void } => {
    if (typeof navigator === "undefined" || !("locks" in navigator))
      return { granted: Promise.resolve(true), cancel: () => undefined };
    let cancelled = false;
    let release: (() => void) | undefined;
    const waitCtl = new AbortController();
    const timer = setTimeout(() => waitCtl.abort(), 2000);
    const granted = new Promise<boolean>((resolve) => {
      // A page that is reloading or navigating away still holds the lock for a
      // moment, so wait up to 2 s for it before saying "Open elsewhere".
      const opts: LockOptions = steal ? { steal: true } : { signal: waitCtl.signal };
      let acquired = false;
      void navigator.locks
        .request(LOCK_NAME, opts, (lock) => {
          clearTimeout(timer);
          if (!lock || cancelled) {
            resolve(false);
            return undefined;
          }
          acquired = true;
          resolve(true);
          return new Promise<void>((r) => {
            release = r;
            releaseLock.current = r;
          });
        })
        .catch(() => {
          clearTimeout(timer);
          if (!acquired) {
            resolve(false);
            return;
          }
          // We held it and another tab took it over ("Use it here instead").
          setAccount(undefined);
          tokenRef.current = undefined;
          setStatus("elsewhere");
        });
    });
    return {
      granted,
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
        if (!release) waitCtl.abort();
        release?.();
      },
    };
  }, []);

  // Let the next page take the lock at once when this one unloads.
  useEffect(() => {
    const leave = () => releaseLock.current?.();
    addEventListener("pagehide", leave);
    return () => removeEventListener("pagehide", leave);
  }, []);

  useEffect(() => {
    const life = { alive: true };
    const hold = holdTabLock(false);
    void (async () => {
      const got = await hold.granted;
      const raw = await idb.get<string>(VAULT_KEY).catch(() => undefined);
      if (!life.alive) return;
      const v = raw ? parseVault(raw) : undefined;
      setVault(v);
      setStatus(!got ? "elsewhere" : v ? "locked" : "none");
    })();
    return () => {
      life.alive = false;
      hold.cancel();
    };
  }, [holdTabLock]);

  const lock = useCallback(() => {
    setAccount(undefined);
    tokenRef.current = undefined;
    setStatus((s) => (s === "unlocked" ? "locked" : s));
  }, []);

  // Idle lock: no input for 15 minutes.
  useEffect(() => {
    if (status !== "unlocked") return;
    let t = setTimeout(lock, IDLE_MS);
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(lock, IDLE_MS);
    };
    const evs = ["pointerdown", "keydown", "scroll", "visibilitychange"] as const;
    evs.forEach((e) => addEventListener(e, bump, { passive: true }));
    return () => {
      clearTimeout(t);
      evs.forEach((e) => removeEventListener(e, bump));
    };
  }, [status, lock]);

  const finishUnlock = useCallback((phrase: string, v: Vault): Account => {
    const keys = deriveAccount(phrase);
    if (keys.address.bech32 !== v.address)
      throw new Error("This phrase belongs to a different account than this device's.");
    const a = toAccount(keys);
    setAccount(a);
    setStatus("unlocked");
    return a;
  }, []);

  const store = useCallback(async (v: Vault) => {
    await idb.set(VAULT_KEY, JSON.stringify(v));
    setVault(v);
  }, []);

  const create = useCallback(
    async (phrase: string, passphrase: string) => {
      const keys = deriveAccount(phrase);
      const v = await createVault({ address: keys.address.bech32, phrase: keys.phrase, passphrase });
      await store(v);
      const a = toAccount(keys);
      setAccount(a);
      setStatus("unlocked");
      return a;
    },
    [store],
  );

  const unlock = useCallback(
    async (passphrase: string) => {
      if (!vault) throw new Error("There is no saved key on this device.");
      const phrase = await unlockWithPassphrase(vault, passphrase);
      return finishUnlock(phrase, vault);
    },
    [vault, finishUnlock],
  );

  const unlockWithPasskey = useCallback(async () => {
    if (!vault) throw new Error("There is no saved key on this device.");
    const w = vault.wraps.find((x) => x.kind === "passkey");
    if (!w?.credentialId || !w.prfSalt) throw new Error("No passkey is set up on this device.");
    const secret = await passkeySecret({
      credentialId: passkeyIdFromWrap(w.credentialId),
      prfSalt: fromBase64Url(w.prfSalt),
    });
    const phrase = await unlockWithPasskeySecret(vault, secret);
    return finishUnlock(phrase, vault);
  }, [vault, finishUnlock]);

  const addPasskey = useCallback(
    async (name: string) => {
      if (!vault || !account) throw new Error("Unlock first.");
      const { credentialId, secret } = await createPasskey({ address: vault.address, name, prfSalt: PRF_SALT });
      await store(
        await addPasskeyWrap({
          vault,
          phrase: account.keys.phrase,
          credentialId,
          prfSalt: PRF_SALT,
          prfSecret: secret,
        }),
      );
    },
    [vault, account, store],
  );

  const changePassphrase = useCallback(
    async (passphrase: string) => {
      if (!vault || !account) throw new Error("Unlock first.");
      await store(await rewrap(vault, account.keys.phrase, passphrase));
    },
    [vault, account, store],
  );

  const forgetDevice = useCallback(async (then?: string) => {
    await idb.del(VAULT_KEY);
    tokenRef.current = undefined;
    if (then) {
      window.location.replace(then);
      return;
    }
    setVault(undefined);
    setAccount(undefined);
    tokenRef.current = undefined;
    setStatus("none");
  }, []);

  const takeOver = useCallback(() => {
    void holdTabLock(true).granted.then(async () => {
      const raw = await idb.get<string>(VAULT_KEY).catch(() => undefined);
      const v = raw ? parseVault(raw) : undefined;
      setVault(v);
      setStatus(v ? "locked" : "none");
    });
  }, [holdTabLock]);

  const token = useCallback(async () => {
    const a = account;
    if (!a) throw new ApiFailure(401, "LOCKED", "Unlock Mizuhiki on this device first.", "nothing-changed");
    const t = tokenRef.current;
    if (t && t.address === a.owner.address && Date.now() - t.at < 10 * 3600_000) return t.token;
    // Callers that arrive while a sign-in is running share it, instead of each starting one.
    const pending = signingIn.current;
    if (pending?.address === a.owner.address) return pending.promise;
    const promise = (async () => {
      const ch = await api.post<{ message: string; nonce: string }>("/auth/challenge", { address: a.owner.address });
      const signature = signSiwq({ message: ch.message, classicalKey: a.keys.classical, pqKey: a.keys.pq });
      const r = await api.post<{ token: string }>("/auth/verify", { nonce: ch.nonce, signature });
      tokenRef.current = { token: r.token, address: a.owner.address, at: Date.now() };
      return r.token;
    })();
    signingIn.current = { address: a.owner.address, promise };
    try {
      return await promise;
    } finally {
      if (signingIn.current.promise === promise) signingIn.current = undefined;
    }
  }, [account]);

  const value = useMemo<Ctx>(
    () => ({
      status,
      vault,
      account,
      create,
      importPhrase: create,
      unlock,
      unlockWithPasskey,
      addPasskey,
      changePassphrase,
      lock,
      forgetDevice,
      takeOver,
      token,
      dropToken: () => {
        tokenRef.current = undefined;
      },
    }),
    [
      status,
      vault,
      account,
      create,
      unlock,
      unlockWithPasskey,
      addPasskey,
      changePassphrase,
      lock,
      forgetDevice,
      takeOver,
      token,
    ],
  );
  return <AccountCtx.Provider value={value}>{children}</AccountCtx.Provider>;
}

export function useAccount(): Ctx {
  const c = useContext(AccountCtx);
  if (!c) throw new Error("useAccount needs <AccountProvider>");
  return c;
}
