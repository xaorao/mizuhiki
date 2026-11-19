/**
 * The device vault: the phrase wrapped with AES-256-GCM under a key from the
 * device passphrase (PBKDF2-SHA-256, 600,000 iterations) and, optionally, a
 * second wrap under a passkey's WebAuthn PRF secret. Only wrapped bytes are
 * ever stored.
 */
import { MizuhikiError } from "./errors";
import { ab, fromBase64Url, randomBytes, toBase64Url, utf8 } from "./bytes";

export const PBKDF2_ITERATIONS = 600_000;
const AAD = "mzk:vault:v1";

export interface Wrap {
  kind: "passphrase" | "passkey";
  /** base64url */
  salt: string;
  iv: string;
  ciphertext: string;
  iterations?: number;
  /** passkey only: base64url credential id and the PRF input salt. */
  credentialId?: string;
  prfSalt?: string;
}

export interface Vault {
  v: 1;
  address: string;
  createdAt: string;
  wraps: Wrap[];
}

async function aesKeyFromPassphrase(pass: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", ab(utf8(pass.normalize("NFC"))), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: ab(salt), iterations },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function aesKeyFromSecret(secret: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", ab(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ab(salt), info: ab(utf8("mzk:vault:passkey")) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encrypt(key: CryptoKey, plain: Uint8Array): Promise<{ iv: Uint8Array; ct: Uint8Array }> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: ab(iv), additionalData: ab(utf8(AAD)) }, key, ab(plain)),
  );
  return { iv, ct };
}

async function decrypt(key: CryptoKey, w: Wrap): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ab(fromBase64Url(w.iv)), additionalData: ab(utf8(AAD)) },
    key,
    ab(fromBase64Url(w.ciphertext)),
  );
  return new TextDecoder().decode(plain);
}

/** Rough strength gate: at least 10 characters and not a single repeated or sequential run. */
export function passphraseProblem(pass: string): string | undefined {
  if (pass.length < 10) return "Use at least 10 characters.";
  if (/^(.)\1+$/.test(pass)) return "Use more than one repeated character.";
  const lower = pass.toLowerCase();
  if (["password12", "1234567890", "qwertyuiop", "mizuhiki12"].some((w) => lower.startsWith(w))) {
    return "That passphrase is too easy to guess.";
  }
  return undefined;
}

export async function createVault(args: {
  address: string;
  phrase: string;
  passphrase: string;
  iterations?: number;
}): Promise<Vault> {
  const problem = passphraseProblem(args.passphrase);
  if (problem) throw new MizuhikiError("INVALID_INPUT", problem);
  const iterations = args.iterations ?? PBKDF2_ITERATIONS;
  const salt = randomBytes(16);
  const key = await aesKeyFromPassphrase(args.passphrase, salt, iterations);
  const { iv, ct } = await encrypt(key, utf8(args.phrase));
  return {
    v: 1,
    address: args.address,
    createdAt: new Date().toISOString(),
    wraps: [
      { kind: "passphrase", salt: toBase64Url(salt), iv: toBase64Url(iv), ciphertext: toBase64Url(ct), iterations },
    ],
  };
}

export async function unlockWithPassphrase(vault: Vault, passphrase: string): Promise<string> {
  const w = vault.wraps.find((x) => x.kind === "passphrase");
  if (!w) throw new MizuhikiError("VAULT_CORRUPT", "This device has no passphrase unlock.");
  const key = await aesKeyFromPassphrase(passphrase, fromBase64Url(w.salt), w.iterations ?? PBKDF2_ITERATIONS);
  try {
    return await decrypt(key, w);
  } catch {
    throw new MizuhikiError("WRONG_PASSPHRASE", "That passphrase did not unlock this device. Nothing changed.");
  }
}

/** Add a passkey wrap. `prfSecret` is the 32-byte PRF output for `prfSalt`. */
export async function addPasskeyWrap(args: {
  vault: Vault;
  phrase: string;
  credentialId: Uint8Array;
  prfSalt: Uint8Array;
  prfSecret: Uint8Array;
}): Promise<Vault> {
  if (args.prfSecret.length < 32)
    throw new MizuhikiError("INVALID_INPUT", "The passkey did not return a usable secret.");
  const salt = randomBytes(16);
  const key = await aesKeyFromSecret(args.prfSecret, salt);
  const { iv, ct } = await encrypt(key, utf8(args.phrase));
  const wraps = args.vault.wraps.filter((w) => w.kind !== "passkey");
  wraps.push({
    kind: "passkey",
    salt: toBase64Url(salt),
    iv: toBase64Url(iv),
    ciphertext: toBase64Url(ct),
    credentialId: toBase64Url(args.credentialId),
    prfSalt: toBase64Url(args.prfSalt),
  });
  return { ...args.vault, wraps };
}

export async function unlockWithPasskeySecret(vault: Vault, prfSecret: Uint8Array): Promise<string> {
  const w = vault.wraps.find((x) => x.kind === "passkey");
  if (!w) throw new MizuhikiError("VAULT_CORRUPT", "This device has no passkey unlock.");
  try {
    return await decrypt(await aesKeyFromSecret(prfSecret, fromBase64Url(w.salt)), w);
  } catch {
    throw new MizuhikiError("WRONG_PASSPHRASE", "That passkey did not unlock this device. Nothing changed.");
  }
}

/** Re-wrap under a new passphrase (needs the phrase, so the vault must be unlocked first). */
export async function changePassphrase(vault: Vault, phrase: string, newPassphrase: string): Promise<Vault> {
  const fresh = await createVault({ address: vault.address, phrase, passphrase: newPassphrase });
  return { ...vault, wraps: [...fresh.wraps, ...vault.wraps.filter((w) => w.kind === "passkey")] };
}

export function parseVault(json: string): Vault {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    throw new MizuhikiError("VAULT_CORRUPT", "The saved key on this device is damaged.");
  }
  const o = v as Partial<Vault>;
  if (o.v !== 1 || typeof o.address !== "string" || !Array.isArray(o.wraps) || o.wraps.length === 0) {
    throw new MizuhikiError("VAULT_CORRUPT", "The saved key on this device is damaged.");
  }
  return o as Vault;
}
