'use strict';
/**
 * The operator's ordinary database (SQLite).
 *
 * This is deliberately a normal, mutable database: an administrator can UPDATE or
 * DELETE any row. The point of the project is that such edits become detectable,
 * not that they become impossible. The verifier treats every column here as
 * untrusted and rebuilds each record from it before checking against the chain.
 */
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS readings (
  seq      INTEGER PRIMARY KEY,
  gw       TEXT    NOT NULL,
  dev      TEXT    NOT NULL,
  ts       INTEGER NOT NULL,
  temp     REAL    NOT NULL,
  hum      REAL    NOT NULL,
  hash     TEXT    NOT NULL,
  sig      TEXT    NOT NULL,
  batch_no INTEGER
);
CREATE INDEX IF NOT EXISTS readings_batch ON readings(batch_no);
CREATE TABLE IF NOT EXISTS batches (
  batch_no     INTEGER PRIMARY KEY,
  first_seq    INTEGER NOT NULL,
  last_seq     INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  root         TEXT    NOT NULL,
  manifest_cid TEXT    NOT NULL,
  closed_at    INTEGER NOT NULL,
  submitted_at INTEGER,
  confirmed_at INTEGER,
  tx_hash      TEXT,
  block_number INTEGER,
  gas_used     INTEGER,
  status       TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

class OperatorDB {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.db.exec(SCHEMA);
    this._insertReading = this.db.prepare(
      'INSERT INTO readings (seq, gw, dev, ts, temp, hum, hash, sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    this._getReading = this.db.prepare('SELECT * FROM readings WHERE seq = ?');
    this._assign = this.db.prepare('UPDATE readings SET batch_no = ? WHERE seq BETWEEN ? AND ?');
    this._insertBatch = this.db.prepare(
      `INSERT INTO batches (batch_no, first_seq, last_seq, count, root, manifest_cid, closed_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'closed')`
    );
  }

  insertReading(record, hashHex, sig) {
    this._insertReading.run(record.seq, record.gw, record.dev, record.ts, record.m.t, record.m.h, hashHex, sig);
  }

  getReading(seq) {
    return this._getReading.get(seq) ?? null;
  }

  readingsInRange(firstSeq, lastSeq) {
    return this.db.prepare('SELECT * FROM readings WHERE seq BETWEEN ? AND ? ORDER BY seq').all(firstSeq, lastSeq);
  }

  latestReadings(limit = 50) {
    return this.db
      .prepare(
        `SELECT r.*, b.status AS batch_status, b.tx_hash AS tx_hash
         FROM readings r LEFT JOIN batches b ON b.batch_no = r.batch_no
         ORDER BY r.seq DESC LIMIT ?`
      )
      .all(limit);
  }

  maxSeq() {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM readings').get();
    return row.m === null ? -1 : Number(row.m);
  }

  allSeqs() {
    return this.db.prepare('SELECT seq FROM readings ORDER BY seq').all().map((r) => Number(r.seq));
  }

  insertBatch(b) {
    this._insertBatch.run(b.batchNo, b.firstSeq, b.lastSeq, b.count, b.root, b.cid, b.closedAt);
    this._assign.run(b.batchNo, b.firstSeq, b.lastSeq);
  }

  updateBatch(batchNo, fields) {
    const keys = Object.keys(fields);
    const sql = `UPDATE batches SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE batch_no = ?`;
    this.db.prepare(sql).run(...keys.map((k) => fields[k]), batchNo);
  }

  getBatch(batchNo) {
    return this.db.prepare('SELECT * FROM batches WHERE batch_no = ?').get(batchNo) ?? null;
  }

  latestBatches(limit = 20) {
    return this.db.prepare('SELECT * FROM batches ORDER BY batch_no DESC LIMIT ?').all(limit);
  }

  maxBatchNo() {
    const row = this.db.prepare('SELECT MAX(batch_no) AS m FROM batches').get();
    return row.m === null ? -1 : Number(row.m);
  }

  counts() {
    return {
      readings: Number(this.db.prepare('SELECT COUNT(*) AS c FROM readings').get().c),
      batches: Number(this.db.prepare('SELECT COUNT(*) AS c FROM batches').get().c),
      anchored: Number(this.db.prepare("SELECT COUNT(*) AS c FROM batches WHERE status = 'anchored'").get().c),
    };
  }

  setMeta(k, v) {
    this.db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
  }

  getMeta(k) {
    return this.db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null;
  }

  /** Bytes used by the database file after a checkpoint (for storage-growth measurements). */
  sizeBytes() {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const pages = Number(this.db.prepare('PRAGMA page_count').get().page_count);
    const pageSize = Number(this.db.prepare('PRAGMA page_size').get().page_size);
    return pages * pageSize;
  }

  close() {
    this.db.close();
  }
}

module.exports = { OperatorDB };
