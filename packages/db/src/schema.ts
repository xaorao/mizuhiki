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
    /** A file request upload that arrived after its deadline (late uploads allowed). */
    late: boolean("late").notNull().default(false),
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
    lastReadSeq: bigint("last_read_seq", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
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

/**
 * Shop (spec 5.11, ARCHITECTURE 8b). Public product records are signed by the
 * owner; contents are sealed blobs. Orders store the buyer's request (which
 * binds their key through the order reference) and the delivery envelope.
 */
export const products = pgTable(
  "products",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    slug: text("slug").notNull(),
    kind: text("kind").notNull(),
    /** draft | published | unpublished */
    status: text("status").notNull().default("draft"),
    /** The signed public record (null until first published). */
    record: jsonb("record"),
    version: integer("version").notNull().default(0),
    /** The owner's sealed working copy (editor state and the product key). */
    draftEnvelope: text("draft_envelope").notNull(),
    /** The product key sealed to the delivery agent (instant delivery only). */
    agentEnvelope: text("agent_envelope"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("products_owner_slug").on(t.owner, t.slug), index("products_owner").on(t.owner)],
);

export const orders = pgTable(
  "orders",
  {
    ref: text("ref").primaryKey(),
    seller: text("seller").notNull(),
    request: jsonb("request").notNull(),
    /** The signed product records the buyer saw and the total was priced with (bundle parts included). */
    records: jsonb("records").notNull().default([]),
    token: text("token").notNull(),
    total: text("total").notNull(),
    dueNow: text("due_now").notNull(),
    dueLater: text("due_later").notNull(),
    /** Account recipient (also a gift's receiver), for "Purchases for this wallet". */
    recipientAddress: text("recipient_address"),
    /** SHA-256 of a buyer key's public parts, for buyers without an account. */
    recipientKeyHash: text("recipient_key_hash"),
    discountId: text("discount_id"),
    /** awaiting | paid | balance_due | delivered | refunded | expired */
    status: text("status").notNull().default("awaiting"),
    payer: text("payer"),
    depositTx: text("deposit_tx"),
    balanceTx: text("balance_tx"),
    refundTx: text("refund_tx"),
    /** Blob hash of the product keys sealed to the recipient. */
    delivery: text("delivery"),
    deliveredBy: text("delivered_by"),
    reviewHash: text("review_hash").notNull(),
    /** SHA-256 of the requester's network address, only to cap unpaid holds per address (never shown). */
    holdBy: text("hold_by"),
    /** The seller asked for the rest of a commission. */
    balanceRequested: boolean("balance_requested").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
    paidAt: ts("paid_at"),
    deliveredAt: ts("delivered_at"),
    /** Unpaid orders give back their reserved stock and call slots after this. */
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [
    index("orders_seller").on(t.seller, t.createdAt),
    index("orders_recipient").on(t.recipientAddress),
    index("orders_key").on(t.recipientKeyHash),
  ],
);

/** One booked call slot per product; held while an order is unpaid, kept once paid. */
export const orderSlots = pgTable(
  "order_slots",
  {
    productId: text("product_id").notNull(),
    slot: text("slot").notNull(),
    orderRef: text("order_ref").notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.slot] })],
);

export const discounts = pgTable(
  "discounts",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    code: text("code").notNull(),
    percent: integer("percent"),
    amountOff: text("amount_off"),
    token: text("token"),
    productIds: jsonb("product_ids").$type<string[]>().notNull().default([]),
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    expiresAt: ts("expires_at"),
    active: boolean("active").notNull().default(true),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("discounts_owner_code").on(t.owner, t.code)],
);

export const reviews = pgTable(
  "reviews",
  {
    orderRef: text("order_ref").notNull(),
    productId: text("product_id").notNull(),
    seller: text("seller").notNull(),
    rating: integer("rating").notNull(),
    text: text("text").notNull().default(""),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.orderRef, t.productId] }), index("reviews_product").on(t.productId)],
);

/**
 * Passes (spec 5.12, ARCHITECTURE 8c). The invite is signed by the owner and
 * the acceptance by the holder; keys travel only as sealed envelopes.
 */
export const passes = pgTable(
  "passes",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    holder: text("holder").notNull(),
    /** The signed invite (scope, boundary, expiry). */
    invite: jsonb("invite").notNull(),
    /** The holder's signed acceptance. */
    accept: jsonb("accept"),
    /** invited | accepted | active | revoked (expiry is worked out from expiresAt) */
    status: text("status").notNull().default("invited"),
    /** For a period pass: the scoped key's index (unique per owner). */
    keyIndex: integer("key_index"),
    /** Blob hash: the period key's seed, or a product's key, sealed to the holder. */
    keyEnvelope: text("key_envelope"),
    expiresAt: ts("expires_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    acceptedAt: ts("accepted_at"),
    confirmedAt: ts("confirmed_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [
    index("passes_owner").on(t.owner),
    index("passes_holder").on(t.holder),
    uniqueIndex("passes_owner_key").on(t.owner, t.keyIndex),
  ],
);

/** Items re-sealed to a pass by the owner's device (older items, or "Add a reader"). */
export const passItems = pgTable(
  "pass_items",
  {
    passId: text("pass_id").notNull(),
    /** What was re-sealed: an envelope hash, or "invoice:<id>". */
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    /** Blob hash of the copy sealed to the pass key. */
    envelope: text("envelope").notNull(),
    /** When the original item was sent (what decides the period). */
    itemAt: ts("item_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.passId, t.source] })],
);

/**
 * Spare key and recovery (spec 5.13, ARCHITECTURE 8d). Pieces of the phrase
 * exist here only as envelopes sealed to each contact; the server never holds
 * a piece it can open.
 */
export const recoverySettings = pgTable("recovery_settings", {
  owner: text("owner").primaryKey(),
  /** Pieces needed to rebuild the phrase (of the current version's contacts). */
  threshold: integer("threshold").notNull().default(2),
  /** Current piece set; bumped on every re-split. */
  version: integer("version").notNull().default(0),
  sheetSavedAt: ts("sheet_saved_at"),
  testedAt: ts("tested_at"),
  /** The offline reader's public key {mlkem, x25519} (hex), when turned on. */
  offlineKey: jsonb("offline_key"),
  offlineSheetSavedAt: ts("offline_sheet_saved_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const recoveryContacts = pgTable(
  "recovery_contacts",
  {
    owner: text("owner").notNull(),
    contact: text("contact").notNull(),
    /** invited | accepted | confirmed | declined | removed */
    status: text("status").notNull().default("invited"),
    invite: jsonb("invite").notNull(),
    accept: jsonb("accept"),
    /** Blob hash of this contact's piece (current version only). */
    piece: text("piece"),
    pieceVersion: integer("piece_version"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.contact] }), index("recovery_contacts_contact").on(t.contact)],
);

export const recoveryRequests = pgTable(
  "recovery_requests",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    /** The one-time seal key on the new device {mlkem, x25519} (hex). */
    recipient: jsonb("recipient").notNull(),
    /** SHA-256 of the request's secret, which only the new device holds. */
    secretHash: text("secret_hash").notNull(),
    /** A dry run started by the signed-in owner: no wait. */
    test: boolean("test").notNull().default(false),
    version: integer("version").notNull(),
    threshold: integer("threshold").notNull(),
    /** open | waiting | ready | cancelled | done | expired */
    status: text("status").notNull().default("open"),
    /** IP hash of whoever started it (rate limit only). */
    ipHash: text("ip_hash"),
    createdAt: ts("created_at").notNull().defaultNow(),
    releaseAt: ts("release_at"),
    cancelledAt: ts("cancelled_at"),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("recovery_requests_owner").on(t.owner)],
);

export const recoveryAnswers = pgTable(
  "recovery_answers",
  {
    requestId: text("request_id").notNull(),
    contact: text("contact").notNull(),
    /** Blob hash: the contact's piece re-sealed to the one-time key. */
    envelope: text("envelope").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.requestId, t.contact] })],
);

/** A one-time challenge sealed to an owner's offline reader key; opening it proves the key is held. */
export const recoveryChallenges = pgTable("recovery_challenges", {
  id: text("id").primaryKey(),
  owner: text("owner").notNull(),
  nonceHash: text("nonce_hash").notNull(),
  expiresAt: ts("expires_at").notNull(),
});

/** Older items re-sealed to the offline reader key by the owner's device. */
export const recoveryOfflineItems = pgTable(
  "recovery_offline_items",
  {
    owner: text("owner").notNull(),
    /** The original item: an envelope hash, or "invoice:<id>". */
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    ref: text("ref"),
    envelope: text("envelope").notNull(),
    itemAt: ts("item_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.owner, t.source] })],
);

/**
 * Capsules (spec 5.14, ARCHITECTURE 8e). The chain decides release; this is the
 * plan (signed by the owner), guardians' consent, and the envelopes guardians
 * re-seal to recipients after release. Nothing here can be opened by us.
 */
export const capsules = pgTable(
  "capsules",
  {
    /** bytes32 hex, the CapsuleVault id. */
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    label: text("label").notNull(),
    /** Blob hash of the owner's working copy (sealed to the owner only): chosen files, recipients, settings. */
    draftEnvelope: text("draft_envelope").notNull(),
    /** The signed plan, once armed. */
    plan: jsonb("plan"),
    /** draft | armed | cancelled (the chain has the rest). */
    state: text("state").notNull().default("draft"),
    armedTx: text("armed_tx"),
    /** When the owner was last reminded to check in ("if I go quiet"), so reminders come at most once a day. */
    remindedAt: ts("reminded_at"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("capsules_owner").on(t.owner)],
);

export const capsuleGuardians = pgTable(
  "capsule_guardians",
  {
    capsuleId: text("capsule_id").notNull(),
    guardian: text("guardian").notNull(),
    /** invited | accepted | confirmed | declined | removed */
    status: text("status").notNull().default("invited"),
    invite: jsonb("invite").notNull(),
    accept: jsonb("accept"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.capsuleId, t.guardian] }), index("capsule_guardians_guardian").on(t.guardian)],
);

/** A guardian's piece for one recipient, re-sealed to that recipient after release. */
export const capsuleReleases = pgTable(
  "capsule_releases",
  {
    capsuleId: text("capsule_id").notNull(),
    guardian: text("guardian").notNull(),
    recipient: text("recipient").notNull(),
    planVersion: integer("plan_version").notNull(),
    envelope: text("envelope").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.capsuleId, t.guardian, t.recipient] }),
    index("capsule_releases_recipient").on(t.recipient),
  ],
);

/**
 * File requests (spec 5.7, ARCHITECTURE 8g): the owner's signed public record.
 * Uploads are envelopes with ref `freq:<id>`; nothing here can be opened by us.
 */
export const fileRequests = pgTable(
  "file_requests",
  {
    id: text("id").primaryKey(),
    owner: text("owner").notNull(),
    /** Signed FileRequest (kind "filerequest"), checked against the owner's key on chain. */
    record: jsonb("record").notNull(),
    /** open | closed (mirrors the signed record, for listing). */
    status: text("status").notNull(),
    version: integer("version").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("file_requests_owner").on(t.owner, t.createdAt)],
);
