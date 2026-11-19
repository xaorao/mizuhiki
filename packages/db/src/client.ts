import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

export type Db = ReturnType<typeof makeDb>["db"];
export function makeDb(url: string) {
  const sql = postgres(url, { max: 10, idle_timeout: 30, prepare: true, onnotice: () => undefined });
  return { sql, db: drizzle(sql, { schema }) };
}
