# How AI was used to build Mizuhiki

Mizuhiki was built by one person, Prateek, working with an AI coding agent:
[Claude Code](https://claude.com/claude-code) running Anthropic's Claude Opus models. Prateek set the direction, the
rules and the quality bar, and made every decision that was his to make. The agent researched, planned, wrote the code,
tests and documents, ran them against the QoreChain testnet, and reported back with proof. This file covers the
workflow, the tools the agent used, what it produced, how its work was checked, and where it went wrong.

**In numbers:** about 126,000 lines of TypeScript, Solidity and CSS; 160 unit, 93 integration and 41 contract tests,
plus about 100 end-to-end runs in real browsers against the live testnet; 30 product videos and 1,736 frames studied
before a screen was drawn; 16 of 16 Q-Day Drill attacks refused in rehearsal.

## Who decided what

| Prateek (human)                                                                                                                       | The agent (Claude Code)                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Entered the fest and chose the Encrypted Apps category                                                                                | Read the fest rules and the QoreChain docs, SDKs and kits before any plan                                            |
| Chose the product: a Linktree-style private page where everything people send is sealed                                               | Wrote the product spec, the architecture, the threat model and the build map from that direction                     |
| Chose the products to learn from for each area (Linktree, Gumroad, Typeform, Tally, PayPal, Dropbox, Telegram, WhatsApp, 1Password)   | Studied them from videos and hands-on runs, then rebuilt each flow on QoreChain with sealing                         |
| Approved the visual bar (the kawaii Japanese prototype, "Level 1") and asked for "Level 3": more premium, more polished, cuter        | Drew the prototype, the brand tokens and the Musubi mascot, then built the design system and every screen to Level 3 |
| Wrote the working rules: never guess an API, testnet only, no stubs, copy the best flow first, prove every claim, test as every user  | Followed them, and kept one progress list where every "done" carries its proof                                       |
| Made the scope calls: email reminders left out, the MIT licence, a public repository, fest registration and the real drill by himself | Built everything inside that scope, end to end                                                                       |
| Asked for the audits: a judge's-eye review, a visual pass over every screen, a contract review                                        | Ran them, fixed what they found, and wrote down what was not a defect and why                                        |

## The workflow

The agent worked under a written rule file, kept next to the code, that Prateek wrote and refined as the build went
on. Its core is a fixed order: **read the real source, write the plan with the source of every fact, build, prove.**

1. **Rules first.** "Never guess a QoreChain API, package, address, chain id or behaviour": read the cloned source,
   the docs and the live registry versions; if still unclear, test it on testnet; if still unclear, say NOT VERIFIED
   and ask. READMEs can be stale (one SDK README showed 0.11.0 while npm had 0.14.0), so code and registry win.
2. **Research before design** (next section): product studies, rival entries, QoreChain sources.
3. **Spikes before the build.** Eleven chain tests settled every risky assumption on testnet first: hybrid-signed
   registration, ML-DSA-87 key registration, EVM calls to the PQC precompiles, sealing in a browser, passkeys, QoreX
   signing from a page. The product was designed on their results, not on expectations.
4. **One feature at a time, fully.** For each feature: write its checks (behaviour, states, errors, look), build it
   by copying the studied flow, audit it against the spec, test it as every party in separate browser contexts, look
   at it on phone and desktop, security-review anything touching keys, sealed content or contracts, then record the
   proof (test output, screenshot, transaction hash) in the progress list. Only then the next feature.
5. **Gates on every commit.** A secrets and personal-path audit of the repository, the formatter, the linter, the
   type checker and the test suites (`pnpm check`). Commits are plain and carry no AI attribution lines, by
   Prateek's rule.
6. **Audit and polish as its own phase.** After every feature was done: a judge's-eye review, a full visual pass,
   an accessibility scan, a contract review and a full production end-to-end run, with every finding fixed or
   answered.

## Tools the agent used

**QoreChain's own AI tooling, used for every chain question:**

- **QoreChain MCP server** (`@qorechain/mcp`): chain info, address and balance reads, transaction lookups,
  post-quantum key status and the testnet faucet, called about a hundred times during the build to check results on
  chain instead of trusting the screen.
- **QoreChain agent skills**: `build-on-qorechain` (chain ids, endpoints, fees, hybrid signature rules),
  `sign-and-send-with-qoresign` (hybrid signing, ML-DSA-87 key registration, Sign In With QoreChain) and
  `integrate-qorex` (the QoreX wallet), each loaded before the matching code was written.
- **The `qore` CLI** and the docs index for agents (`docs.qorechain.io/llms.txt`).
- **The QoreChain Dashboard Contract Auditor (QCAIA)**, driven by the agent in a real browser: it audited the
  registry contract (score 85 of 100) and the agent checked each finding against the code; see
  [SECURITY_REVIEW](SECURITY_REVIEW.md#qcaia-results-each-checked).

**Design skills**, read in full before first use: `ui-ux-pro-max`, `frontend-design`, `design-taste-frontend`,
`aesthetic`, `color-palette`, `motion-foundations`, `motion-patterns`, and for checking `browser-qa`,
`click-path-audit` and `webapp-testing`. Where a skill's taste conflicted with the approved kawaii system, the
approved system won.

**Separate agent instances** for independent work: reviews given only what a judge or designer would see and none of
the builder's notes, research fetches, and parallel test suites. Decisions, core reading and merges stayed in the main
session.

**Browser automation**: Playwright for the test suites and the demo recordings; Claude in Chrome for the dashboard
work; scripted browser runs for the hands-on product studies.

**Security and test tooling**: Foundry for the contracts, Slither (all 102 detectors), Vitest, and the QoreX wallet's
official mock, which signs with real hybrid keys, for wallet-path tests.

## Research the agent did

- **Product studies.** For each area, the best Web2 product was studied before anything was designed: 30 walkthrough
  videos with transcripts, cut into 1,736 frames and read screen by screen, plus hands-on runs that drove the real
  products in a browser (Gumroad checkout and receipt, Linktree editing, Tally and Typeform forms). Each area has a
  written UX spec (access, forms, Gumroad, Linktree, payments, rooms). The studies stay outside this repository
  because they contain third-party videos and screenshots.
- **QoreChain itself.** Sixteen official QoreChain repositories (SDK, PQC, QoreSign, QoreSeal, QoreX, the wallet
  adapter, the MCP server, the docs and more) and the npm-only packages were read before the plan was written. The
  plan records the file or doc page behind each fact.
- **The field.** Rival entries in the fest were read at the code level to see where the bar was and what not to
  repeat.

## What the agent produced

- **Contracts**: four Solidity contracts (Foundry) that check every account action's ML-DSA-87 signature through
  QoreChain's `pqcVerify` precompile, with per-signer nonces and no admin key.
- **Server**: the API, indexer and delivery helper (TypeScript, Fastify, PostgreSQL), including the starter grant
  that funds a new account with test QOR after a proof of control and a proof of work.
- **Web app**: Next.js, where all sealing, signing and key handling happens in the user's browser.
- **Tests**: 160 unit, 93 integration and 41 contract tests; about 100 end-to-end runs that drive Chrome, Firefox,
  Safari and phone profiles through real testnet transactions, including a two-minute judge path taken straight from
  the README; and a live Q-Day Drill rehearsal.
- **Documents**: [README](README.md), [ARCHITECTURE](ARCHITECTURE.md), [THREAT_MODEL](THREAT_MODEL.md),
  [SECURITY_REVIEW](SECURITY_REVIEW.md) and this file.

## How the agent's work was checked

AI output is checked like anyone else's, by things that do not take its word for it:

- **The chain is the source of truth.** Tests read results back from QoreChain (keys registered, names owned,
  payments settled, contract calls reverted), not from the screen.
- **Independent reviewers.** Separate agent instances, given only what a judge or a designer would see, reviewed the
  landing page, the README and every screen; their findings were fixed or answered.
- **Attacks, not only happy paths.** Forged, replayed, cross-contract and cross-chain signatures; a rehearsal of the
  Q-Day Drill where an attacker holds an account's classical key (16 of 16 attacks refused); Slither and QCAIA over the
  contracts.
- **The real wallet, not only its test double.** Every QoreX payment path was also driven through the shipped QoreX
  extension on testnet: payments in QOR and fUSD, a rejection, a shop purchase, a gift, a commission in two payments,
  an invoice and a form's wallet field, each read back from the chain. The person set the throwaway wallet's password;
  the agent did the rest.
- **Looking at it.** Every screen and state was photographed on desktop and phone and read by eye, light and
  high-contrast themes, not only asserted. Zero console errors is part of every page's pass.
- **The gates.** Nothing is committed until the repository audit, formatter, linter, type checker and tests pass. One
  commit slipped through with a lint error; the next fixed it.

## Where the agent got it wrong (and how it was caught)

Some of the mistakes the checks above caught, kept here because they show the checks working:

- A shared form summary showed respondents' emails although its dialog said they stay out. Caught by a new
  end-to-end test of that page; fixed so contact answers never enter a shared summary.
- Publishing from a second browser tab was refused and the change silently stayed unpublished. Caught while making
  demo content; fixed so the tab picks up the newer page and keeps both tabs' work, with a test.
- The agent's own screenshot tool rewrote the demo account's page to a test page. Caught by an independent design
  review; the tool was made read-only.
- A formatter run touched deployed contract sources that had not changed. Caught in the agent's own diff review; the
  files were restored byte for byte.
- Several "bugs" it first reported were screenshots taken mid-animation; each was re-checked on a fresh load before
  anything was changed.
- The official QoreX test wallet passed every payment test, but the real extension starts on mainnet, hides its
  testnet switch and takes one request at a time; the payer saw QoreX's raw error under "Not confirmed yet" although
  nothing had moved. Caught by driving the real extension; fixed with plain instructions and a new end-to-end test.
- Re-testing after the registry redeploy found four more: a lagging RPC node's "header not found" was not retried, an
  fUSD shortfall was blamed on the QOR fee, a rebuilt database left Instant delivery without its helper's card, and a
  race hid the starter-grant receipt in sign-up. Each was fixed with a test.
- QCAIA reported a high-severity role escalation in the registry. The agent did not accept or dismiss it on reading
  alone: it traced the checks in the code and pointed to the test that proves an admin cannot grant admin.

## AI inside the product

Mizuhiki has two optional writing helpers, run through the Anthropic API (`claude-opus-5-5`): one drafts a form from a
short description, one rewrites a page bio. Both see only text the owner is about to make public; nothing sealed, and
no message, file or answer, is ever sent to them. Without an API key they are hidden.
