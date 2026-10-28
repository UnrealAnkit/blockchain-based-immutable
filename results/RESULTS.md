# Phase III results

Generated 2026-10-28T07:25:04.221Z by `npm run experiments`. Timing figures depend on the machine below; gas figures do not.

## Environment

| Item | Value |
| --- | --- |
| date | 2026-10-28T07:25:04.221Z |
| mode | full |
| os | Linux 6.18.44-fc-v180 (x64) |
| cpu | Intel(R) Xeon(R) Processor @ 2.10GHz |
| cores | 2 |
| memoryGB | 7.8 |
| node | v22.23.4 |
| ethers | 6.17.0 |
| ganache | 7.9.2 |
| solc | 0.8.28+commit.7893614a.Emscripten.clang |
| evmVersion | shanghai |

## E1 Batch-size sweep

| Batch size | Readings | Batches | Gas/batch | Gas/record | Proof hashes (max) | Proof bytes (max) | Ingest rec/s | End-to-end rec/s | Audit ms/record | Cold verify ms | All valid |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16 | 4096 | 256 | 105154 | 6572.1 | 4 | 128 | 1941 | 313 | 3.425 | 30.7 | yes |
| 64 | 4096 | 64 | 105152 | 1643 | 6 | 192 | 1728 | 838 | 2.6 | 26.9 | yes |
| 256 | 4096 | 16 | 105145 | 410.7 | 8 | 256 | 1858 | 1402 | 2.673 | 27.9 | yes |
| 1024 | 4096 | 4 | 105131 | 102.7 | 10 | 320 | 2091 | 1911 | 2.608 | 38.3 | yes |

First batch of each contract costs 139323 gas (it also initialises the gateway's storage); later batches cost the figure shown.

| Batch size | Operator DB B/record | Batch object B/record | On-chain state B/record | Calldata B/batch | Bundle B (auditor download) |
| --- | --- | --- | --- | --- | --- |
| 16 | 290 | 251 | 6 | 132 | 675 |
| 64 | 276 | 241 | 1.5 | 132 | 813 |
| 256 | 273 | 238 | 0.375 | 132 | 953 |
| 1024 | 273 | 238 | 0.094 | 132 | 1092 |

## E2 Baseline: one transaction per reading

| Readings | Gas/record | Tx/s achieved | Confirm ms (mean) | On-chain state B/record |
| --- | --- | --- | --- | --- |
| 512 | 45518 | 22.6 | 44.2 | 32 |

Batching at 1024 readings per batch uses 102.7 gas per reading against 45518 for the baseline: 443 times less.

## E3 Anchoring latency and exposure window (50 readings/s, 2 s blocks)

| Interval s | Batches | Readings/batch | Wait in batch ms (mean) | Anchor ms (mean / p95) | Exposure ms mean | p50 | p95 | max | Gas/record |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2 | 14 | 100 | 1002 | 929 / 2073 | 1931 | 1855 | 3792 | 4072 | 1051.6 |
| 5 | 6 | 250 | 2509 | 1194 / 2044 | 3703 | 3703 | 6287 | 7042 | 420.6 |
| 10 | 3 | 500 | 5009 | 1990 / 2024 | 6999 | 6996 | 11495 | 12019 | 210.3 |

Exposure window = time from a reading reaching the gateway until the block containing its batch root is mined. During this window the reading has no ledger protection.

## E4 Tamper-injection matrix (1024 readings, batches of 64)

| ID | Attack | Trials | Targeted | Detected | Missed | Other records flagged | Status seen | Example reason |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C0 | Control: no change | 1 | 0 | 0 | 0 | 0 | all VALID |  |
| A1 | Edit a stored value (temperature) | 10 | 10 | 10 | 0 | 0 | TAMPERED | record hash is not in the anchored batch |
| A2 | Shift a timestamp by 10 minutes | 10 | 10 | 10 | 0 | 0 | TAMPERED | record hash is not in the anchored batch |
| A3 | Relabel the device of a reading | 10 | 10 | 10 | 0 | 0 | TAMPERED | record hash is not in the anchored batch |
| A4 | Delete a reading | 10 | 10 | 10 | 0 | 0 | MISSING | anchored on-chain but the row is gone from the operator database |
| A5 | Swap two readings within a batch (reorder) | 10 | 20 | 20 | 0 | 0 | TAMPERED | record hash is not in the anchored batch |
| A6 | Edit and re-sign with an attacker key | 10 | 10 | 10 | 0 | 0 | TAMPERED | record hash is not in the anchored batch |
| A7 | Edit and re-sign with the stolen gateway key | 10 | 10 | 10 | 0 | 0 | TAMPERED | record hash is not in the anchored batch |
| A8 | Rewrite 5 readings and rebuild the batch object (original copy still pinned) | 10 | 50 | 50 | 0 | 0 | TAMPERED | record hash is not in the anchored batch |
| A9 | Same as A8, and delete the original batch object | 10 | 50 | 50 | 0 | 590 | UNVERIFIABLE | batch object unavailable; operator rows for this batch do not reproduce the anchored root |
| A10 | Delete a whole batch (rows, batch entry, object) | 10 | 640 | 640 | 0 | 0 | MISSING | anchored on-chain but the row is gone from the operator database |
| A11 | Insert a fabricated reading after the last anchored one | 1 | 1 | 1 | 0 | 0 | NOT_ANCHORED | no anchored batch covers this sequence number yet |
| X1 | Out of scope: gateway signs a falsified reading | 1 | 1 | 0 | 1 | 0 | record verifies as VALID | expected: the guarantee begins at the gateway signature |

## E5 Cost of each step (single core)

| Step | Cost |
| --- | --- |
| Canonical JSON of one record | 3.7 µs (91 bytes) |
| SHA-256 of one record | 1.23 µs |
| ECDSA secp256k1 sign | 519.1 µs |
| ECDSA recover signer (verifier) | 2730 µs |
| Merkle tree of 256 leaves | 1.137 ms |
| Merkle proof check (256-leaf tree) | 10.35 µs |
