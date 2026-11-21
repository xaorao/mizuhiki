# Mizuhiki 水引

A private page for anyone who works with clients, patients, students or family. One link, like a link-in-bio page, where people can pay you, send you messages and files, fill in your forms, buy from your shop, join your rooms or receive a time capsule. Everything they send is sealed in their own browser to your post-quantum key before it leaves their device, so Mizuhiki stores it without being able to read it.

Mizuhiki runs on the **QoreChain test network**. QoreChain carries the keys, names and records that let any browser check a page is really yours; the content itself never goes on chain.

- **Proof on QoreChain:** `/onchain` reads our contracts, the demo account's keys, post-quantum signatures and the latest contract activity from the chain in your browser.
- **Threat model:** [THREAT_MODEL.md](THREAT_MODEL.md). **Architecture and protocols:** [ARCHITECTURE.md](ARCHITECTURE.md).

## What it does

| Area               | What people can do                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------ |
| Public page        | Your blocks, checked against your key on QoreChain before anything can be sent from it     |
| Pay                | Any amount in test QOR or test dollars, with a note only you (and the payer) can read      |
| Messages and files | Notes and files up to 2 GB, sealed before upload; no account needed to send                |
| Inbox              | Sealed items opened on your device; reply, save, archive                                   |
| Invoices           | Line items sealed to you, your client and your accountant; paid status read from the chain |
| Forms              | Intake, applications, feedback; answers sealed in the respondent's browser                 |
| File requests      | A checklist of documents to ask for, sealed on the way in                                  |
| Shop               | Files, calls, commissions and tips; each buyer gets their own sealed copy                  |
| Rooms              | Group chats and files; removing someone changes the room's key                             |
| Proofs             | Anchor a document's fingerprint and get a certificate anyone can check                     |
| Passes             | Give someone sealed access to part of what you hold, and revoke it                         |
| Capsules           | Files that open on a date, after a wait, or if you stop checking in, with guardians        |
| Spare key          | Recovery contacts each hold a piece of your key; a printable spare-key sheet               |
| Insights           | Views, taps and payments, counted without reading anything                                 |
| Settings           | Names on chain, passphrase and passkey, notifications, default reader, export, delete      |

## How it works

- **Keys live only on your devices.** Your 24 recovery words derive a QoreChain account with a secp256k1 key, an ML-DSA-87 signing key (FIPS 204) and an ML-KEM-1024 sealing key (FIPS 203). On each device the phrase is kept encrypted with AES-256-GCM under a key from your device passphrase (PBKDF2-SHA-256, 600,000 iterations) or from a passkey (WebAuthn PRF).
- **Sealing happens in the sender's browser.** QoreSeal seals to the recipient's ML-KEM-1024 key, read from QoreChain, before upload. Our API stores sealed bytes and the minimum metadata to route them.
- **Pages are signed and checked.** Your page is signed with your ML-DSA-87 key; a visitor's browser asks QoreChain who holds the name and which key it has, and refuses a page that does not match. Native-lane transactions carry QoreChain's hybrid signature (secp256k1 plus ML-DSA-87).
- **Contracts check post-quantum signatures.** Every change made for an account on our contracts carries that account's ML-DSA-87 signature, which the contract verifies through QoreChain's precompile, inside a short EVM permission window opened from the native lane.

## Contracts on QoreChain testnet

Network `qorechain-diana`, EVM chain id 9800. Source in [`contracts/src`](contracts/src), tests in [`contracts/test`](contracts/test).

| Contract         | Address                                      | Deploy transaction                                                   |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| MizuhikiRegistry | `0x302942b02c5e6746e92acf64c95e3ef42bdd64ea` | `0x1ec621af026a74f89f2a88ed3ca77af2cde9936ee55ac008696f45371f121c60` |
| CapsuleVault     | `0x52501bdb5d8fb4c87ebb10b41b52b1cf9b8e263c` | `0xa817e85b75ca5b407ec4764ff7ed3bca4c26f10c12f3bbf6420856a05a6729a2` |
| AnchorBook       | `0x9d5379a7f28bae86e087abb8e7a72274335f316a` | `0xa2e4eeb86fc9a6c2346e83ceff1221b6d2fc6b1b0cc6d576c0954f55a0cade18` |

Explorer: <https://explore.qore.network>. The `/onchain` page shows each one's code size and deploy receipt, read live.

## Repository

```
apps/web               Next.js app: every screen, and the only place keys exist
packages/core          sealing, keys, files, manifests, records (browser and Node)
packages/chain         QoreChain access: native lane, EVM lane, contracts, proof reads
packages/ui            design system (tokens, components, Musubi)
packages/db            PostgreSQL schema and migrations (Drizzle)
services/api           content-blind HTTP and WebSocket API (Fastify)
services/indexer       follows our contracts' events and payments to page owners
services/delivery-agent  optional helper for instant shop delivery
contracts              Solidity contracts (Foundry)
tests/e2e              Playwright suites, real testnet transactions
tests/testnet          deploy scripts, live contract tests, test personas
tools                  dev runner, production e2e runner, repository audit
```

## Run it locally

Requirements: Node 24 or newer, pnpm 10.34, PostgreSQL 17, and Foundry for the contracts. There is no local chain: the product needs QoreChain's ML-DSA precompile and key registry, which only the real network has, so the local stack talks to the testnet.

```sh
pnpm install
pnpm setup                       # contract test library

# PostgreSQL: a local role and two databases (dev and integration tests)
createuser mizuhiki --pwprompt   # password: mizuhiki-local-dev (local default; change it with DATABASE_URL)
createdb -O mizuhiki mizuhiki
createdb -O mizuhiki mizuhiki_test

pnpm dev                         # migrations, then API :4000, indexer and web :3000
```

Open <http://localhost:3000>. Sign-up creates a fresh account, asks you to request test QOR for it from the QoreChain faucet (setup spends about 0.12), then registers its keys and claims its name on the testnet.

`pnpm dev` looks for PostgreSQL tools in `PG_BIN`, then Homebrew's `postgresql@17`, then `PATH`.

### Settings

The API reads these from the environment, or from `services/api/.env.local` (git-ignored). Every one has a working default for local use.

| Setting                                                  | Default                                                          | What it does                                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_PORT`, `API_HOST`                                   | `4000`, `127.0.0.1`                                              | Where the API listens                                                                                                                                                       |
| `DATABASE_URL`                                           | `postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki` | PostgreSQL connection (API, indexer, migrations)                                                                                                                            |
| `BLOB_DIR`                                               | `var/blobs`                                                      | Where sealed bytes are stored                                                                                                                                               |
| `WEB_ORIGIN`                                             | `http://localhost:3000`                                          | The web app's origin: CORS, and the domain in Sign In With QoreChain                                                                                                        |
| `MAX_BLOB_BYTES`                                         | 4 MiB + 64 KiB                                                   | Largest sealed object in one request (files arrive as 4 MiB pieces)                                                                                                         |
| `POW_BITS`                                               | `16`                                                             | Proof-of-work bits required on anonymous drops                                                                                                                              |
| `DROP_RETENTION_DAYS`                                    | `30`                                                             | Days a dropped sealed item is kept                                                                                                                                          |
| `SESSION_HOURS`                                          | `12`                                                             | API session length after signing in with the account key                                                                                                                    |
| `RECOVERY_DELAY_SECONDS`                                 | `172800` (48 h)                                                  | Wait before recovery pieces are released to a new device                                                                                                                    |
| `TRUST_PROXY_HOPS`                                       | `0`                                                              | Reverse proxies whose `X-Forwarded-For` is trusted. `0` when the API faces clients directly; `1` behind one proxy, or every per-network limit sees one address for everyone |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | unset                                                            | Web Push keys; make them with `pnpm --filter @mizuhiki/api push:keys`. Without them, notifications are off                                                                  |
| `ANTHROPIC_API_KEY`                                      | unset                                                            | Turns on the writing helpers (page bio, form questions). Without it they are hidden                                                                                         |
| `DELIVERY_AGENT_ADDRESS`                                 | unset                                                            | Account of the instant-delivery helper, set by its provisioning step                                                                                                        |

The web app reads `NEXT_PUBLIC_API_URL` (default `http://127.0.0.1:4000`) and `NEXT_PUBLIC_SITE_URL` for links and previews. The delivery helper reads `AGENT_PHRASE` and `API_URL` from `services/delivery-agent/.env.local`, written by `pnpm --filter @mizuhiki/delivery-agent provision`.

## Tests

```sh
pnpm check              # everything below in order
pnpm audit:repo         # no secrets, personal paths or stray files in tracked content
pnpm lint && pnpm typecheck && pnpm format:check
pnpm test:unit          # sealing, keys, records, UI logic
pnpm test:contracts     # Foundry
pnpm test:integration   # API, indexer and chain reads against the real testnet
pnpm test:e2e           # Playwright against the dev server
pnpm test:e2e:prod      # the whole suite against a production build (stop the dev web server first)
```

The integration and end-to-end suites make real testnet transactions. They fund disposable accounts from a testnet-only wallet read from `~/.secrets/qorechain/testnet-wallet.env` (one `QORE_MNEMONIC` line holding a testnet phrase); persona phrases are kept in `var/personas.json`, both outside version control. The end-to-end suites run on desktop and phone viewports, with Firefox, WebKit and an iPhone profile for the core journey, and fail on any console error, page error or failed request.

## Security

Report a vulnerability privately to the maintainers rather than in a public issue. The threat model lists every party we defend against, what each can and cannot do, and the test that covers it.
