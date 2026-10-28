'use strict';
/**
 * Edge gateway: the point where a reading first enters the system.
 *
 * For every reading it
 *   1. validates and rounds the values,
 *   2. assigns the next sequence number and the capture timestamp,
 *   3. hashes the canonical JSON record (SHA-256) and signs the hash (ECDSA secp256k1),
 *   4. writes the reading to the operator database,
 *   5. buffers it for the current batch.
 * A batch closes when it reaches `batchSize` readings or when `batchIntervalMs`
 * elapses, whichever comes first. Closing a batch builds the Merkle tree, stores
 * the batch object in the content-addressed store and hands the commitment to
 * the anchorer.
 *
 * Trust boundary: whatever the gateway signs is what the system will later prove.
 * A reading falsified before step 3 verifies as genuine.
 */
const { normaliseReading, makeRecord, recordHash, signHash, recordFromRow } = require('./record');
const { buildLevels } = require('./merkle');
const { canonicalize } = require('./canonical');
const { toHex, digestFromCid } = require('./hash');

class Gateway {
  constructor({ label = 'gw-01', wallet, db, store, anchorer, batchSize = 64, batchIntervalMs = 0, now = Date.now, onBatch = () => {} }) {
    this.label = label;
    this.wallet = wallet;
    this.address = wallet.address;
    this.db = db;
    this.store = store;
    this.anchorer = anchorer;
    this.batchSize = batchSize;
    this.batchIntervalMs = batchIntervalMs;
    this.now = now;
    this.onBatch = onBatch;
    this.timer = null;
    this.nextSeq = db.maxSeq() + 1;
    this.nextBatchNo = db.maxBatchNo() + 1;
    this.buffer = [];
    this.batchStats = []; // build timings per batch
    this._recoverUnbatched();
  }

  /** Readings written to the database but never batched (e.g. after a crash) rejoin the buffer. */
  _recoverUnbatched() {
    const rows = this.db.db.prepare('SELECT * FROM readings WHERE batch_no IS NULL ORDER BY seq').all();
    for (const row of rows) {
      const record = recordFromRow(row);
      this.buffer.push({ record, hash: recordHash(record), sig: row.sig, arrivedAt: Number(row.ts) });
    }
  }

  start() {
    if (this.batchIntervalMs > 0 && !this.timer) {
      this.timer = setInterval(() => this.closeBatch(), this.batchIntervalMs);
    }
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Ingest one reading { dev, t, h }. Returns the assigned sequence number and record hash. */
  ingest(reading) {
    const n = normaliseReading(reading);
    const ts = this.now();
    const record = makeRecord({ gw: this.label, seq: this.nextSeq, ts, dev: n.dev, t: n.t, h: n.h });
    const hash = recordHash(record);
    const sig = signHash(this.wallet.privateKey, hash);
    this.db.insertReading(record, toHex(hash), sig);
    this.nextSeq += 1;
    this.buffer.push({ record, hash, sig, arrivedAt: ts });
    if (this.buffer.length >= this.batchSize) this.closeBatch();
    return { seq: record.seq, hash, record };
  }

  /** Close the current batch (if any) and queue it for anchoring. */
  closeBatch() {
    if (!this.buffer.length) return null;
    const t0 = process.hrtime.bigint();
    const items = this.buffer;
    this.buffer = [];
    const batchNo = this.nextBatchNo++;
    const firstSeq = items[0].record.seq;
    const lastSeq = items.at(-1).record.seq;
    const levels = buildLevels(items.map((x) => x.hash));
    const root = levels.at(-1)[0];
    const object = {
      v: 1,
      type: 'iot-batch',
      gw: this.label,
      gwAddr: this.address,
      batchNo,
      firstSeq,
      lastSeq,
      root: toHex(root),
      records: items.map((x) => ({ r: x.record, s: x.sig })),
    };
    const bytes = Buffer.from(canonicalize(object), 'utf8');
    const cid = this.store.put(bytes);
    const closedAt = Date.now();
    const batch = { batchNo, firstSeq, lastSeq, count: items.length, root, cid, digest: digestFromCid(cid), closedAt, bytes: bytes.length };
    this.db.insertBatch({ ...batch, root: toHex(root) });
    const buildMs = Number(process.hrtime.bigint() - t0) / 1e6;
    this.batchStats.push({ batchNo, count: items.length, buildMs, objectBytes: bytes.length });
    batch.arrivals = items.map((x) => ({ seq: x.record.seq, arrivedAt: x.arrivedAt }));
    batch.anchored = this.anchorer ? this.anchorer.submit(batch) : Promise.resolve(null);
    this.onBatch(batch);
    return batch;
  }

  /** Close the open batch and wait for every batch to be anchored. */
  async flush() {
    this.closeBatch();
    if (this.anchorer) await this.anchorer.drain();
  }
}

module.exports = { Gateway };
