import {
  isQoreSealError,
  open as qsOpen,
  parseEnvelope,
  seal as qsSeal,
  verifyRecipientCard,
  type RecipientCard,
  type SealKeyPair,
  type SealRecipient,
  sealKeysFromSeed,
} from "@qorechain/qoreseal";
import { MizuhikiError } from "./errors";
import { check } from "./purposes";
import { randomBytes, sha256Hex, utf8 } from "./bytes";

export const CHAIN_ID = "qorechain-diana";

export interface SealOptions {
  purpose: string;
  readers: SealRecipient[];
  plaintext: Uint8Array;
  /** Bound but not encrypted; the reader must supply the same bytes (for example an invoice number). */
  context?: string;
  /** Hide which keys are readers (no recipient hints). Default true for owner-bound items. */
  anonymous?: boolean;
  chainId?: string;
}

export interface Sealed {
  envelope: Uint8Array;
  /** SHA-256 of the envelope bytes, hex: the item's id everywhere. */
  hash: string;
  readers: number;
}

/** Seal on this device. Nothing leaves it; the caller uploads `envelope`. */
export function sealItem(o: SealOptions): Sealed {
  if (o.readers.length === 0) throw new MizuhikiError("INVALID_INPUT", "at least one reader is required");
  try {
    const envelope = qsSeal({
      chainId: o.chainId ?? CHAIN_ID,
      purpose: check(o.purpose),
      recipients: o.readers,
      plaintext: o.plaintext,
      anonymous: o.anonymous ?? true,
      ...(o.context === undefined ? {} : { aad: utf8(o.context) }),
    });
    return { envelope, hash: sha256Hex(envelope), readers: o.readers.length };
  } catch (e) {
    throw new MizuhikiError("INVALID_INPUT", "Could not seal this item. Nothing left your device.", {
      dataState: "nothing-left-device",
      cause: e,
    });
  }
}

export interface OpenOptions {
  purpose: string;
  envelope: Uint8Array;
  keys: SealKeyPair;
  context?: string;
  chainId?: string;
}

/** Open on this device. Maps QoreSeal codes to errors people can act on. */
export function openItem(o: OpenOptions): Uint8Array {
  try {
    return qsOpen({
      chainId: o.chainId ?? CHAIN_ID,
      purpose: check(o.purpose),
      envelope: o.envelope,
      keys: o.keys,
      ...(o.context === undefined ? {} : { aad: utf8(o.context) }),
    });
  } catch (e) {
    if (isQoreSealError(e, "NOT_A_RECIPIENT")) {
      throw new MizuhikiError("NOT_A_READER", "This was not sealed to your key.", {
        dataState: "unreadable-here",
        cause: e,
      });
    }
    // An anonymous envelope carries no hints, so QoreSeal cannot tell "not a
    // reader" from "wrong use": both report DECRYPTION_FAILED (VERIFIED by running it).
    if (isQoreSealError(e, "DECRYPTION_FAILED") && isAnonymous(o.envelope)) {
      throw new MizuhikiError("NOT_A_READER", "This was not sealed to your key, or it was sealed for another use.", {
        dataState: "unreadable-here",
        cause: e,
      });
    }
    if (isQoreSealError(e, "DECRYPTION_FAILED")) {
      throw new MizuhikiError("WRONG_CONTEXT", "This item was sealed for a different use, or it was changed.", {
        dataState: "unreadable-here",
        cause: e,
      });
    }
    if (isQoreSealError(e, "MALFORMED_ENVELOPE") || isQoreSealError(e, "UNSUPPORTED_VERSION")) {
      throw new MizuhikiError("TAMPERED", "This item is damaged and cannot be opened.", {
        dataState: "unreadable-here",
        cause: e,
      });
    }
    throw new MizuhikiError("TAMPERED", "This item could not be opened.", { dataState: "unreadable-here", cause: e });
  }
}

function isAnonymous(envelope: Uint8Array): boolean {
  try {
    return parseEnvelope(envelope).anonymous;
  } catch {
    return false;
  }
}

/** Header facts anyone can read from an envelope: size and reader count. Used by the content-blind server too. */
export function envelopeFacts(envelope: Uint8Array): { readers: number; anonymous: boolean; size: number } {
  try {
    const p = parseEnvelope(envelope);
    return { readers: p.entries.length, anonymous: p.anonymous, size: envelope.length };
  } catch (e) {
    throw new MizuhikiError("TAMPERED", "Not a sealed envelope.", { dataState: "nothing-changed", cause: e });
  }
}

/** Verify a card against the keys registered on chain (the caller fetched them). */
export function recipientFromCard(args: {
  card: RecipientCard;
  address: string;
  pqPublicKey: Uint8Array;
  mlkemPublicKey: Uint8Array;
  chainId?: string;
}): SealRecipient {
  try {
    return verifyRecipientCard({
      card: args.card,
      chainId: args.chainId ?? CHAIN_ID,
      address: args.address,
      pqPublicKey: args.pqPublicKey,
      mlkemPublicKey: args.mlkemPublicKey,
    });
  } catch (e) {
    throw new MizuhikiError(
      "CARD_INVALID",
      "This page's sealing key does not match the key on chain. Nothing was sent.",
      { dataState: "nothing-left-device", cause: e },
    );
  }
}

/**
 * Link keys: a reader whose 32-byte seed travels in a URL fragment (after `#`,
 * never sent to a server). Anyone with the link can open what is sealed to it,
 * and the product says so wherever such a link is shown.
 */
export function newLinkSeed(): Uint8Array {
  return randomBytes(32);
}
export function linkKeys(seed: Uint8Array): SealKeyPair {
  if (seed.length !== 32) throw new MizuhikiError("INVALID_INPUT", "This link's key is damaged.");
  return sealKeysFromSeed(seed);
}
