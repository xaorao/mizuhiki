/**
 * Sign In With QoreChain sessions. The server issues a nonce and the exact
 * message; the owner's device signs it (secp256k1 + ML-DSA-87); the server
 * verifies against the key registered on chain and returns a short-lived token.
 * Only the token's SHA-256 is stored.
 */
import { createHash, randomBytes } from "node:crypto";
import { createSiwqMessage, parseSiwqMessage, verifySiwq, type SiwqSignature } from "@qorechain/qoresign";
import { NETWORK } from "@mizuhiki/chain";
import { and, eq, gt, lt } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import type { Db } from "@mizuhiki/db";
import { accounts, authNonces, sessions } from "@mizuhiki/db";
import { pqKeyOf } from "./chainreads";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export async function issueChallenge(
  db: Db,
  address: string,
  origin: string,
): Promise<{ message: string; nonce: string }> {
  const url = new URL(origin);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date();
  const message = createSiwqMessage({
    domain: url.host,
    scheme: url.protocol.replace(":", ""),
    address,
    statement: "Sign in to Mizuhiki. This proves you hold this account's keys. It costs nothing and sends nothing.",
    uri: origin,
    version: "1",
    chainId: NETWORK.chainId,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expirationTime: new Date(issuedAt.getTime() + 5 * 60_000).toISOString(),
  });
  await db.delete(authNonces).where(lt(authNonces.expiresAt, new Date()));
  await db.insert(authNonces).values({ nonce, address, message, expiresAt: new Date(issuedAt.getTime() + 5 * 60_000) });
  return { message, nonce };
}

export class AuthError extends Error {}

export async function completeSignIn(
  db: Db,
  args: { nonce: string; signature: SiwqSignature; origin: string; sessionHours: number },
): Promise<{ token: string; address: string; expiresAt: Date }> {
  const [row] = await db
    .select()
    .from(authNonces)
    .where(and(eq(authNonces.nonce, args.nonce), gt(authNonces.expiresAt, new Date())));
  if (!row) throw new AuthError("This sign-in request expired. Please try again.");
  // One use only, whatever the outcome.
  await db.delete(authNonces).where(eq(authNonces.nonce, args.nonce));
  // A challenge made on one of our sites and answered from another: say so, rather than blame the keys.
  if (parseSiwqMessage(row.message).domain !== new URL(args.origin).host)
    throw new AuthError("This sign-in was started on a different Mizuhiki site. Start again here.");
  const key = await pqKeyOf(row.address);
  if (!key.registered || !key.publicKey) throw new AuthError("This account has no post-quantum key on chain yet.");
  try {
    verifySiwq({
      message: row.message,
      signature: args.signature,
      domain: new URL(args.origin).host,
      nonce: row.nonce,
      chainId: NETWORK.chainId,
      pqPublicKey: key.publicKey,
      requirePq: true,
    });
  } catch {
    throw new AuthError("The signature did not match this account's keys.");
  }
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + args.sessionHours * 3600_000);
  await db.insert(sessions).values({ tokenHash: sha(token), address: row.address, expiresAt });
  await db
    .insert(accounts)
    .values({ address: row.address })
    .onConflictDoUpdate({ target: accounts.address, set: { lastSeen: new Date() } });
  return { token, address: row.address, expiresAt };
}

/** The signed-in address for a request, or undefined. */
export async function sessionAddress(db: Db, req: FastifyRequest): Promise<string | undefined> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return undefined;
  const token = h.slice(7).trim();
  if (token.length < 20) return undefined;
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.tokenHash, sha(token)), gt(sessions.expiresAt, new Date())));
  return row?.address;
}

export async function endSession(db: Db, req: FastifyRequest): Promise<void> {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return;
  await db.delete(sessions).where(eq(sessions.tokenHash, sha(h.slice(7).trim())));
}
