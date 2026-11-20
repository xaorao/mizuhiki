/** Types for the parts of http_ece (web-push's own encryption library) the push test uses. */
declare module "http_ece" {
  import type { ECDH } from "node:crypto";
  export function decrypt(
    buffer: Buffer,
    params: { version: "aes128gcm"; privateKey: ECDH; authSecret: string },
  ): Buffer;
  const ece: { decrypt: typeof decrypt };
  export default ece;
}
