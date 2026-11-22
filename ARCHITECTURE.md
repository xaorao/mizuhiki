# Mizuhiki architecture

Mizuhiki gives every person or business one page, `@name`. Anyone can pay that person, send them a sealed message or file, answer their forms, buy from their shop or join their rooms. Everything is sealed on the sender's device to the readers the owner chose. This document is the technical plan: the parts, how data moves, the data model, where every key lives, and why each large choice was made. The threat model is in `THREAT_MODEL.md`.

Product behaviour is specified outside this repository (product spec, sections 0 to 11). Where this document and the spec disagree on behaviour, the spec wins; where they disagree on mechanism, this document wins and records why.

## 1. Principles that shape the system

1. **Keys never leave the owner's device.** Sealing, opening, signing and key handling run only in the browser. Our servers store ciphertext, public records and counts.
2. **The chain is the source of truth for anything that must be trusted:** keys (ML-DSA-87 and ML-KEM-1024 registries), names, proof anchors, room epochs, capsule state, payments. Our database is a cache that any third party can rebuild from public chain data plus the blob store.
3. **A stolen classical key has no authority.** Every contract action by an owner or guardian is authorised inside the contract by an ML-DSA-87 signature checked with the `pqcVerify` precompile, and every EVM transaction additionally runs inside an authorisation window that only the post-quantum key can open.
4. **Content-blind services.** The drop service, relay and blob store never parse an envelope beyond its header magic and size.
5. **No silent fallback.** Every chain, network and crypto call has an explicit error path that says what happened to the user's data first.

## 2. Parts

```
                     ┌───────────────────────────── browser ─────────────────────────────┐
                     │  apps/web (Next.js, React)                                        │
 visitor / owner ──▶ │   UI ── @mizuhiki/ui (design system)                              │
                     │   @mizuhiki/core  seal · open · file chunks · keys · manifest     │
                     │   @mizuhiki/chain  hybrid tx · window · contracts · QoreX         │
                     │   key vault (IndexedDB, passphrase / passkey-PRF wrapped)          │
                     └───────┬───────────────────────────────┬───────────────────────────┘
                             │ HTTPS + WebSocket             │ REST / EVM JSON-RPC
                             ▼                               ▼
   ┌────────────── services/api (Fastify) ──────────────┐   QoreChain testnet qorechain-diana
   │ pages · drop · blobs · relay · inbox index · auth   │   REST  api-testnet.qore.host
   │ forms · invoices · shop · passes · insights · push  │   EVM   evm-testnet.qore.host (9800)
   └──────┬──────────────────────────────┬──────────────┘   KEM + ML-DSA registries
          │ Postgres (cache + metadata)  │ blob store         MizuhikiRegistry, CapsuleVault
          ▼                              ▼                         ▲
   ┌──────────────┐               ┌──────────────┐                 │ eth_getLogs, tx search
   │ PostgreSQL 17│◀── LISTEN ────│ services/    │─────────────────┘
   └──────────────┘    NOTIFY     │ indexer      │
          ▲                       └──────────────┘
          └──────── services/delivery-agent (optional per product, its own key)
```

### 2.1 `apps/web` — the only place keys exist

- Next.js (App Router) with React 19. Landing, public pages (`/@name`, `/@name/pay/25`, `/@name/f/<slug>`, `/@name/p/<slug>`), invoice links, proof certificates and form respondent pages render on the server from **public, signed** data only, so they are fast on a phone and have real social cards. The owner app (`/app/...`) and every flow that touches keys are client components. No server component ever receives key material, because none exists on the server.
- Installable PWA: a service worker caches the app shell and already-opened items for offline reading; sends made offline queue in IndexedDB and say so.
- Key vault: the 24-word phrase is encrypted with AES-256-GCM under a key from PBKDF2-SHA-256 (600,000 iterations, per-vault salt) over the device passphrase, and optionally a second wrap under a WebAuthn PRF secret (passkey unlock, verified in Chromium; real devices NOT VERIFIED). Only the wrapped phrase is stored (IndexedDB). Unlocked keys live in memory in the tab, are dropped on "Lock now", on idle timeout and on tab close. A `BroadcastChannel` lock makes a second tab show "Open elsewhere".

### 2.2 `packages/core` — sealing, keys, files, manifests (pure TypeScript, runs in browser and Node)

- Wraps `@qorechain/qoreseal` 0.1.0 and `@qorechain/qoresign` 0.2.0 with Mizuhiki purposes (`mzk:msg`, `mzk:file`, `mzk:form:<id>`, `mzk:inv:<id>`, `mzk:room:<id>`, `mzk:pass:<id>`, `mzk:capsule:<id>`, `mzk:order:<id>`, `mzk:draft`, `mzk:share:<id>`), all matching QoreSeal's purpose rule `^[A-Za-z0-9._:/-]{1,128}$`.
- Account derivation from one BIP-39 24-word phrase: classical `eth_secp256k1` key (so the same 20 bytes serve the native and EVM lanes, verified live), canonical ML-DSA-87 key (`deriveCanonicalPqKey`), seal keys by index (`deriveSealKeys`, index 0 = owner, 1.. = period and scoped keys).
- File sealing (our own code on standard primitives): a random 32-byte file key, AES-256-GCM over 4 MiB chunks, IV = 8 random bytes of a per-file nonce prefix plus a 4-byte big-endian chunk counter, AAD = `mzk:file|<fileId>|<index>|<count>` so chunks cannot be reordered, truncated or moved between files. A small QoreSeal envelope seals `{fileKey, name, size, type, sha256, chunkCount, chunkHashes}` to the readers. Adding a reader re-seals only that small envelope.
- Signed objects (page manifest, sender signature, room records, receipts): QoreSign hybrid message signatures, verified against the signer's **on-chain** ML-DSA-87 key (`verifyMessageWithChain`). Canonical JSON (sorted keys, no whitespace) so a signature is reproducible.

### 2.3 `packages/chain` — chain access for browser and Node

- Hybrid native transactions built and signed with QoreSign (`signHybrid`, SIGN_MODE_DIRECT, sign-bytes v2 read from the chain), simulated before signing, broadcast with `submitWithSignBytesFallback`, then confirmed by polling the committed transaction. Code is adapted from the proven spike (`spikes/chain/lib.mjs`).
- EVM authorisation windows (`openEvmWindowMsg`, `closeEvmWindowMsg`, `fetchEvmWindow` from `@qorechain/sdk`): opened once per session for at most 2 hours of blocks (computed from recent block time, capped at 17,280), up to 20 transactions, a fee budget, `allowedTargets` = our two contracts only. The window advances the nonce, so EVM transactions are always signed after the open.
- Contract clients (viem) for `MizuhikiRegistry` and `CapsuleVault`, with every precompile return length checked.
- QoreX visitor payments: `window.qorex.native.signAndBroadcast` after checking `capabilities`, detection through `@qorechain/qorex-types`; nothing else from QoreX is relied on (`signArbitrary` is unsupported).

### 2.4 `packages/ui` — the design system

React components built from `brand/system/project/tokens.css` and the approved Level 3 preview: buttons, rows, chips, fields, toggles, sheets, toasts, tabs, stat tiles, panels, the phone preview, Musubi in six faces with reactions, the seal moment, the receipt, empty, loading, error and offline states. Styling is CSS Modules over the token custom properties (no utility framework, so the stylesheet stays a direct expression of the tokens). Motion uses CSS keyframes and `motion` for springs and exit animations, always gated by reduced motion. A `/design` route shows every component in every state.

### 2.5 `services/api` — content-blind HTTP and WebSocket service (Fastify 5)

- **Auth:** Sign In With QoreChain (`createSiwqMessage` / `verifySiwq` + on-chain key check). A successful sign-in returns a short-lived session token bound to the address. Owner-only endpoints (inbox index, drafts, form results counters, settings) require it. Visitor endpoints need no account.
- **Pages:** `PUT /pages/:address` takes a signed manifest; the server verifies the hybrid signature against the chain, checks the name record on the registry, stores it and serves it. `GET /pages/@:name` returns manifest plus signature so every visitor's browser verifies it again.
- **Drop:** `POST /drop/:address` takes envelope bytes, checks header magic, size cap, rate limit per IP-hash and per recipient, and a proof-of-work stamp (SHA-256 hashcash bound to recipient, size and minute). Stores the blob, writes a metadata row, notifies the owner. File chunks use `POST /blobs` (content-addressed, the drop references them).
- **Blobs:** content-addressed (`sha256`) store behind a `BlobStore` interface; the shipped implementation is a sharded filesystem store with atomic rename writes. What keeps a blob is a set of holds (`blob_holds`: account, purpose, optional expiry; `lib/holds.ts`): a blob lives while it is less than a day old or any hold on it is live, and the sweep removes the rest. Routes add and release only their caller's own holds, so knowing a hash never lets anyone delete another account's copy (THREAT_MODEL A2). Storage is replaceable without touching callers.
- **Relay:** WebSocket fan-out of sealed room batches with per-room sequence numbers; offline members fetch from storage on return.
- **Inbox index, forms, invoices, shop, passes, capsules, insights, push:** metadata and counters only; contents are sealed blobs.
- **Abuse:** report endpoint and takedown of public pages; sealed content cannot be read, so it can only be expired.

### 2.6 `services/indexer` — a pure function of public data

Follows the chain and writes the cache tables: payments to known owners (REST tx search by `transfer.recipient` and `message.sender` events, memo read from the transaction body, never searched), `MizuhikiRegistry` and `CapsuleVault` logs (`eth_getLogs` over bounded block ranges, checkpointed), and links payments to invoices and orders by memo reference, amount and denom. It publishes changes with Postgres `NOTIFY` so the API pushes them to open dashboards. Rebuilding from an empty database reproduces the same state.

### 2.7 `services/delivery-agent` — opt-in instant shop delivery

By default the **seller's own device** delivers: when the dashboard is open (or next opens) it seals the product key to each paid buyer. A seller may switch a product to "Instant delivery": the product key is then also sealed to the agent's key, and the agent seals it to the buyer once the indexer confirms a matching payment. The product page states that the helper can read that file. The agent holds one account of its own (testnet), runs separately and is self-hostable.

### 2.8 `contracts` — Solidity (Foundry), EVM lane

- **`MizuhikiRegistry`:** names (claim, release, transfer), recipient card hash per address, proof anchors made before AnchorBook (read-only in practice; still shown on certificates), room records (create, epoch change with membership hash and distribution hash, role changes), form and product publication hashes, pass records. Every owner action carries an ML-DSA-87 signature over `keccak256(abi.encode(TAG, chainid, this, action fields, nonce))`, verified with `pqcVerify` (0x…0A01) against the key from `pqcKeyStatus` (0x…0A02); per-address nonces stop replay. Events are indexed for `eth_getLogs`.
- **`AnchorBook`:** proof anchors, one record per account per fingerprint (time, block, kind), ML-DSA-authorised and relayable like the registry. A first-come registry record let anyone who learned a fingerprint anchor it before its author and make the author's anchor fail (security review M2); here every account's record stands, and certificates list all of them, earliest first. Testnet `0x9d5379a7f28bae86e087abb8e7a72274335f316a` (deploy tx `0xa2e4eeb8…`).
- **`CapsuleVault`:** owner, guardians, threshold, mode (at a time, after a wait, if quiet), wait and quiet periods, last check-in, request state and status. Owner check-in, cancel, reject, and guardian request and approval are all ML-DSA-authorised and relayable. Release is a state flip at block time; guardians' clients read it before sealing their shares to recipients.
- Unit tests run under Foundry with a verifier stand-in deployed at the precompile address by the test harness (the local EVM has no ML-DSA precompile); the same attacks (bad signature, replay, wrong signer, wrong contract, expired) are then re-run against the deployed contracts on testnet with real ML-DSA-87 signatures.

## 3. How data moves (main flows)

1. **Sign-up.** Browser makes the phrase → derives keys → owner retypes three words → device passphrase wraps the phrase → balance check (faucet link, polls) → `MsgRegisterPQCKeyV2` (classical-only, as the chain requires) → `MsgRegisterKEMKey` (hybrid) → recipient card signed and uploaded, card hash and name claimed on `MizuhikiRegistry` inside a scoped window → signed manifest published.
2. **Sealed message or file from a visitor.** Visitor's browser fetches the manifest and card → `resolveRecipient` checks the card against both on-chain registries → files: chunks encrypted and uploaded, then the key envelope; message: one envelope (anonymous flag on) → optional sender signature (Mizuhiki wallets only) → proof-of-work → `POST /drop` → receipt with envelope hash. Nothing leaves the device unsealed.
3. **Owner opens the inbox.** SIWQ session → inbox index (metadata) → envelopes fetched and opened locally → search runs locally over opened items.
4. **Payment.** Payer signs `MsgSend` (QoreX, Mizuhiki wallet, or manual) with memo `mzk:pay:<ref>:<noteHash>` → note envelope dropped → indexer links tx and note → owner sees Payment. Amounts and addresses are public, stated at the point of payment.
5. **Room.** Owner's browser runs `EpochKeyManager`; every membership change rotates the epoch, seals the new epoch key to members, records the epoch, membership hash and distribution hash on the registry, and posts the distribution through the relay. Messages are `PrivateBatchCodec` blobs. Epoch history is exported, sealed to the owner and stored, because `EpochKeyManager` is memory-only.
6. **Capsule.** Content key splits into Shamir shares (`shamir-secret-sharing`), each sealed to a guardian; the plan lives in `CapsuleVault`; on release guardians' clients check the contract state, then re-seal their share to the recipient; the recipient combines shares locally.

## 4. Data model

### On chain

| Record                                                | Where                                                        | Written by                                 |
| ----------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| ML-DSA-87 key, ML-KEM-1024 key                        | chain PQC module                                             | the owner's device                         |
| Payments, invoice and order settlement                | `MsgSend` with tagged memo                                   | the payer's wallet                         |
| Names, card hashes, room epochs, publications, passes | `MizuhikiRegistry` events and state                          | the owner (ML-DSA-authorised)              |
| Proof anchors                                         | `AnchorBook` (and older `MizuhikiRegistry`) events and state | each anchoring account (ML-DSA-authorised) |
| Capsule plans and state                               | `CapsuleVault`                                               | owner and guardians (ML-DSA-authorised)    |

### Off chain (PostgreSQL 17; every row is either public or ciphertext metadata)

| Table                                          | Columns (main)                                                                            | Notes                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ |
| `accounts`                                     | address, created_at, last_seen                                                            | from first SIWQ                      |
| `sessions`                                     | token_hash, address, expires_at                                                           | SIWQ sessions, token stored hashed   |
| `names`                                        | name, address, status, tx, block                                                          | mirror of the registry               |
| `cards`                                        | address, card_json, card_hash                                                             | verified on upload against chain     |
| `pages`                                        | address, name, manifest_json, signature, version, published_at                            | signed, public                       |
| `drafts`                                       | address, blob_hash, updated_at                                                            | draft sealed to the owner            |
| `envelopes`                                    | hash, owner, kind, size, recipients, sender_sig, created_at, expires_at, archived         | bytes in the blob store              |
| `blobs`                                        | hash, size, created_at                                                                    | content-addressed                    |
| `blob_holds`                                   | hash, holder, purpose, expires_at                                                         | who keeps a blob, and until when     |
| `payments`                                     | tx_hash, from, to, denom, amount, memo, height, time, kind, ref                           | from the indexer                     |
| `invoices`                                     | id, owner, number, link_blob, total, denom, due, status, paid_tx                          | contents sealed                      |
| `forms`                                        | id, owner, slug, definition_json, settings_json, counters                                 | questions are public by design       |
| `rooms`, `room_members`, `room_batches`        | id, owner, epoch, member addresses, seq, blob_hash                                        | from registry and relay              |
| `products`, `orders`                           | public product info, price, delivery mode; order id, buyer, tx, status, delivery envelope | contents sealed                      |
| `passes`                                       | id, owner, invitee, scope, period index, status                                           | key handed over sealed               |
| `capsules`                                     | id, vault id, state mirror                                                                | mirror of `CapsuleVault`             |
| `counters`                                     | owner, block id, day, kind, count                                                         | views and clicks, no IPs, no cookies |
| `push_subscriptions`, `notify_prefs`           | address, endpoint, keys, per-type toggles, optional email                                 | notify only, never content           |
| `reports`, `rate_buckets`, `index_checkpoints` | abuse, limits, indexer progress                                                           |                                      |

### Never stored by us

Phrases, private keys, passphrases, plaintext, filenames inside envelopes, decrypted anything.

## 5. Where every key and secret lives

| Secret                                                    | Lives                                                               | Protected by                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Owner's 24-word phrase and every key derived from it      | owner's browser (IndexedDB), wrapped; in memory only while unlocked | device passphrase (PBKDF2 600k) and optional passkey PRF; printed spare-key sheet; Shamir shares sealed to recovery contacts |
| Buyer key (first-time buyers)                             | buyer's browser plus their PDF                                      | same vault                                                                                                                   |
| Room epoch keys                                           | members' browsers; history sealed to the owner in the blob store    | QoreSeal                                                                                                                     |
| File keys                                                 | inside the file's QoreSeal envelope                                 | QoreSeal                                                                                                                     |
| Invoice link key                                          | URL fragment (never sent to a server)                               | whoever holds the link                                                                                                       |
| Capsule shares                                            | sealed to each guardian                                             | QoreSeal + `CapsuleVault` state                                                                                              |
| Delivery agent key (opt-in)                               | `services/delivery-agent` env file, gitignored                      | host access                                                                                                                  |
| Testnet dev wallet (tests and funding test personas only) | `~/.secrets/qorechain/testnet-wallet.env`, outside the repo         | file permissions; never printed or committed                                                                                 |
| Session tokens                                            | client memory; server stores SHA-256 only                           | expiry                                                                                                                       |
| VAPID keys, SMTP credentials                              | `services/api` env, gitignored                                      | host access                                                                                                                  |

`tools/repo-audit` fails the gate if a phrase, private key, `.env` file or a path under `~/.secrets` reaches a tracked file.

## 6. Repository layout and quality gates

```
apps/web                Next.js app (landing, public pages, owner app, /design)
packages/core           sealing, keys, files, manifests, canonical JSON
packages/chain          native tx, windows, contracts, QoreX, indexer reads
packages/ui             design system components and Musubi
services/api            Fastify API, drop, blobs, relay
services/indexer        chain follower
services/delivery-agent opt-in instant delivery
contracts               Foundry: MizuhikiRegistry, CapsuleVault, tests, deploy scripts
tests/e2e               Playwright, one isolated context per party
tests/testnet           live contract and chain tests with real signatures
tools                   repo audit, dev orchestration
```

- TypeScript 6.0 with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. ESLint 9 with `typescript-eslint` strict-type-checked, Prettier 3. (TypeScript 7 is the newest release, but `typescript-eslint` supports `<6.1`; type-aware linting is worth more than the faster compiler.)
- Unit and integration tests: Vitest. Contracts: `forge test`. End to end: Playwright with Chromium, WebKit and a phone profile, console and page-error listeners failing any test with an error, QoreX through `@qorechain/qorex-wallet-mock` (signs for real on testnet) and the real QoreX extension for the final pass.
- `pnpm check` runs, in order: repo audit, format check, lint, typecheck, unit, contracts, integration (needs Postgres), end to end. A feature is not done until it passes.

## 7. Local environment

`pnpm dev` checks that PostgreSQL 17 answers, runs migrations, then starts the API, the indexer and the web app (and the delivery helper once provisioned) against QoreChain testnet, with contract addresses from `packages/chain/src/deployment.testnet.json`. No local chain: the product depends on the ML-DSA precompile and KEM registry, which only the real testnet has.

## 8. Decisions and reasons

| Decision                                                                        | Reason                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Next.js for the web app                                                         | Public pages and the landing must be fast on a phone with real social cards (server render of public data), while the owner app is client-only; one framework covers both.                                                            |
| Fastify API as a separate long-running service                                  | WebSockets for the relay, streaming uploads and the indexer's `NOTIFY` feed do not fit serverless route handlers.                                                                                                                     |
| PostgreSQL, no Redis                                                            | Relational data with transactions; `LISTEN/NOTIFY` covers the fan-out we need; one fewer moving part.                                                                                                                                 |
| Content-addressed filesystem blob store behind an interface                     | Content-blind by construction, deduplicates, simple to self-host; the interface keeps an object store swap local.                                                                                                                     |
| One `eth_secp256k1` account per user                                            | Same 20 bytes on both lanes; verified live (spec section 10).                                                                                                                                                                         |
| ML-DSA authorisation inside contracts, plus the window                          | A stolen classical key can neither open a window nor pass the in-contract check; anyone may relay. Verified with `CheckInProbe`.                                                                                                      |
| Names, anchors and room records in one registry contract                        | Memos are not searchable and Handles are unavailable; one contract keeps the window scope small.                                                                                                                                      |
| Manifest authenticity by signature, not on-chain anchoring per publish          | The signer's key is on chain, so a signature is as strong and costs nothing per publish; the name record ties the name to the address.                                                                                                |
| Seller-device delivery by default, agent opt-in                                 | Keeps "Mizuhiki cannot read it" true unless the seller chooses otherwise, and says so.                                                                                                                                                |
| CSS Modules over tokens, no utility framework                                   | The approved look is a hand-tuned sticker system; tokens map one to one to custom properties.                                                                                                                                         |
| PBKDF2-SHA-256 600k for the vault                                               | Available in WebCrypto everywhere, no WASM; the OWASP 2023 figure for PBKDF2-SHA-256.                                                                                                                                                 |
| Native-lane REST through an allowlisted API relay                               | The testnet REST and RPC endpoints send no CORS headers, so browsers cannot call them. `/chain/*` relays only the read and broadcast paths the app uses; a pending transaction answers 200 `{pending:true}` instead of a 404.         |
| Owners' ML-DSA keys read through the EVM precompile `0x…0A02`                   | The EVM JSON-RPC allows CORS, and reading the key there means the relay above cannot swap it. `possessionProven` must be true.                                                                                                        |
| Sign-in limits per account, not per IP                                          | Several people behind one address must not lock each other out; one account is throttled on its own.                                                                                                                                  |
| Drop service checks only the envelope header, a stamp and a signature           | It cannot read content, so it limits abuse with size caps, a proof-of-work stamp bound to recipient + envelope hash + minute, per-recipient rate limits, and verifies an optional sender signature against the signer's key on chain. |
| A signed sender is also a reader of what they send                              | Replies and forwards are sealed to the recipient and the sender, so "Sent" opens on any of the sender's devices without keeping a local copy.                                                                                         |
| Inbox live updates by `LISTEN/NOTIFY` and a WebSocket that says "new"           | The socket authenticates with the session token as its first frame and never carries content, senders or amounts; the client refetches the metadata index.                                                                            |
| Opened inbox items cached in IndexedDB, AES-GCM, key by HKDF from the seal seed | Search runs on the device over what was opened, reopening is instant, and the cache is unreadable without the unlocked account.                                                                                                       |
| Sender signatures re-checked in the owner's browser                             | The server verified at drop time, but the owner's device checks again against QoreChain and against the sender named inside, so a lying server cannot fake "Verified".                                                                |

## 8a. Rooms protocol (spec 5.10)

Read from `repos/qoreseal/packages/ts/src/group.ts` and `batch.ts` and `contracts/src/MizuhikiRegistry.sol`.

- **One AES-256 key per epoch, shared by the members** (`EpochKeyManager`, memory-only). Every membership change starts a new epoch whose key is sealed (QoreSeal hybrid) to the current members' cards. The admin making the change runs the manager in their browser with the members' recipients and the epoch history they hold.
- **On chain** (`MizuhikiRegistry`): `createRoom` and `rotateRoom` record, per epoch, `membershipHash` = SHA-256 of the canonical sorted member list with roles, and `distributionHash` = SHA-256 of the sealed epoch-key envelope; `setRole` records admins; `transferRoom` and `closeRoom` as named. `rotateRoom` requires `newEpoch = epoch + 1` and an admin, so two admins changing membership at once cannot both win: the loser gets `StaleEpoch`, refetches and retries.
- **Messages** are `PrivateBatchCodec` blobs (context `mzk:room:<id>`, batch index = sender's millisecond clock × 1000 + random, unique per sender). Because every member holds the epoch key, the AES layer proves only "a member wrote this". So every message carries, **inside** the encrypted payload, the author's QoreSign hybrid signature (kind `room`) over {roomId, epoch, body hash, sentAt}; readers verify it against the author's ML-DSA key read from chain, and the author must have been a member of that epoch. The server checks at upload that the poster is a current member but stores no author; a delete token's hash lets the author delete for everyone without the server recording authorship.
- **What the server knows:** room ids, member addresses and roles, epochs, and the order and size of sealed batches. It does not know names of rooms, message content, authors or attachments. Room name, photo and description travel as signed system messages inside the room.
- **History for new members is decided per admission:** "Share past messages" seals the older epoch keys the admitting admin holds (a list sealed to the newcomer only); "Only new messages" seals nothing. It cannot be undone, and the UI says so.
- **Keys survive devices without extra storage:** every distribution stays in the blob store, so any member rebuilds every epoch key they were a member of by opening those envelopes with their own keys, plus any shared-history envelope sealed to them. Admins share history from exactly what they hold.
- **Invites without an online admin:** a join request (invite link with a secret in the fragment, hashed on the server) waits in a queue. With approval on, an admin approves it; with approval off, the next admin client that opens the room admits it automatically. Either way the key is only ever sealed by an admin's browser.
- **Leaving:** a member can leave at once (the server stops serving them new batches); the key rotates the next time an admin's client is open, and a pill says so until then.
- **Auto-delete** sets an expiry on new batches only; it deletes ciphertext from storage, not copies members already opened.
- **Verify keys:** a short safety phrase derived from SHA-256 of the member's on-chain ML-DSA key and signed card, compared out of band.

- **Rate limits count accounts, not addresses.** Signed-in calls are limited per account (looked up from the real session), anonymous calls per IP, because people behind one network share an IP. Immutable ciphertext reads (`GET /blobs/:hash`) and public name lookups have their own higher limits, like static files. Found when three people on one machine hit the shared 300-a-minute budget.
- **An open room refreshes with one request** (`GET /rooms/:id/sync`: room, new batches, keys, join requests). One live socket per tab; bursts of events are folded into one refresh; blobs are cached per tab; the room list never reopens the room already on screen.
- **Someone who left or was removed** still gets the record of the epochs they belonged to (so their device can check who wrote what they saw), and nothing after.

## 8b. Shop protocol (spec 5.11)

Read from the spec (5.11, section 11 decisions 1 and 2), `research/gumroad/UX_SPEC.md`, `research/handson/gr-*`, `packages/core/src/memo.ts` and `services/indexer/src/indexer.ts`.

- **Product record (public, signed):** title, description, covers, price (token, amount in base units, pay-what-you-want minimum and suggestion), versions (extra amount, cap), limits, quantity, refund promise, receipt text, kind (file, course, report, bundle, call, commission, tip), booking hours or commission deposit, the delivery mode, and the hash of the sealed content. Signed with the owner's hybrid key (kind `product`) and checked by every buyer's browser against the owner's key on chain, like forms. Publishing alone does not show it on the page; a Shop section or product button does, and the editor says so.
- **Content:** a random 32-byte product key K encrypts the content page (pages of text, links and file cards) with AES-256-GCM; each file is sealed in pieces under its own key, whose facts live inside the content page. K is sealed to the owner (the private draft) and, only for "Instant delivery", to the delivery agent's key.
- **Orders bind the buyer's key:** the order request (lines, quantities, versions, slot, recipient, nonce) is hashed; the first 22 base64url characters are the order reference, and the payment memo is `mzk:ord:<ref>`. Whoever delivers recomputes the reference from the stored request, so a server that swapped the recipient key would be caught before anything is sealed. The total is computed by one shared function (`orderTotal`) in the buyer's browser, the server and the deliverer.
- **Recipients:** a Mizuhiki account's card (checked against the chain), or a buyer key made in the browser at checkout from a 12-word phrase (decision 2): passed as a recipient, never registered on chain, so buying costs no extra fee. "Send to another wallet" uses the gift recipient's card.
- **Delivery:** the deliverer reads the payment from QoreChain (not from our database alone): recipient is the seller, token and amount cover the total, memo carries the reference; then seals `{ref, keys: [K per product]}` to the recipient (purpose `mzk:order:<ref>`) and posts it. By default the seller's own device does this while the dashboard is open or on next open (decision 1); "Instant delivery" lets the agent (`services/delivery-agent`, its own account and key) do it at once, and that product page says the helper can read it.
- **Discount codes** are checked by the server (never a list in the browser) and re-checked by the deliverer; limits, version caps and booking slots are reserved by the server at order time and re-checked at delivery.
- **Commissions** take a deposit with reference `<ref>` and the rest with `<ref>-2` when the seller asks; content is delivered after the second payment. **Calls** reserve one slot per order. **Tips** deliver the seller's thank-you page.
- **Refunds** are a seller promise: the seller sends the money back from their wallet with memo `mzk:ord:<ref>-r`, and the server marks the order refunded only after reading that transfer on chain.
- **Reviews** are verified purchases: the buyer's device keeps a review secret whose hash is stored with the order.

## 8c. Passes protocol (spec 5.12)

Read from the spec (5.12, 5.8 "Add a reader", 5.6 auditor key, 5.10 Payroll), `research/access/UX_SPEC.md` (Bitwarden invite, accept, confirm with a fingerprint phrase; QuickBooks accountant invite and status; Google's per-person scope), `packages/core/src/account.ts` (scoped seal keys by index) and the manifest's `periodKeys`.

- **One key per pass, never shared:** a period pass gets its own scoped seal key, `deriveSealKeys(phrase, 2_000_000 + n)`, so two accountants with different scopes never hold the same key. The holder receives only that key's seed, sealed to their card (purpose `mzk:pass:<id>`).
- **New items:** the pass key is listed in the signed manifest's `periodKeys` with its window (from, until) and kinds (messages, payment notes, form answers, invoices). Every sender's browser (message drop, pay note, form answer) and the owner's own invoices add it as a reader when the item falls inside the window and kind. A revoked or expired pass leaves the manifest, so nothing new is sealed to it.
- **Older items:** the owner's device opens each item in scope with the owner's key and re-seals it to the pass key; the server keeps the re-sealed copies as the pass's items and says how many the pass covers. "Add a reader" on one inbox item does the same for that item.
- **Rooms, forms, products:** a room pass makes the holder a read-only member admitted with past messages (no send or file rights; removing them changes the room key); a form pass adds them as a form reader and re-seals earlier answers; a product pass seals the product key to them.
- **Handshake (Bitwarden):** the owner's signed invite states the boundary in plain words; the holder accepts with a signature from their own key; the owner confirms after comparing six safety words read from the holder's on-chain key, and only then is anything sealed. Statuses: Invited, Needs confirmation, Active, Expired, Revoked.
- **Honest limit, said at revoke:** a holder keeps what they already opened and keeps the key to items already sealed to it; revoking stops future items only.

## 8d. Spare key and recovery protocol (spec 5.13)

Read from the spec (5.13), `research/access/UX_SPEC.md` (1Password Emergency Kit and organizer-assisted recovery; Bitwarden invite, accept, confirm with a fingerprint phrase; Google's reminders), QoreX social recovery in `repos/qorechain-docs/docs/qorex/security-and-recovery.md` (ML-KEM-sealed 2-of-3 shares, 48-hour timelock, cancel alert; the relay stores only opaque envelopes), `packages/core/src/shares.ts` (audited `shamir-secret-sharing`, phrases split as BIP-39 entropy) and `apps/web/src/lib/sparekey.ts`.

- **Spare key page** (`/app/spare-key`): a ring over three checks (sheet saved, at least the threshold of contacts holding pieces, a recovery test passed). Re-downloading the sheet asks for the device passphrase first.
- **Contacts** (Bitwarden handshake): the owner's signed invite (kind `recovery`), the contact's signed acceptance, then the owner compares six safety words read from the contact's on-chain key. Only then does the owner's device split the phrase's entropy into one piece per confirmed contact (threshold t, default 2 of 3) and seal piece i to contact i (purpose `mzk:recovery:<version>`, the contact's address as bound context). Any change re-splits under a new version; the server keeps only the current version's envelopes.
- **Honest limit, said when removing:** the phrase itself cannot change, so a removed contact still holds their old piece; with t−1 other old pieces it rebuilds the phrase. The screen says so and points to moving to a new account if trust is gone.
- **Recovery** (two-sided, as QoreX): on a new device, `/recover` makes a fresh one-time seal key kept in this browser and opens a request for the @name; the request shows six words from that key. A contact opens "Help recover", compares the words with the owner by voice, and their device opens their piece and re-seals it to the one-time key. When t pieces are in, a 48-hour wait starts (`RECOVERY_DELAY_SECONDS`), the owner's dashboards show a banner with Cancel, and the server releases the sealed pieces to the requester (who proves the request's secret) only after the wait and only if not cancelled. The new device combines the pieces, checks the phrase derives the account's address, and imports it.
- **Test recovery:** the signed-in owner opens a test request; contacts answer the same way; no wait; the owner's device combines the pieces and compares them with its own phrase, then records "tested".
- **Offline recovery reader:** a random key printed as 24 words on its own sheet; its public half is listed in the signed page (with every kind and no end) so senders seal to it, and the owner's device re-seals older items to it on request. `/recover/offline` reads with it: the server seals a random challenge to the registered public key; opening it proves possession, which unlocks the list of the owner's items (metadata), opened on that device with the offline key.
- **Server sees:** who are contacts, request times and counts, opaque envelopes. A dishonest server could release pieces early, but still needs t contacts to have answered; it cannot read pieces or the phrase.

## 8e. Capsules protocol (spec 5.14)

Read from the spec (5.14), `contracts/src/CapsuleVault.sol` (deployed, `packages/chain` encoders), `research/access/UX_SPEC.md` (Google's stepper, waiting periods and warnings; Bitwarden's invite, accept, confirm, request, approve or reject; Apple's bounded access window) and the recovery protocol (8d) whose handshake and pieces this reuses.

- **Per-recipient scope, enforced by keys:** each recipient r gets a fresh seed S_r; their content (an optional message and files) is sealed to `sealKeysFromSeed(S_r)` under `mzk:capsule:<id>`. S_r is split into Shamir pieces (t of the n guardians) and piece (g, r) is sealed to guardian g. A recipient who gathers t pieces opens only their own content.
- **The plan** (signed record, kind `capsule`): id, owner, public label, mode and times, access window, guardians and threshold, recipients with their content envelope, every piece envelope, and whether sealed copies are deleted after the window. `planHash` = SHA-256 of the canonical plan body, written to `CapsuleVault` on create; any change re-signs the plan and calls `setGuardians` with the new hash.
- **Guardians** consent per capsule (Bitwarden): signed invite, signed acceptance, the owner compares six safety words; the capsule is armed on chain only when every guardian is confirmed.
- **Release** is the contract's stored status `Released` (never the `effectiveStatus` view: until it is finalised a check-in or cancel still wins). Anyone may call `finalize` once the time has come; guardians' and recipients' devices do so when they open the page. A guardian's device then checks: the plan's signature against the owner's key on chain, its hash against the chain's `planHash`, the stored status, and that the access window (`releasedAt + accessSeconds`) has not ended; only then does it open its pieces and re-seal each to its recipient's key from the chain. This runs on its own whenever a guardian has the dashboard open, and from a button.
- **Modes:** at a time (`releaseAt`); for family after a wait (a guardian signs `request` on chain; the owner sees Request pending with a countdown, Approve now = `releaseNow`, Reject keeps the guardian); if I go quiet (opens `quietSeconds` after the owner's last signed `checkIn`; the dashboard warns from the lead time before and offers Check in).
- **Owner controls:** cancel (chain), edit guardians or recipients (re-split, new plan, `setGuardians`), check in. Removed guardians' pieces stop fitting because the seeds are re-drawn; this differs from the spare key, where the phrase cannot change.
- **Honest limits shown to the owner:** t guardians who collude can open a capsule early; this is a threshold-and-wait lock, not a cryptographic time lock (QoreChain has none). Recipients need a Mizuhiki account.

## 8f. Settings and account (spec 5.17)

Read from the spec (5.17), `contracts/src/MizuhikiRegistry.sol` (commit, claimName, releaseName, setPrimaryName), `packages/chain/src/window.ts` (EVM access window), the account vault (`packages/core/src/vault.ts`), the Push API and VAPID (RFC 8030, RFC 8291, RFC 8292; `web-push` 3.6.7, chosen over the two-week-old 4.0.0), and the existing export, passes and spare-key code.

- **One page, `/app/settings`,** with sections: Profile (opens the page editor's profile, avatar and social links; page language is English by product rule), Names, Security, Notifications, Readers, Data, Legal, and the live QoreChain access window.
- **Names:** add a second name (commit, then `claimName`); make a name the page's address (`setPrimaryName`, then the page is re-signed with that name, so the old address answers "no longer points here"); release a name that is not the page's address (`releaseName`). Every step is an ML-DSA-authorised registry call; the list is read from the indexer and confirmed on chain.
- **Security:** change the device passphrase (re-wraps the vault), add a passkey, Lock now, forget this device, show the 24 words and re-download the spare-key sheet, both only after the passphrase is typed again.
- **Notifications:** Web Push with VAPID keys kept in the API's environment. A subscription is stored with per-type toggles (new items, payments, rooms, passes and capsules, recovery alarms, capsule check-in reminders). Messages carry only the kind ("Something new arrived"), never content; payloads are encrypted to the browser (RFC 8291). Dead subscriptions (404/410) are removed. The API sends on the same events the dashboards receive and runs an hourly check for "if I go quiet" capsules inside their warning time (read from CapsuleVault), at most one reminder a day. Email is not offered (Prateek's decision).
- **Readers:** default readers are passes with no end over every kind, created with the Passes handshake, so senders seal to them through the signed page; period passes are listed beside them.
- **Data:** export everything, opened on this device, into one zip (the page, inbox items with their files, invoices, form answers, rooms' messages, passes and capsules lists). Delete my page: the page is hidden and every stored envelope and blob of the account is removed after a 10-second Undo; what is on QoreChain stays and the screen says so.
- **Legal:** privacy, terms and how to report a page, written plainly from the threat model.

## 8g. File requests (spec 5.7, Dropbox's file requests)

Read from the spec (5.7), Dropbox's help pages (help.dropbox.com/share/create-file-request, /received-file-request, /manage-file-requests), the drop service (`services/api/src/routes/drop.ts`), the forms protocol (signed definitions, `formRefusal`) and the send path (`apps/web/src/lib/send.ts`).

- **A request is a signed public record** (kind `filerequest`): id, title, description, optional deadline (an instant, shown in the owner's time zone and the visitor's), whether late uploads are taken, a file naming rule, open or closed, version. The owner's device signs it with their ML-DSA key; the API keeps it only if the signature matches the key on chain, and every visitor's browser checks it again before showing the title. Close, reopen and edit are re-signed versions; delete is allowed only once closed (Dropbox's order).
- **Uploads use the existing drop path.** The visitor's browser seals one envelope (kind `filedrop`, ref `freq:<id>`) holding their optional name, a note and each file's key, with the pieces sealed in 4 MiB chunks, all to the owner's key read from QoreChain (and to the owner's period and offline readers, like any message). No account is needed. The drop service refuses drops for a closed request, or after the deadline unless late uploads are on; late ones are stored with a `late` mark the owner sees. Visitors never see each other's uploads: nothing about other uploads is served.
- **Naming rule** (Dropbox's "naming conventions"): applied on the sender's device before sealing, so the server never sees names: original name, "Uploader – file name", or "Date – file name".
- **Owner screens:** `/app/requests` (Make menu) with All, Open, Closed pills and columns Name, Created, Deadline, Uploads, Size (counts and sizes are what the server can see; names and contents are sealed). New request sheet, then the share step at once (copy link with a "Link copied" toast, QR, add to my page). A request's page lists its uploads opened on this device, with Save, Prove it existed, close, reopen, edit and delete. Uploads also arrive in the inbox as "File request" items.
- **Visitor page:** `/@name/request/<id>`: who is asking (name verified on chain), title, description, deadline, one drop zone, optional name, the same seal moment and receipt as every send; closed, past-deadline, unknown and damaged states each say what happened and that nothing was sent.
- **Page block:** a `fileRequest` block on the public page opens the request in place.

## 8h. Starter grant: test QOR at sign-up, no faucet

Read from the gas abstraction page (docs.qorechain.io/user-guide/gas-abstraction: only `uqor` is accepted, conversion
off), the testnet REST (`/cosmos/feegrant/v1beta1/...` is served: the fee-grant module is live), QoreSign's
`verifySiwq` (`packages/ts/src/siwq.ts`: with `requirePq: false` it still checks that the classical key controls the
address, then the ADR-36 signature), our sign-up funding step (`apps/web/src/onboarding/Onboarding.tsx`) and the
drop service's proof of work (`packages/core/src/pow.ts`).

- **Why a grant, not a fee grant.** A new account does not exist on chain until it receives tokens, so a fee grant
  cannot pay its first transaction; and sign-up also opens an EVM window and claims a name on the EVM lane, whose gas a
  fee grant does not cover. Gas abstraction accepts no other token. So the sponsor sends a small amount once.
- **Proof of control before any key is on chain.** The browser asks for a one-time challenge (the existing
  `/auth/challenge`), signs it with the new account's classical key, and adds a proof of work bound to the address
  and the challenge. The API checks it with `verifySiwq({ requirePq: false })`; the ML-DSA key cannot be checked yet
  because it is registered with the grant's money.
- **Who gets it.** An address that has never existed on chain, has no balance and has never had a grant (one row per
  address, enforced by the database). At most `STARTER_PER_IP_DAY` grants per network address a day and
  `STARTER_DAILY_CAP` in all. Testnet only: refused when the configured chain is not `qorechain-diana`.
- **The sponsor.** A dedicated testnet account (`SPONSOR_PHRASE`, git-ignored `.env.local`), keys registered so its
  sends carry the hybrid signature. Sends go one at a time in the API process so sequences never collide. Off when the
  phrase is unset.
- **Failing honestly.** Sponsor too low, cap reached, account already funded, or the network unreachable: the API says
  which, records nothing, and the funding step shows the faucet path as before, with that reason.
- **Screens.** The funding step asks for the grant by itself, says "Sending you 0.2 test QOR, free on the test
  network", links the transaction, and continues as the balance arrives.

## 9. Sources behind the facts used here

- QoreSign 0.2.0 source: `repos/qoresign/packages/ts/src` (`sign.ts`, `message.ts`, `network.ts`, `siwq.ts`).
- QoreSeal 0.1.0 source and spec: `repos/qoreseal/packages/ts/src`, `repos/qoreseal/spec/qoreseal-v1.md`.
- EVM window rules: `repos/qorechain-sdk/packages/ts/src/pqc/evm-window.ts` (nonce advance, `maxValue` includes fees, 17,280-block cap, rotation closes the window).
- QoreX page API: the `integrate-qorex` skill and `repos/qorex-integrations`.
- Live chain facts: spec section 10 (transactions listed there); `get_chain_info` on testnet (sign-bytes v2, PQC precompiles active, min gas price 0.1 uqor).
