import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().default("postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki"),
  BLOB_DIR: z.string().default("var/blobs"),
  /**
   * The web app's origin: CORS, and the SIWQ domain and uri. A comma-separated list serves one API to several sites
   * (a local copy and a hosted one); the first is the default.
   */
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
  /** Web Push (spec 5.17): this server's VAPID key pair, made by `pnpm --filter @mizuhiki/api push:keys`. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  /** Wait between the last needed contact answering and pieces being released to a new device (spec 5.13: 48 hours). */
  RECOVERY_DELAY_SECONDS: z.coerce
    .number()
    .int()
    .min(0)
    .default(48 * 3600),
  /**
   * Reverse proxies in front of the API whose X-Forwarded-For is trusted (security review L3). 0 when the API
   * faces clients directly; behind one proxy, 1, or every per-network limit would see one address for everyone.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  /**
   * A shared secret the hosted web app's server sends with its own public reads (page, form, product lookups), so
   * every visitor's page load is not counted against the hosting provider's one address. Unset: no such allowance.
   */
  INTERNAL_READ_KEY: z.string().min(32).optional(),
  /**
   * Starter grants (ARCHITECTURE 8h): the testnet sponsor account's 24 words. Unset, grants are off and sign-up shows
   * the faucet. Testnet only; never a phrase that holds real value.
   */
  SPONSOR_PHRASE: z.string().optional(),
  /** Test QOR sent once to a new account, in uqor. Sign-up spends about 120,000; 200,000 leaves room. */
  STARTER_GRANT_UQOR: z.coerce.number().int().min(1).max(5_000_000).default(200_000),
  /** Grants a day across everyone, and per network address. */
  STARTER_DAILY_CAP: z.coerce.number().int().min(0).default(300),
  STARTER_PER_IP_DAY: z.coerce.number().int().min(0).default(5),
  /** Grant requests per network address in 10 minutes, before any other check. */
  STARTER_REQUESTS_PER_10MIN: z.coerce.number().int().min(1).default(6),
  /** Proof-of-work bits on a grant request: a few seconds of browser work, nothing for one person. */
  STARTER_POW_BITS: z.coerce.number().int().min(0).max(28).default(18),
});

export type Config = z.infer<typeof Env>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = Env.parse(env);
  if (webOrigins(cfg).length === 0) throw new Error("WEB_ORIGIN must name at least one origin");
  for (const o of webOrigins(cfg))
    if (new URL(o).origin !== o)
      throw new Error(`WEB_ORIGIN must list bare origins like https://example.com, not ${o}`);
  return cfg;
}

/** Every web origin this API serves, in the order given. */
export function webOrigins(cfg: Pick<Config, "WEB_ORIGIN">): string[] {
  return cfg.WEB_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

/**
 * The origin a sign-in message is bound to: the requesting site when it is one we serve, otherwise the first. A
 * message is only ever bound to a listed origin, so a site not on the list cannot get one naming itself.
 */
export function webOriginFor(cfg: Pick<Config, "WEB_ORIGIN">, requestOrigin: string | undefined): string {
  const list = webOrigins(cfg);
  return requestOrigin && list.includes(requestOrigin) ? requestOrigin : (list[0] ?? "http://localhost:3000");
}
