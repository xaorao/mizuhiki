/**
 * Every failure the core library reports. `code` is stable and drives the copy
 * shown to people; `dataState` says, first, what happened to their data.
 */
export type MizuhikiErrorCode =
  | "INVALID_PHRASE"
  | "WRONG_PASSPHRASE"
  | "VAULT_CORRUPT"
  | "INVALID_PURPOSE"
  | "NOT_A_READER"
  | "TAMPERED"
  | "WRONG_CONTEXT"
  | "CARD_INVALID"
  | "RECIPIENT_NOT_READY"
  | "SIGNATURE_INVALID"
  | "FILE_TOO_LARGE"
  | "SHARES_INSUFFICIENT"
  | "NETWORK"
  | "INVALID_INPUT";

/** What happened to the person's data, stated before anything else. */
export type DataState = "nothing-left-device" | "nothing-changed" | "unreadable-here" | "sent" | "unknown";

export class MizuhikiError extends Error {
  readonly code: MizuhikiErrorCode;
  readonly dataState: DataState;
  override readonly cause?: unknown;

  constructor(code: MizuhikiErrorCode, message: string, opts: { dataState?: DataState; cause?: unknown } = {}) {
    super(message);
    this.name = "MizuhikiError";
    this.code = code;
    this.dataState = opts.dataState ?? "nothing-changed";
    this.cause = opts.cause;
  }
}

export function isMizuhikiError(err: unknown, code?: MizuhikiErrorCode): err is MizuhikiError {
  return err instanceof MizuhikiError && (code === undefined || err.code === code);
}
