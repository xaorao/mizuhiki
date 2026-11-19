import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { makeDb } from "./client";

export async function runMigrations(url: string): Promise<void> {
  const { db, sql } = makeDb(url);
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)) });
  await sql.end();
}

if (import.meta.url === `file://${process.argv[1] ?? ""}`) {
  await runMigrations(process.env.DATABASE_URL ?? "postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki");
  console.log("migrations applied");
}
