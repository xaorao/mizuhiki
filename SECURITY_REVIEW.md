# Contract security review

Scope: the four contracts in [`contracts/src`](contracts/src) (`PqAuth`, `MizuhikiRegistry`, `CapsuleVault`,
`AnchorBook`; 653 lines including comments), as deployed on QoreChain testnet (addresses in the
[README](README.md#contracts-on-qorechain-testnet)) and as in this repository. The off-chain parts are covered by the
[threat model](THREAT_MODEL.md).

## How they were reviewed

| Method                                                                                               | Result                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slither 0.11.6, all 102 detectors (Trail of Bits)                                                    | 9 results, none a defect; each explained below                                                                                                                                                                   |
| Manual design review: minimalism, loops, input validation, external calls, invariants, roles, replay | 1 low-severity finding (fixed in source), 2 informational                                                                                                                                                        |
| Foundry tests, including the attacker cases                                                          | 41 passing: forged, replayed, cross-contract and cross-chain signatures, unregistered and unproven keys, an inactive precompile, front-running a name, stale room epochs, role escalation and the capsule states |
| The same contracts on testnet with real ML-DSA-87 signatures                                         | `pnpm --filter @mizuhiki/testnet test` (contracts) and the Q-Day Drill rehearsal: 16 of 16 attacks with only the classical key refused or reverted                                                               |
| QoreChain Dashboard Contract Auditor (QCAIA)                                                         | Not yet run: it needs a Dashboard sign-in; the report will be linked here                                                                                                                                        |

## Design in one paragraph

No contract holds funds and none has an admin, an owner key or an upgrade path. Every write for an account carries
that account's ML-DSA-87 signature over `keccak256(DOMAIN, chainid, contract, signer, nonce, action)`, checked through
QoreChain's `pqcVerify` precompile against the key `pqcKeyStatus` reports as registered with proof of possession. So
the EVM sender has no authority: anyone may relay, and a stolen classical key cannot act. Per-signer nonces stop replay;
the chain id and contract address stop cross-chain and cross-contract replay; every precompile answer is
length-checked, because an inactive precompile answers success with empty data. Loops are bounded (16 guardians at
most; paged reads).

## Findings

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                          | Status                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Low      | `MizuhikiRegistry.commit` overwrote an existing commitment's block. A griefer who re-submits someone's live commitment in the block of their reveal makes the reveal fail (`block.number <= at`). It cannot take the name (the commitment binds name, owner and secret, and the claim needs the owner's ML-DSA signature), only delay the claim. | **Fixed in source**: a live commitment keeps its block; an expired one can be made again. Tests: `test_recommitting_a_live_commitment_cannot_block_the_reveal`, `test_an_expired_commitment_can_be_made_again`. The deployed testnet registry predates the fix: redeploying would erase every name and room on testnet, so it ships with the next deployment. |
| 2   | Info     | `MizuhikiRegistry.anchor` keeps one record per fingerprint, so whoever anchors first wins.                                                                                                                                                                                                                                                       | Known and superseded: the app writes anchors only to `AnchorBook`, where every account keeps its own record (written for exactly this); it still reads registry anchors made before AnchorBook existed.                                                                                                                                                       |
| 3   | Info     | A capsule's collection window (`accessSeconds`) is honoured by guardians, not enforced on chain: guardians release key pieces only while the window is open.                                                                                                                                                                                     | By design and stated in the threat model: the chain has no time lock that could enforce it.                                                                                                                                                                                                                                                                   |

## Slither results, each explained

- `incorrect-equality` (2): `at == 0` in `CapsuleVault.finalize` and `MizuhikiRegistry._consumeCommitment` tests a
  field for "never set", the intended sentinel; no balance or price is compared.
- `timestamp` (5): capsule times (`releaseAt`, check-ins, waits) are compared with `block.timestamp`. A validator can
  move a timestamp by seconds; capsule windows are an hour at the shortest and usually months. Acceptable.
- `low-level-calls` (2): the two `staticcall`s to QoreChain's PQC precompiles (`0x0A01` verify, `0x0A02` key
  status). Precompiles have no Solidity interface; both calls check success and the answer's length before decoding.

## Invariants the tests hold

- Only the holder of an account's registered ML-DSA-87 key can change anything recorded for that account.
- A signature authorises one action, once, on one contract, on one chain.
- A name has at most one owner; only that owner releases it; a commitment is needed a block before a claim.
- A room's epoch only moves to exactly the next number; only the owner grants or removes admins; the owner role moves
  only by transfer.
- A capsule is released only by its owner, by its time, by the end of a wait the owner did not stop, or by the end of a
  quiet period; a check-in or cancel before the release is finalised always wins.

## Reproduce

```sh
cd contracts
forge test                                      # 41 tests
python3 -m venv ~/.venvs/slither && ~/.venvs/slither/bin/pip install slither-analyzer
~/.venvs/slither/bin/slither . --filter-paths "lib/|test/"
cd .. && pnpm --filter @mizuhiki/testnet drill  # Q-Day Drill rehearsal on testnet
```
