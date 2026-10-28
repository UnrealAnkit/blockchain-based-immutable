'use strict';
/**
 * Content-addressed object store for batch objects.
 *
 * Each object is saved under its CID (CIDv1, raw codec, sha2-256), the same
 * identifier IPFS would give the same bytes. Because the on-chain record holds
 * the SHA-256 digest that sits inside the CID, an auditor can fetch the batch
 * object from any copy (this folder, a mirror, or an IPFS node) and check it
 * against the chain. `getVerified` refuses bytes that do not hash to their CID.
 */
const fs = require('node:fs');
const path = require('node:path');
const { cidOf, digestFromCid, sha256 } = require('./hash');

class ObjectStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  pathOf(cid) {
    return path.join(this.dir, cid);
  }

  /** Store bytes; returns their CID. Idempotent. */
  put(bytes) {
    const cid = cidOf(bytes);
    const p = this.pathOf(cid);
    if (!fs.existsSync(p)) fs.writeFileSync(p, bytes);
    return cid;
  }

  has(cid) {
    return fs.existsSync(this.pathOf(cid));
  }

  /** Raw bytes, or null if missing. No integrity check. */
  get(cid) {
    const p = this.pathOf(cid);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  /** Bytes only if they still hash to the CID they are filed under; otherwise null. */
  getVerified(cid) {
    const bytes = this.get(cid);
    if (!bytes) return null;
    return sha256(bytes).equals(digestFromCid(cid)) ? bytes : null;
  }

  remove(cid) {
    fs.rmSync(this.pathOf(cid), { force: true });
  }

  sizeBytes() {
    let total = 0;
    for (const f of fs.readdirSync(this.dir)) total += fs.statSync(path.join(this.dir, f)).size;
    return total;
  }
}

module.exports = { ObjectStore };
