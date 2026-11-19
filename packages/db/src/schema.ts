/**
 * Postgres schema. Every row is public data or metadata about ciphertext; the
 * server never stores a phrase, a key or plaintext (ARCHITECTURE.md section 4).
 */
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const accounts = pgTable("accounts", {
  address: text("address").primaryKey(),
  createdAt: ts("created_at").notNull().defaultNow(),
  lastSeen: ts("last_seen").notNull().defaultNow(),
});

export const authNonces = pgTable("auth_nonces", {
  nonce: text("nonce").primaryKey(),
  address: text("address").notNull(),
  message: text("message").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

export const sessions = pgTable(
  "sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    address: text("address").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("sessions_address").on(t.address)],
);

/** Mirror of MizuhikiRegistry name records (indexer). */
export const names = pgTable(
  "names",
  {
    name: text("name").primaryKey(),
    nameHash: text("name_hash").notNull(),
    address: text("address").notNull(),
    evm: text("evm").notNull(),
    primary: boolean("primary").notNull().default(false),
    claimedTx: text("claimed_tx").notNull(),
    claimedBlock: bigint("claimed_block", { mode: "bigint" }).notNull(),
  },
  (t) => [index("names_address").on(t.address), uniqueIndex("names_hash").on(t.nameHash)],
);

/** Recipient cards: verified on upload against the chain registries; hash matches the registry. */
export const cards = pgTable("cards", {
  address: text("address").primaryKey(),
  card: jsonb("card").notNull(),
  cardHash: text("card_hash").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

/** Published, owner-signed page manifests. */
export const pages = pgTable("pages", {
  address: text("address").primaryKey(),
  name: text("name").notNull(),
  record: jsonb("record").notNull(),
  version: integer("version").notNull(),
  publishedAt: ts("published_at").notNull().defaultNow(),
  takenDown: boolean("taken_down").notNull().default(false),
  unpublished: boolean("unpublished").notNull().default(false),
});

/** Drafts are sealed to the owner; the server holds only the blob hash. */
export const drafts = pgTable("drafts", {
  address: text("address").primaryKey(),
  blobHash: text("blob_hash").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const blobs = pgTable("blobs", {
  hash: text("hash").primaryKey(),
  size: integer("size").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  expiresAt: ts("expires_at"),
});

/** Sealed items addressed to an owner (messages, files, form answers, notes…). */
export const envelopes = pgTable(
  "envelopes",
  {
    hash: text("hash").primaryKey(),
    owner: text("owner").notNull(),
    kind: text("kind").notNull(),
    /** Public reference the item belongs to (form id, invoice id, payment tx…), never content. */
    ref: text("ref"),
    size: integer("size").notNull(),
    readers: integer("readers").notNull(),
    chunks: jsonb("chunks").$type<string[]>().notNull().default([]),
    senderSig: jsonb("sender_sig"),
    createdAt: ts("created_at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
    archived: boolean("archived").notNull().default(false),
    readAt: ts("read_at"),
  },
  (t) => [index("envelopes_owner").on(t.owner, t.createdAt), index("envelopes_ref").on(t.ref)],
);

/** Payments to known owners, from the chain (indexer). */
export const payments = pgTable(
  "payments",
  {
    txHash: text("tx_hash").notNull(),
    msgIndex: integer("msg_index").notNull(),
    fromAddr: text("from_addr").notNull(),
    toAddr: text("to_addr").notNull(),
    denom: text("denom").notNull(),
    amount: text("amount").notNull(),
    memo: text("memo").notNull(),
    kind: text("kind"),
    ref: text("ref"),
    noteHash: text("note_hash"),
    height: bigint("height", { mode: "bigint" }).notNull(),
    time: ts("time").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.txHash, t.msgIndex] }),
    index("payments_to").on(t.toAddr, t.time),
    index("payments_ref").on(t.ref),
  ],
);

/** Content-blind counters: views and taps per day, no IPs, no cookies. */
export const counters = pgTable(
  "counters",
  {
    owner: text("owner").notNull(),
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    subject: text("subject").notNull().default(""),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.owner, t.day, t.kind, t.subject] })],
);

export const indexCheckpoints = pgTable("index_checkpoints", {
  stream: text("stream").primaryKey(),
  position: text("position").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const reports = pgTable("reports", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  reason: text("reason").notNull(),
  detail: text("detail").notNull().default(""),
  createdAt: ts("created_at").notNull().defaultNow(),
  resolved: boolean("resolved").notNull().default(false),
});

export const pushSubscriptions = pgTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  address: text("address").notNull(),
  keys: jsonb("keys").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const notifyPrefs = pgTable("notify_prefs", {
  address: text("address").primaryKey(),
  email: text("email"),
  prefs: jsonb("prefs").notNull().default({}),
});

/** Public images (avatars, covers, product art). Served as-is with a fixed content type. */
export const media = pgTable("media", {
  hash: text("hash").primaryKey(),
  owner: text("owner").notNull(),
  type: text("type").notNull(),
  size: integer("size").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/**
 * Every MizuhikiRegistry and CapsuleVault event, decoded. The indexer's
 * materialised tables (names, rooms, capsules…) are rebuilt from this log.
 */
export const chainEvents = pgTable(
  "chain_events",
  {
    contract: text("contract").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: bigint("block", { mode: "bigint" }).notNull(),
    event: text("event").notNull(),
    args: jsonb("args").notNull(),
    time: ts("time"),
  },
  (t) => [primaryKey({ columns: [t.txHash, t.logIndex] }), index("chain_events_event").on(t.event, t.block)],
);

/**
 * Invoices (spec 5.6). The server holds only hashes of sealed copies, the
 * owner's signature over them, and flags. Amounts, items, the client and the
 * due date are inside the sealed invoice; status is worked out on devices.
 */
export const invoices = pgTable(
  "invoices",
  {
    /** Random id; also the payment reference in the memo `mzk:inv:<id>`. */
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    /** Sealed invoice (owner, link key, known payer). Null while a draft. */
    envelope: text("envelope"),
    /** Sealed working copy and memo to self (owner only). */
    privateEnvelope: text("private_envelope").notNull(),
    /** Owner's signature over {id, envelope}; checked by payers against the owner's key on chain. */
    sig: jsonb("sig"),
    state: text("state").notNull().default("draft"),
    archived: boolean("archived").notNull().default(false),
    /** Reported by the payer's browser when it opened the invoice. */
    viewedAt: ts("viewed_at"),
    /** Owner's "Record payment": an unverified override, shown as such. */
    recordedPaidAt: ts("recorded_paid_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    sentAt: ts("sent_at"),
  },
  (t) => [index("invoices_owner").on(t.owner, t.createdAt)],
);

/**
 * Forms (spec 5.9). The published definition is public and owner-signed;
 * the working draft is sealed to the owner. Answers are envelopes
 * (kind "form", ref "form:<id>") and never touch this table.
 */
export const forms = pgTable(
  "forms",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    slug: text("slug").notNull(),
    /** Sealed working copy (owner only). */
    draftEnvelope: text("draft_envelope"),
    /** Signed published definition, or null before the first publish. */
    record: jsonb("record"),
    version: integer("version").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    publishedAt: ts("published_at"),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("forms_owner").on(t.owner), uniqueIndex("forms_owner_slug").on(t.owner, t.slug)],
);

/**
 * Shared results snapshots (spec 5.9). The sealed snapshot is a blob kept until
 * the owner deletes it; this row holds only the owner's signature over
 * {formId, envelope} and a public label. The link key never reaches the server.
 */
export const snapshots = pgTable(
  "snapshots",
  {
    /** The sealed snapshot's blob hash. */
    hash: text("hash").primaryKey(),
    owner: text("owner").notNull(),
    formId: text("form_id").notNull(),
    /** Public label (the form title), at most 200 characters. Never answers. */
    title: text("title").notNull(),
    /** Owner's "snapshot" signature over {formId, envelope}; viewers check it against the chain. */
    sig: jsonb("sig").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("snapshots_owner_form").on(t.owner, t.formId, t.createdAt)],
);
