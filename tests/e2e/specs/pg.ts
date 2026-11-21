/** Postgres client tools for source-of-truth checks: `PG_BIN` if set, else Homebrew's postgresql@17, else PATH. */
import { existsSync } from "node:fs";
import { join } from "node:path";

const HOMEBREW = "/opt/homebrew/opt/postgresql@17/bin";
const bin = process.env.PG_BIN ?? (existsSync(HOMEBREW) ? HOMEBREW : "");
export const PSQL = bin ? join(bin, "psql") : "psql";
