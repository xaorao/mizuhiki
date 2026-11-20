// Make this server's Web Push (VAPID) key pair once and keep it in .env.local (mode 600, git-ignored).
// Prints only the public key; the private key never leaves the file.
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import webpush from "web-push";

const file = new URL("../.env.local", import.meta.url);
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
if (/^VAPID_PRIVATE_KEY=/m.test(text)) {
  console.log("Push keys already exist; nothing changed.");
  process.exit(0);
}
const keys = webpush.generateVAPIDKeys();
const subject = process.env.VAPID_SUBJECT ?? "https://localhost";
const add = `${text.endsWith("\n") || text === "" ? "" : "\n"}VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\nVAPID_SUBJECT=${subject}\n`;
writeFileSync(file, text + add, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Push keys written to .env.local. Public key: ${keys.publicKey}`);
