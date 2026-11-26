# Mizuhiki 水引

[![Built on QoreChain](https://build.qorechain.io/badge/mizuhiki.svg)](https://build.qorechain.io/p/mizuhiki)

![Mizuhiki: one link for everything private. Aria's page on a phone and the sealed inbox.](docs/mizuhiki.jpg)

**A private link-in-bio page. Everything people send you is sealed in their browser with post-quantum encryption, so only you can open it.**

Freelancers, lawyers, clinics and families give out one link. Through it people pay, send messages and files, fill in forms, buy from a shop, join a group room or leave a time capsule. Before anything leaves the sender's device it is sealed with ML-KEM-1024 to the owner's key, which the sender's browser reads from QoreChain. Our server stores sealed bytes it cannot open, so a breach of the server reveals nothing that was sent.

Runs on the **QoreChain test network** (`qorechain-diana`, EVM chain id 9800). Category: **Encrypted Apps**.

## Try it in two minutes

On a running Mizuhiki that has the demo pages. Every step below is also an end-to-end test against the real testnet
([`tests/e2e/specs/judge.spec.ts`](tests/e2e/specs/judge.spec.ts)), so this guide cannot drift from the product.

Running it yourself ([Run it locally](#run-it-locally))? A new database has no `@aria`: her name and keys are on
QoreChain, but her page lives in the database of the instance she published to. Do step 3 first (it reads only the
chain), then step 4 to make your own page, then steps 1, 2 and 5 on your own `/@name`. Locally, step 4 shows the
QoreChain faucet for the first test QOR unless you provision the starter sponsor.

1. **Open `/@aria`.** Before showing anything, your browser asks QoreChain who holds the name `aria` and which keys it
   has, and checks the page's signature: the footer says _"This page really is @aria's, checked on QoreChain just
   now"_.
2. **Send Aria something sealed.** Press **Message**, write a line, attach a file, **Seal and send**. It is sealed in
   your browser with ML-KEM-1024 to Aria's key read from the chain; the receipt shows what was sealed, for whom, and
   that nothing readable went on chain.
3. **Open `/onchain`.** Our contracts and Aria's registered keys, read from the chain, and four of her transactions,
   each fetched as the exact bytes the chain committed: hybrid signatures are verified in your browser against her
   registered ML-DSA-87 key; her key's own registration is shown as the one step the chain requires to be classical;
   her capsule check-in is shown as accepted by the contract, which checked her ML-DSA-87 signature itself. Below
   that, the Q-Day Drill rehearsal: both attack calls read back from the chain as refused.
4. **Make your own page at `/signup`.** Pick a name, a goal and a look, then save your 24 words. No faucet: Mizuhiki
   sends the account 0.2 test QOR by itself, then registers your ML-DSA-87 and ML-KEM-1024 keys and claims your name
   on chain. The on-chain part takes under a minute.
5. **Message yourself from a private window** (step 2 on your own `/@name`), then open it in your **Inbox**. It opens
   on your device only: our server holds sealed bytes it cannot read.

Paying with the QoreX extension: QoreX starts on mainnet. To use it here, tap the version number at the bottom of QoreX
seven times, then choose **Switch to testnet (diana)**. If you forget, the payment screen says so and nothing is sent.

## Encrypted Apps requirements, and where each is met

| Requirement                           | How Mizuhiki meets it                                                                                                                                                                             | Evidence                                                                                                                                                                  |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ML-KEM-1024 encryption                | Every message, file piece, form answer, invoice, room key and capsule share is sealed with QoreSeal (ML-KEM-1024 with X25519, AES-256-GCM)                                                        | [`packages/core/src/seal.ts`](packages/core/src/seal.ts), tests in [`packages/core/test`](packages/core/test)                                                             |
| Registered recipient keys             | Sign-up registers the owner's ML-KEM-1024 key on QoreChain; a sender's browser reads it from the chain, never from our server                                                                     | [`packages/chain/src/keys.ts`](packages/chain/src/keys.ts), [`recipients.ts`](packages/chain/src/recipients.ts); `/onchain` reads the demo account's registered keys live |
| ML-DSA key binding                    | The ML-DSA-87 key is registered with a proof of possession; the page, the recipient card and every contract action are signed with it, and the contracts verify it through QoreChain's precompile | [`contracts/src`](contracts/src), Foundry tests in [`contracts/test`](contracts/test), signatures verified live on `/onchain`                                             |
| Client-side encryption and decryption | Sealing and opening run only in the browser; keys exist only on the owner's devices                                                                                                               | [`apps/web`](apps/web), [THREAT_MODEL.md](THREAT_MODEL.md)                                                                                                                |

**Beyond the brief: a stolen classical key cannot act as you.** Every change on our contracts needs the account's ML-DSA-87 signature, and EVM transactions need a window opened with the post-quantum key. In a rehearsal of the fest's Q-Day Drill on testnet, an attacker holding only an account's secp256k1 key tried 16 attacks (native transfers, opening a window, EVM transfers, a token approval, drain calls on all three contracts); all 16 were refused by the chain or reverted by the contracts. Run it yourself: `pnpm --filter @mizuhiki/testnet drill`.

**See it checked live:** the `/onchain` page reads our contracts, the demo account's keys, post-quantum signatures and the latest contract activity straight from QoreChain in your browser.

## What it does

Twelve blocks can go on a page; each one that takes something in seals it before it leaves the sender's device.

| Block              | What people can do                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| Pay me             | Any amount in test QOR or test dollars, with a note only you (and the payer) can read            |
| Invoices           | Line items sealed to you, your client and your accountant; paid status read from the chain       |
| Messages and files | Notes and files up to 2 GB, sealed before upload; no account needed to send                      |
| File requests      | A checklist of documents to ask for, sealed on the way in                                        |
| Forms              | Intake, applications, feedback; answers sealed in the respondent's browser                       |
| Shop               | Files, calls, commissions and tips; each buyer gets their own sealed copy                        |
| Rooms              | Group chats and files; removing someone gives the room a new key                                 |
| Passes             | Give someone sealed access to part of what you hold, and revoke it                               |
| Capsules           | Files that open on a date, after a wait, or if you stop checking in, with guardians              |
| Spare key          | Recovery contacts each hold a piece of your key; a printable spare-key sheet                     |
| Receipts and proof | A receipt for every seal; anchor a document's fingerprint and get a certificate anyone can check |
| Insights           | Views, taps and payments, counted without reading anything                                       |

Behind the page: the **public page** itself, checked against your key on QoreChain before anything can be sent from it; the **inbox**, where sealed items open on your device; and **settings** (names on chain, passphrase and passkey, notifications, default reader, export, delete).

## How it works

- **Keys live only on your devices.** Your 24 recovery words derive a QoreChain account with a secp256k1 key, an ML-DSA-87 signing key (FIPS 204) and an ML-KEM-1024 sealing key (FIPS 203). On each device the phrase is kept encrypted with AES-256-GCM under a key from your device passphrase (PBKDF2-SHA-256, 600,000 iterations) or from a passkey (WebAuthn PRF).
- **Sealing happens in the sender's browser.** QoreSeal seals to the recipient's ML-KEM-1024 key, read from QoreChain, before upload. Our API stores sealed bytes and the minimum metadata to route them.
- **Pages are signed and checked.** Your page is signed with your ML-DSA-87 key; a visitor's browser asks QoreChain who holds the name and which key it has, and refuses a page that does not match. QoreChain has two transaction lanes: its native (Cosmos) lane, where every transaction carries a hybrid signature (secp256k1 plus ML-DSA-87), and an EVM lane for contracts.
- **Contracts check post-quantum signatures.** Every change made for an account on our contracts carries that account's ML-DSA-87 signature, which the contract verifies through a QoreChain built-in (a precompile). QoreChain lets an account with a post-quantum key send EVM transactions only inside a short window it opens with that key, limited to our contracts, a number of transactions and a fee cap.

## Contracts on QoreChain testnet

Network `qorechain-diana`, EVM chain id 9800. Source in [`contracts/src`](contracts/src), tests in [`contracts/test`](contracts/test).

| Contract         | Address                                      | Deploy transaction                                                   |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------- |
| MizuhikiRegistry | `0xb3a27b35a9fb50dbd3b5f14a8c27445c37e64641` | `0x64445b49298b618f285b560b8248c0fd6d9012eb299cb810f0c639fa1ddd6f2d` |
| CapsuleVault     | `0x52501bdb5d8fb4c87ebb10b41b52b1cf9b8e263c` | `0xa817e85b75ca5b407ec4764ff7ed3bca4c26f10c12f3bbf6420856a05a6729a2` |
| AnchorBook       | `0x9d5379a7f28bae86e087abb8e7a72274335f316a` | `0xa2e4eeb86fc9a6c2346e83ceff1221b6d2fc6b1b0cc6d576c0954f55a0cade18` |

Explorer: <https://explore.qore.network>. The `/onchain` page shows each one's code size and deploy receipt, read live.
The registry was redeployed with the fix for [security review finding 1](SECURITY_REVIEW.md#findings); the first one,
`0x302942b02c5e6746e92acf64c95e3ef42bdd64ea`, is still read for proof anchors made before AnchorBook existed.

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
pnpm run setup                   # contract test library (not `pnpm setup`, which is pnpm's own command)

# PostgreSQL: a local role and two databases (dev and integration tests)
createuser mizuhiki --pwprompt   # password: mizuhiki-local-dev (local default; change it with DATABASE_URL)
createdb -O mizuhiki mizuhiki
createdb -O mizuhiki mizuhiki_test

pnpm dev                         # migrations, then API :4000, indexer and web :3000
```

Open <http://localhost:3000>. Sign-up creates a fresh account, gets it 0.2 test QOR from the starter sponsor (setup spends about 0.12), then registers its keys and claims its name on the testnet. To run the sponsor, give it test QOR once with `pnpm --filter @mizuhiki/api sponsor:provision` (it reads your testnet wallet file); without it, sign-up shows the QoreChain faucet instead.

`pnpm dev` looks for PostgreSQL tools in `PG_BIN`, then Homebrew's `postgresql@17`, then `PATH`.

### Settings

The API reads these from the environment, or from `services/api/.env.local` (git-ignored). Every one has a working default for local use.

| Setting                                                                                                           | Default                                                          | What it does                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `API_PORT`, `API_HOST`                                                                                            | `4000`, `127.0.0.1`                                              | Where the API listens                                                                                                                                                       |
| `DATABASE_URL`                                                                                                    | `postgres://mizuhiki:mizuhiki-local-dev@127.0.0.1:5432/mizuhiki` | PostgreSQL connection (API, indexer, migrations)                                                                                                                            |
| `BLOB_DIR`                                                                                                        | `var/blobs`                                                      | Where sealed bytes are stored                                                                                                                                               |
| `WEB_ORIGIN`                                                                                                      | `http://localhost:3000`                                          | The web app's origin: CORS, and the domain in Sign In With QoreChain                                                                                                        |
| `MAX_BLOB_BYTES`                                                                                                  | 4 MiB + 64 KiB                                                   | Largest sealed object in one request (files arrive as 4 MiB pieces)                                                                                                         |
| `POW_BITS`                                                                                                        | `16`                                                             | Proof-of-work bits required on anonymous drops                                                                                                                              |
| `DROP_RETENTION_DAYS`                                                                                             | `30`                                                             | Days a dropped sealed item is kept                                                                                                                                          |
| `SESSION_HOURS`                                                                                                   | `12`                                                             | API session length after signing in with the account key                                                                                                                    |
| `RECOVERY_DELAY_SECONDS`                                                                                          | `172800` (48 h)                                                  | Wait before recovery pieces are released to a new device                                                                                                                    |
| `TRUST_PROXY_HOPS`                                                                                                | `0`                                                              | Reverse proxies whose `X-Forwarded-For` is trusted. `0` when the API faces clients directly; `1` behind one proxy, or every per-network limit sees one address for everyone |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`                                                          | unset                                                            | Web Push keys; make them with `pnpm --filter @mizuhiki/api push:keys`. Without them, notifications are off                                                                  |
| `ANTHROPIC_API_KEY`                                                                                               | unset                                                            | Turns on the writing helpers (page bio, form questions). Without it they are hidden                                                                                         |
| `SPONSOR_PHRASE`                                                                                                  | unset                                                            | The testnet starter sponsor, written by `sponsor:provision`. Without it, sign-up shows the faucet                                                                           |
| `STARTER_GRANT_UQOR`, `STARTER_DAILY_CAP`, `STARTER_PER_IP_DAY`, `STARTER_REQUESTS_PER_10MIN`, `STARTER_POW_BITS` | `200000`, `300`, `5`, `6`, `18`                                  | Starter grant amount and limits (ARCHITECTURE 8h, THREAT_MODEL A9)                                                                                                          |
| `DELIVERY_AGENT_ADDRESS`                                                                                          | unset                                                            | Account of the instant-delivery helper, set by its provisioning step                                                                                                        |

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

## Built with

QoreChain's own kits: [`@qorechain/sdk`](https://github.com/qorechain/qorechain-sdk), [QoreSign](https://github.com/qorechain/qoresign) (hybrid signing and key registration), [QoreSeal](https://github.com/qorechain/qoreseal) (ML-KEM-1024 sealing) and the [QoreX types](https://github.com/qorechain/qorex-integrations). Also Next.js and React, Fastify, Drizzle ORM with PostgreSQL, viem, `@noble/hashes`, `@scure/bip39`, `shamir-secret-sharing`, `fflate`, `pdf-lib`, `qrcode`, `motion`, `web-push`, `zod`, Foundry for the contracts, and Playwright and Vitest for tests. The writing helpers use the Anthropic API (Claude).

## Security

The contracts' review (Slither, a manual design review, the attacker tests and their results) is in [SECURITY_REVIEW.md](SECURITY_REVIEW.md). Report a vulnerability privately to the maintainers rather than in a public issue. The threat model lists every party we defend against, what each can and cannot do, and the test that covers it.

## License

[MIT](LICENSE).
