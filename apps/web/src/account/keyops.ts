/**
 * The account's heavy key work: deriving post-quantum keys, wrapping and unwrapping the vault, signing in.
 * Loaded when someone creates, restores or unlocks an account, not with every page.
 */
export { signSiwq } from "@qorechain/qoresign";
export {
  addPasskeyWrap,
  createVault,
  deriveAccount,
  unlockWithPassphrase,
  unlockWithPasskeySecret,
  changePassphrase,
} from "@mizuhiki/core";
