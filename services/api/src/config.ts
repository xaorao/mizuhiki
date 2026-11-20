import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().default("postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki"),
  BLOB_DIR: z.string().default("var/blobs"),
  /** The web app's origin: CORS, and the SIWQ domain and uri. */
  WEB_ORIGIN: z.string().default("http://localhost:3000"),
  /** Largest sealed object accepted in one request. Files arrive as 4 MiB chunks plus overhead. */
  MAX_BLOB_BYTES: z.coerce
    .number()
    .int()
    .default(4 * 1024 * 1024 + 64 * 1024),
  /** Proof-of-work bits required on anonymous drops. */
  POW_BITS: z.coerce.number().int().min(0).max(28).default(16),
  /** Days a dropped envelope is kept (spec 5.7: "We delete the sealed copy after N days"). */
  DROP_RETENTION_DAYS: z.coerce.number().int().default(30),
  SESSION_HOURS: z.coerce.number().int().default(12),
  /** Wait between the last needed contact answering and pieces being released to a new device (spec 5.13: 48 hours). */
  /** Web Push (spec 5.17): this server's VAPID key pair, made by `pnpm --filter @mizuhiki/api push:keys`. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  RECOVERY_DELAY_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .default(48 * 3600),
});

export type Config = z.infer<typeof Env>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return Env.parse(env);
}
