# Blockchain-Based Immutable Data Logger for IoT

Major Project (Phase III), B.Tech CSE, IILM University, Greater Noida — session 2026-27.
Team: Ankit (2410030468), Garvit (2410030472), Palak (2410030156), Avnish (2410030318). Guide: Mr. Gagan Gupta.

Sensor readings are signed at an edge gateway, stored off-chain, grouped into batches and anchored to an
Ethereum-compatible blockchain as one Merkle root per batch. A verifier recomputes any record's hash and checks
it against the anchored root, so an edit or deletion made later in the operator's database is detected.

```
sensors --MQTT--> gateway (canonical JSON, SHA-256, ECDSA) --> SQLite rows + content-addressed batch objects
                                                           --> IoTAnchor contract (root, object digest, seq range)
verifier: row -> hash -> signer -> batch on-chain -> Merkle proof vs anchored root -> VALID / TAMPERED / MISSING ...
```

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`). Check with `node --version`.
- Nothing else for the core system: the blockchain (Ganache), the MQTT broker (Aedes) and the database start inside the process.
- Optional: Python 3 with matplotlib for `npm run charts`.

## Run it

```bash
npm install
npm test                  # 38 automated tests (unit, contract, integration)
npm run demo              # 10-second terminal walkthrough: anchor, audit, insider edit, audit again
npm run dashboard         # live system + dashboard at http://localhost:3000
npm run experiments       # full measurements (about 8-10 minutes) -> results/RESULTS.md
npm run experiments:quick # smaller run (about 2-3 minutes)
npm run charts            # PNG figures from results/results.json (needs matplotlib)
```

Timings depend on your machine; gas figures do not. Report the numbers from your own run, together with the
environment table at the top of `results/RESULTS.md`.

### Dashboard demo for the viva

1. `npm run dashboard`, open http://localhost:3000.
2. Wait until a few batches show `anchored`. Press **Audit every record**: all valid.
3. Press **Edit a stored temperature** (changes one row in SQLite, as an insider could). Audit again: that record is `TAMPERED`.
4. Press **Delete a stored reading**. Audit again: `MISSING`.
5. Press **Undo demo edits**. Audit again: all valid.

You can also open `data/live/operator.db` in DB Browser for SQLite, edit a row by hand, and press **Verify** on it.

### Independent check by an auditor

```bash
curl http://localhost:3000/api/bundle/12 > bundle.json
node scripts/verify-bundle.js bundle.json <rpc-url-printed-by-the-dashboard>
```

The script uses only the bundle and the chain: it recomputes the hash, recovers the signer and checks the proof
against the root stored in the contract.

### Real sensors (not yet tested on hardware)

`firmware/esp32_dht22_mqtt/esp32_dht22_mqtt.ino` publishes DHT22 readings in the same format. Run the gateway
without emulated sensors and let the board connect to your computer's IP:

```bash
npm run dashboard -- --no-sensors
```

### Other chains

The code talks JSON-RPC, so it works with any EVM chain (Hyperledger Besu, Hardhat node, a public testnet):

```bash
CHAIN_RPC=http://127.0.0.1:8545 DEPLOYER_KEY=0x<funded key> npm run demo
```

With an external chain the gateway account must hold funds for gas.

## Layout

| Path | Layer | What it does |
| --- | --- | --- |
| `src/sensors.js`, `src/mqtt.js` | Perception | Seeded emulated sensors; MQTT broker, publishers, gateway subscription |
| `src/canonical.js`, `src/record.js` | Edge | RFC 8785 canonical JSON; record format; SHA-256; ECDSA sign/recover |
| `src/gateway.js`, `src/keys.js` | Edge | Sequence numbers, timestamps, batching by size or interval; key storage |
| `src/db.js`, `src/objectstore.js`, `src/hash.js` | Storage | SQLite operator DB; content-addressed batch objects (CIDv1) |
| `src/merkle.js`, `src/anchorer.js`, `contracts/IoTAnchor.sol` | Anchoring | RFC 6962 Merkle tree; ordered transactions; the contract |
| `src/verifier.js`, `src/server.js`, `public/index.html` | Verification | Record check, audit, proof bundles; HTTP API; dashboard |
| `contracts/PerRecordBaseline.sol` | Experiment | One-transaction-per-reading baseline |
| `scripts/` | All | demo, dashboard, experiments, charts, auditor check |
| `test/` | All | unit, contract and integration tests |

## Key settings

| Setting | Where | Default |
| --- | --- | --- |
| Batch size / interval | `createSystem({ batchSize, batchIntervalMs })`, dashboard `--batch`, `--interval` | 64 readings; dashboard 50 readings or 10 s |
| Block time of embedded chain | `--block-time` (dashboard), `blockTime` | instant; dashboard 2 s |
| Gateway key password | `GATEWAY_KEY_PASSWORD` | unset: plain key file with mode 0600 |
| External chain | `CHAIN_RPC`, `DEPLOYER_KEY` | embedded Ganache |
| MQTT port | `MQTT_PORT` | 1883 (falls back to a free port) |

## What the system guarantees, and what it does not

- Guarantees: a stored record is the one the gateway signed and anchored; any later change, deletion, reordering or
  substitution of a batch object is detected by an auditor who trusts only the chain.
- Does not guarantee: that the sensor value was physically true, or that the gateway was honest when it signed
  (test X1 in the experiments shows a falsified-before-signing reading verifies as valid). Readings are unprotected
  until their batch is mined (the exposure window measured in E3).
