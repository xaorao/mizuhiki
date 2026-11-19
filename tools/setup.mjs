// One-time setup: contract test library and the local database.
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
const run = (c, cwd) => execSync(c, { stdio: "inherit", cwd });
if (!existsSync("contracts/lib/forge-std")) run("forge install foundry-rs/forge-std@v1.17.0 --no-git", "contracts");
console.log("setup complete");
