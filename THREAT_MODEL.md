# Mizuhiki threat model

What we protect, who might attack it, and how each attack is stopped or, where it cannot be, how its cost is stated to the user. The promises this must keep are the security statements shown in the product:

1. Everything sent to a page is sealed on the sender's device. Mizuhiki cannot read it.
2. Addresses, payment amounts and timing are public on chain. Contents are not.
3. If you lose your phrase and have no spare key, your sealed items cannot be recovered.
4. Anyone with an invoice link can read that invoice.
5. A room member you remove keeps what they already saw.
6. QoreSeal is version 0.1.0 and its design is awaiting an external review.
7. Shop delivery uses a delivery helper that can read the files it delivers (only for products the seller switches to Instant delivery).

## Assets

| Asset                                                                                                           | Why it matters                                                   |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Sealed contents (messages, files, form answers, invoice details, notes, room messages, products, capsule files) | the product's core promise                                       |
| The owner's phrase and derived keys                                                                             | full control of the account and every sealed item                |
| Name → address binding and the recipient card                                                                   | if forged, visitors seal to an attacker                          |
| Page manifest                                                                                                   | if forged, a page could ask for payment to an attacker's address |
| Capsule plan and timing                                                                                         | early release or blocked release harms the owner or the family   |
| Room membership and epoch keys                                                                                  | removed members must not read new messages                       |
| Funds (testnet)                                                                                                 | payments go to the address the payer intended                    |

## Attackers and defences

### A1. Our own server (or anyone who takes it over)

Can: read and change everything in the database and blob store, serve modified JavaScript, drop or delay items, see metadata.

- Contents: sealed in the browser before upload; the server has no key. **Stopped.**
- Forged recipient card or manifest: the visitor's browser verifies the card against the on-chain ML-DSA and KEM registries (`resolveRecipient`) and the manifest's hybrid signature against the owner's on-chain ML-DSA key; the name is read from `MizuhikiRegistry`. A server that swaps them is detected and the page shows a hard error, never a fallback. **Stopped.**
- Payment address swap: the pay sheet takes the address from the verified manifest and shows it in full on the review screen. **Stopped.**
- Serving malicious JavaScript: this is the limit of every web-delivered encryption product. Mitigations: strict Content-Security-Policy, Subresource Integrity on every script, no third-party scripts, a published build hash per release, the PWA caches a known version, and the security page states this limit plainly. **Reduced, stated.**
- Dropping or delaying items: the sender keeps a receipt with the envelope hash; the owner can see gaps against receipts. Denial of service is not prevented. **Stated.**
- Metadata (who sent to whom, when, sizes): visible to us; envelopes to owners use the anonymous flag; senders are anonymous unless they choose to sign. **Stated at the point of action.**

### A2. A visitor or any outsider

Can: send anything to any page, read public pages and the chain, probe the API.

- Spam and storage abuse: size caps shown up front, per-recipient and per-IP-hash rate limits, a proof-of-work stamp bound to recipient, size and minute, expiry of stored ciphertext. **Reduced.**
- Reading someone else's items: envelopes are useless without the key; owner endpoints need a SIWQ session bound to the address, checked against the on-chain key. **Stopped.**
- Testing whether a known key is a recipient: owner-bound envelopes use the anonymous flag (no recipient hints). Rooms and passes keep hints by design and say readers are visible to members. **Stopped for owner items.**
- Impersonating a sender: a "signed" badge appears only for a QoreSign hybrid signature over the envelope hash, verified against the signer's on-chain key; unsigned items say "anonymous". QoreX payers show "verified by payment" because the transfer proves the address. **Stopped.**
- Malicious files: files open in the owner's browser as downloads or sandboxed previews (images and PDF only, rendered from blob URLs in a sandboxed frame); no HTML or script previews. **Reduced.**
- Replaying a captured envelope or drop: envelopes are content-addressed, duplicates are ignored; contract actions carry nonces. **Stopped.**

### A3. A removed room member, pass holder or guardian

- Reading new room messages: every removal rotates the epoch; the new epoch key is sealed only to remaining members (verified: `UNKNOWN_EPOCH`). **Stopped.** Old messages they already held remain readable to them. **Stated (promise 5).**
- A revoked pass: future items are no longer sealed to that period key; items already sealed to it remain readable by whoever holds it. **Stated.**
- A removed guardian: their share is invalidated by re-splitting the capsule key and re-sealing shares to the current guardians. **Stopped going forward.**
- Guardians colluding early: if a threshold of guardians agree they can combine shares before release. **Stated to the owner at setup.**

### A4. Someone with a stolen classical (secp256k1) key

The Q-Day Drill case: an attacker who can forge or has stolen the classical half.

- Native transactions: the chain requires the hybrid signature, so a classical-only transaction is refused. **Stopped by the chain.**
- EVM transactions: refused without an authorisation window, and a window can be opened only with the post-quantum key. **Stopped by the chain.**
- Inside an already-open window: our contracts check an ML-DSA-87 signature for every owner and guardian action, so the classical key alone cannot claim a name, change a room, check in, cancel or approve a capsule. The window itself is scoped to our two contracts with a transaction and fee cap. **Stopped.**
- Sealed contents: ML-KEM-1024 hybrid with X25519; breaking the classical half alone does not open them. **Stopped.**

### A5. A lost or stolen device

- Lost device: the phrase restores everything on a new device; with no phrase and no spare key the data is gone. **Stated (promise 3).**
- Stolen, locked device: the vault is wrapped under the passphrase (PBKDF2-SHA-256 600k) or a passkey; the attacker must guess the passphrase offline. Minimum passphrase strength is enforced with a strength meter. **Reduced.**
- Stolen, unlocked device: keys are in memory only while unlocked; idle lock and "Lock now". **Reduced.**
- Recovery contacts: the phrase splits 2-of-3 with Shamir; any single contact learns nothing; the shares are sealed to each contact's key. **Stopped below threshold.**

### A6. The network and the chain endpoint

- Tampered REST responses: an endpoint could lie about a key. Mitigation: card verification requires the card's ML-DSA signature to match the registry key, and the registry key and KEM key are read from the chain endpoint over HTTPS; an endpoint that lies about both consistently could redirect seals. The app can be pointed at any testnet REST endpoint, and the security page lists this trust. **Reduced, stated.**
- Reorgs and finality: payments count as paid only after the transaction is committed with code 0. **Stopped.**

### A7. The delivery agent (opt-in)

Can read files of products the seller switched to Instant delivery. **Stated (promise 7)** on the product page and in the seller's settings. Default is seller-device delivery, which the agent never sees.

### A8. The crypto itself

QoreSeal 0.1.0 has had no external review; our chunked file sealing is our own construction on AES-256-GCM. Both are named on the security page. **Stated (promise 6).**

## Things we explicitly do not claim

- That metadata is hidden from us.
- That a removed member forgets what they saw.
- That screenshots can be prevented.
- That web delivery of the app is immune to a compromised server.
- That a capsule is a cryptographic time lock. It is a threshold-and-wait lock enforced by guardians and a contract.

## How this is checked

- Unit tests for every crypto path, including tampering (flipped bytes, reordered chunks, wrong purpose, wrong AAD).
- Contract tests for bad signature, replay, wrong signer, wrong contract, wrong chain, expired windows, on Foundry and again on testnet with real ML-DSA-87 signatures.
- End-to-end tests where a removed member, an outsider and a revoked pass holder each try to open what they must not.
- A server-compromise test: a modified card and a modified manifest served by a tampered API must produce a hard error in the visitor's browser.
