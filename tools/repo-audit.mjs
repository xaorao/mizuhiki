// Fails if a secret, a recovery phrase, an env file or a personal path is tracked or staged.
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const files = execSync("git ls-files --cached --others --exclude-standard", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const problems = [];
const home = homedir();
const secretFile = `${home}/.secrets/qorechain/testnet-wallet.env`;
const known = [];
if (existsSync(secretFile)) {
  for (const line of readFileSync(secretFile, "utf8").split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && /MNEMONIC|PRIVATE|SECRET|PASSWORD/i.test(line.slice(0, i))) {
      const v = line
        .slice(i + 1)
        .replace(/^"|"$/g, "")
        .trim();
      if (v.length >= 16) known.push(v);
    }
  }
}
const patterns = [
  [/(^|\/)\.env(\.|$)(?!example)/, "env file"],
  [/\.(pem|key|p12)$/, "key file"],
];
const contentRules = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key block"],
  [/QORE_MNEMONIC\s*=/, "mnemonic variable assignment"],
  [/\/Users\/[a-z0-9._-]+\//i, "personal absolute path"],
];
const allowPath = [/^tests\/testnet\/src\/devwallet\.ts$/, /^tools\/repo-audit\.mjs$/];
for (const f of files) {
  for (const [re, what] of patterns) if (re.test(f)) problems.push(`${f}: ${what}`);
  if (!existsSync(f) || /\.(png|jpg|jpeg|webp|gif|ico|woff2?|ttf|mp4|pdf)$/i.test(f)) continue;
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const v of known) if (text.includes(v)) problems.push(`${f}: contains a value from the testnet wallet file`);
  if (allowPath.some((r) => r.test(f))) continue;
  for (const [re, what] of contentRules) if (re.test(text)) problems.push(`${f}: ${what}`);
}
if (problems.length) {
  console.error("repo audit failed:\n" + problems.map((p) => "  " + p).join("\n"));
  process.exit(1);
}
console.log(`repo audit: ${files.length} files clean`);
