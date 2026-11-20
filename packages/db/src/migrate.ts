import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { makeDb } from "./client";

const FOLDER = fileURLToPath(new URL("../drizzle", import.meta.url));

/**
 * Drizzle records each applied migration by the SHA-256 of its file and never looks at it again, so a migration
 * edited after it ran on a database is silently skipped there (this once dropped a data-copy step on the dev
 * database). After migrating, every applied migration is checked against the file it came from.
 */
async function checkApplied(sql: ReturnType<typeof makeDb>["sql"]): Promise<void> {
  const journal = JSON.parse(readFileSync(`${FOLDER}/meta/_journal.json`, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const applied = await sql<
    { hash: string; created_at: string }[]
  >`select hash, created_at from drizzle.__drizzle_migrations`;
  const byWhen = new Map(applied.map((a) => [a.created_at, a.hash]));
  const changed = journal.entries.filter((e) => {
    const hash = byWhen.get(String(e.when));
    if (!hash) return false;
    return (
      createHash("sha256")
        .update(readFileSync(`${FOLDER}/${e.tag}.sql`, "utf8"))
        .digest("hex") !== hash
    );
  });
  if (changed.length)
    throw new Error(
      `These migrations changed after they were applied to this database: ${changed.map((e) => e.tag).join(", ")}. ` +
        "Put the change in a new migration instead.",
    );
}

export async function runMigrations(url: string): Promise<void> {
  const { db, sql } = makeDb(url);
  try {
    await migrate(db, { migrationsFolder: FOLDER });
    await checkApplied(sql);
  } finally {
    await sql.end();
  }
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  await runMigrations(process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki");
  console.log("migrations applied");
}
