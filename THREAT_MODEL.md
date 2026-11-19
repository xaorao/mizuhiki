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
- Rooms: messages are sealed under the room's epoch key and signed by their author; members' devices check each signature against the author's on-chain key, hide a message whose author was not in the room during that key period, and count a re-uploaded copy once. The member list we serve is checked on the member's device against the membership hash recorded on QoreChain for the current key, and a mismatch is shown as a warning. We cannot read rooms; we can withhold or delay messages, and we could misstate _past_ membership to a device (only the current list is checkable against the chain). The relay checks at upload that the poster is a member but keeps no record of who posted. **Contents stopped; forged membership detected; withholding and past-membership claims stated.**
- Shop: we never hold a product key unless the seller turns on Instant delivery (then the helper holds it, and the product page says so). Whoever delivers checks the payment on QoreChain itself, recomputes the order reference from the stored request (so swapping the buyer's key for ours is caught), prices with the signed records the buyer saw, and refuses an old, lower-priced version paid more than an hour after the seller published a newer one. Product records are signed by the seller and checked in every buyer's browser. We can withhold orders or delay delivery. **Contents and keys stopped; underpaying and key swaps detected; withholding stated.**
- Passes: the pass key's public half reaches senders only inside the owner's signed page, checked in the sender's browser against the owner's key on chain, so we cannot add a reader. The invite is signed by the owner and the acceptance by the holder, each checked against their key on chain; the owner's device seals anything to the holder only after the owner compares six safety words read from the holder's on-chain key (a swapped card or key gives different words). Keys and re-sealed copies are sealed on the owner's device. We can see that a pass exists, its scope, and which items it covers (hashes, times); we can withhold copies. **Readers stopped from being added; key swaps detected; pass metadata stated.**
- Metadata (who sent to whom, when, sizes): visible to us; envelopes to owners use the anonymous flag; senders are anonymous unless they choose to sign. **Stated at the point of action.**

### A2. A visitor or any outsider

Can: send anything to any page, read public pages and the chain, probe the API.

- Holding a seller's stock or call times with unpaid orders: an unpaid order holds for an hour, and one network address can hold at most three unpaid orders per seller (stored only as a hash). **Reduced.**
- Spam and storage abuse: size caps shown up front, per-recipient and per-IP-hash rate limits, a proof-of-work stamp bound to recipient, size and minute, expiry of stored ciphertext. **Reduced.**
- Reading someone else's items: envelopes are useless without the key; owner endpoints need a SIWQ session bound to the address, checked against the on-chain key. **Stopped.**
- Testing whether a known key is a recipient: owner-bound envelopes use the anonymous flag (no recipient hints). Rooms and passes keep hints by design and say readers are visible to members. **Stopped for owner items.**
- Impersonating a sender: a "signed" badge appears only for a QoreSign hybrid signature over the envelope hash, verified against the signer's on-chain key; unsigned items say "anonymous". QoreX payers show "verified by payment" because the transfer proves the address. **Stopped.**
- Malicious files: files open in the owner's browser as downloads or sandboxed previews (images and PDF only, rendered from blob URLs in a sandboxed frame); no HTML or script previews. **Reduced.**
- Replaying a captured envelope or drop: envelopes are content-addressed, duplicates are ignored; contract actions carry nonces. **Stopped.**

### A3. A removed room member, pass holder or guardian

- Posting after removal: the relay refuses it, and even if it accepted one, members' devices hide a message sealed after the author's last key period. **Stopped.**
- Reading new room messages: every removal rotates the epoch; the new epoch key is sealed only to remaining members (verified: `UNKNOWN_EPOCH`). **Stopped.** Old messages they already held remain readable to them. **Stated (promise 5).**
- A revoked or expired pass: the owner's device re-signs the page without that pass key, so senders stop sealing to it, the server stops listing new items for it and refuses new copies; a room pass removal changes the room key; a form pass removal takes them off the form's signed reader list. Items already sealed or copied to them remain readable to them, and the revoke screen says so in those words. A sender's browser that loaded the page before the revoke can seal to the old key for up to a minute (its cache); those items are not listed to the holder. **Stopped going forward; kept items stated.**
- A pass holder trying to read beyond the pass: a period key is its own scoped key (one per pass), listed only for its window and kinds; the server lists only the owner's items in that window and kind to the holder; the holder cannot post in a pass room (no send or file rights, checked by the relay) or change anything. **Stopped.**
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
