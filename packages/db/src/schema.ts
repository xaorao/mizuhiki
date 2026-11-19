/**
 * Postgres schema. Every row is public data or metadata about ciphertext; the
 * server never stores a phrase, a key or plaintext (ARCHITECTURE.md section 4).
 */
import { sql } from "drizzle-orm";
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

/**
 * Rooms (spec 5.10, ARCHITECTURE 8a). The server knows ids, member addresses,
 * roles, epochs and the order of sealed batches; never names, content or authors.
 */
export const rooms = pgTable("rooms", {
  id: text("id").primaryKey(),
  chainId: text("chain_id").notNull(),
  owner: text("owner").notNull(),
  epoch: integer("epoch").notNull(),
  approval: boolean("approval").notNull().default(true),
  autoDeleteSeconds: integer("auto_delete_seconds").notNull().default(0),
  closed: boolean("closed").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const roomMembers = pgTable(
  "room_members",
  {
    roomId: text("room_id").notNull(),
    address: text("address").notNull(),
    role: text("role").notNull().default("member"),
    permissions: jsonb("permissions").$type<string[]>().notNull().default(["send", "files", "add", "info", "pin"]),
    /** active | left | removed | blocked */
    status: text("status").notNull().default("active"),
    joinedEpoch: integer("joined_epoch").notNull(),
    /** The epoch of this person's first admission; kept when they leave and rejoin. */
    firstEpoch: integer("first_epoch").notNull().default(1),
    /** Last epoch this person was a member of (set when they leave or are removed). */
    lastEpoch: integer("last_epoch"),
    lastReadSeq: bigint("last_read_seq", { mode: "bigint" }).notNull().default(sql`0`),
    muted: boolean("muted").notNull().default(false),
    joinedAt: ts("joined_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.address] }), index("room_members_address").on(t.address)],
);

export const roomEpochs = pgTable(
  "room_epochs",
  {
    roomId: text("room_id").notNull(),
    epoch: integer("epoch").notNull(),
    distribution: text("distribution").notNull(),
    membershipHash: text("membership_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    by: text("by").notNull(),
    reason: text("reason").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.epoch] })],
);

export const roomBatches = pgTable(
  "room_batches",
  {
    seq: bigint("seq", { mode: "bigint" }).generatedAlwaysAsIdentity().primaryKey(),
    roomId: text("room_id").notNull(),
    hash: text("hash").notNull(),
    epoch: integer("epoch").notNull(),
    size: integer("size").notNull(),
    /** SHA-256 of the author's delete token; the server never stores who posted. */
    deleteHash: text("delete_hash").notNull(),
    at: ts("at").notNull().defaultNow(),
    expiresAt: ts("expires_at"),
  },
  (t) => [index("room_batches_room").on(t.roomId, t.seq), uniqueIndex("room_batches_hash").on(t.roomId, t.hash)],
);

/** Older epoch keys sealed to someone admitted with "Share past messages". */
export const roomHistory = pgTable(
  "room_history",
  {
    roomId: text("room_id").notNull(),
    member: text("member").notNull(),
    envelope: text("envelope").notNull(),
    by: text("by").notNull(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.member, t.envelope] })],
);

export const roomInvites = pgTable(
  "room_invites",
  {
    id: text("id").primaryKey(),
    roomId: text("room_id").notNull(),
    /** SHA-256 of the secret carried in the link's fragment. */
    secretHash: text("secret_hash").notNull(),
    /** Blob hash of the invite card (room name, photo, who invited) sealed to the link key in the fragment. */
    card: text("card").notNull(),
    createdBy: text("created_by").notNull(),
    primary: boolean("primary").notNull().default(false),
    expiresAt: ts("expires_at"),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    revoked: boolean("revoked").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("room_invites_room").on(t.roomId)],
);

export const roomRequests = pgTable(
  "room_requests",
  {
    roomId: text("room_id").notNull(),
    address: text("address").notNull(),
    /** The invite link used, or "add:<address>" when a member with the add right suggested them. */
    inviteId: text("invite_id").notNull(),
    /** pending | approved | declined */
    status: text("status").notNull().default("pending"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.address] })],
);
