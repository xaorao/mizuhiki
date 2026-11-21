/**
 * Passkey unlock through the WebAuthn PRF extension: the authenticator returns
 * the same 32-byte secret for the same salt on every unlock, and that secret
 * wraps the phrase (core vault). Verified in Chromium with a virtual
 * authenticator (spec section 10, test 8); real phones NOT VERIFIED.
 */
import { fromBase64Url } from "@mizuhiki/core";

const enc = (s: string) => new TextEncoder().encode(s);

export function passkeysPossible(): boolean {
  return typeof window !== "undefined" && "PublicKeyCredential" in window && window.isSecureContext;
}

function prfOf(cred: PublicKeyCredential): Uint8Array | undefined {
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: BufferSource } } };
  const first = ext.prf?.results?.first;
  if (!first) return undefined;
  return first instanceof ArrayBuffer
    ? new Uint8Array(first)
    : new Uint8Array((first as ArrayBufferView).buffer.slice(0));
}

/** Create a passkey for this account and return its PRF secret. */
export async function createPasskey(args: {
  address: string;
  name: string;
  prfSalt: Uint8Array;
}): Promise<{ credentialId: Uint8Array; secret: Uint8Array }> {
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: "Mizuhiki", id: location.hostname },
      user: { id: enc(args.address).slice(0, 64), name: `@${args.name}`, displayName: `Mizuhiki @${args.name}` },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      extensions: {
        prf: { eval: { first: args.prfSalt as Uint8Array<ArrayBuffer> } },
      },
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created.");
  const credentialId = new Uint8Array(cred.rawId);
  // Some authenticators only return PRF output on get(), not create().
  const secret = prfOf(cred) ?? (await passkeySecret({ credentialId, prfSalt: args.prfSalt }));
  return { credentialId, secret };
}

export async function passkeySecret(args: { credentialId: Uint8Array; prfSalt: Uint8Array }): Promise<Uint8Array> {
  const a = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      allowCredentials: [{ type: "public-key", id: args.credentialId as Uint8Array<ArrayBuffer> }],
      userVerification: "required",
      extensions: {
        prf: { eval: { first: args.prfSalt as Uint8Array<ArrayBuffer> } },
      },
    },
  })) as PublicKeyCredential | null;
  const secret = a ? prfOf(a) : undefined;
  if (!secret) throw new Error("This device's passkeys cannot unlock Mizuhiki. Use your passphrase.");
  return secret;
}

export const passkeyIdFromWrap = (b64: string): Uint8Array => fromBase64Url(b64);
