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
- **Blobs:** content-addressed (`sha256`) store behind a `BlobStore` interface; the shipped implementation is a sharded filesystem store with atomic rename writes and expiry sweeps. Storage is replaceable without touching callers.
- **Relay:** WebSocket fan-out of sealed room batches with per-room sequence numbers; offline members fetch from storage on return.
- **Inbox index, forms, invoices, shop, passes, capsules, insights, push:** metadata and counters only; contents are sealed blobs.
- **Abuse:** report endpoint and takedown of public pages; sealed content cannot be read, so it can only be expired.

### 2.6 `services/indexer` — a pure function of public data

Follows the chain and writes the cache tables: payments to known owners (REST tx search by `transfer.recipient` and `message.sender` events, memo read from the transaction body, never searched), `MizuhikiRegistry` and `CapsuleVault` logs (`eth_getLogs` over bounded block ranges, checkpointed), and links payments to invoices and orders by memo reference, amount and denom. It publishes changes with Postgres `NOTIFY` so the API pushes them to open dashboards. Rebuilding from an empty database reproduces the same state.

### 2.7 `services/delivery-agent` — opt-in instant shop delivery

By default the **seller's own device** delivers: when the dashboard is open (or next opens) it seals the product key to each paid buyer. A seller may switch a product to "Instant delivery": the product key is then also sealed to the agent's key, and the agent seals it to the buyer once the indexer confirms a matching payment. The product page states that the helper can read that file. The agent holds one account of its own (testnet), runs separately and is self-hostable.

### 2.8 `contracts` — Solidity (Foundry), EVM lane

- **`MizuhikiRegistry`:** names (claim, release, transfer), recipient card hash per address, proof anchors (hash, kind, time), room records (create, epoch change with membership hash and distribution hash, role changes), form and product publication hashes, pass records. Every owner action carries an ML-DSA-87 signature over `keccak256(abi.encode(TAG, chainid, this, action fields, nonce))`, verified with `pqcVerify` (0x…0A01) against the key from `pqcKeyStatus` (0x…0A02); per-address nonces stop replay. Events are indexed for `eth_getLogs`.
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

| Record                                                         | Where                               | Written by                              |
| -------------------------------------------------------------- | ----------------------------------- | --------------------------------------- |
| ML-DSA-87 key, ML-KEM-1024 key                                 | chain PQC module                    | the owner's device                      |
| Payments, invoice and order settlement                         | `MsgSend` with tagged memo          | the payer's wallet                      |
| Names, card hashes, anchors, room epochs, publications, passes | `MizuhikiRegistry` events and state | the owner (ML-DSA-authorised)           |
| Capsule plans and state                                        | `CapsuleVault`                      | owner and guardians (ML-DSA-authorised) |

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
| `blobs`                                        | hash, size, created_at, expires_at                                                        | content-addressed                    |
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

`pnpm dev` starts Postgres 17 (Homebrew service), runs migrations, then the API, indexer and web app against QoreChain testnet, with contract addresses from `contracts/deployments/testnet.json`. No local chain: the product depends on the ML-DSA precompile and KEM registry, which only the real testnet has.

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

## 9. Sources behind the facts used here

- QoreSign 0.2.0 source: `repos/qoresign/packages/ts/src` (`sign.ts`, `message.ts`, `network.ts`, `siwq.ts`).
- QoreSeal 0.1.0 source and spec: `repos/qoreseal/packages/ts/src`, `repos/qoreseal/spec/qoreseal-v1.md`.
- EVM window rules: `repos/qorechain-sdk/packages/ts/src/pqc/evm-window.ts` (nonce advance, `maxValue` includes fees, 17,280-block cap, rotation closes the window).
- QoreX page API: the `integrate-qorex` skill and `repos/qorex-integrations`.
- Live chain facts: spec section 10 (transactions listed there); `get_chain_info` on testnet (sign-bytes v2, PQC precompiles active, min gas price 0.1 uqor).
