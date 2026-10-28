'use strict';
/**
 * Verification service.
 *
 * Everything the operator holds is treated as untrusted: the database rows, the
 * stored hash and batch columns, and the proofs. The only trusted inputs are
 *   - the contract state on the chain (which batch covers a sequence number, its
 *     Merkle root, its batch-object digest and the registered gateway address), and
 *   - the record contents being checked.
 *
 * For one record the verifier
 *   1. rebuilds the record from the database row and recomputes its SHA-256 hash,
 *   2. recovers the signer from the ECDSA signature and compares it with the gateway,
 *   3. asks the contract which anchored batch covers the record's sequence number,
 *   4. builds the inclusion proof from the batch object fetched by the CID that the
 *      chain names (falling back to the operator's rows only if that object is gone),
 *   5. checks the proof against the anchored root at the position seq - firstSeq.
 *
 * Statuses
 *   VALID         hash in anchored batch at the right position, signed by the gateway
 *   TAMPERED      contents, position or signature do not match what was anchored
 *   MISSING       the chain covers this sequence number but the row is gone
 *   UNVERIFIABLE  the anchored batch object is gone and the operator's rows do not
 *                 reproduce the anchored root, so no record of that batch can be shown genuine
 *   NOT_ANCHORED  the row exists but no anchored batch covers it yet (exposure window)
 */
const { getAddress } = require('ethers');
const { recordFromRow, recordHash, signerOf } = require('./record');
const { buildLevels, proofFromLevels, verifyInclusion } = require('./merkle');
const { toHex, fromHex, cidFromDigest } = require('./hash');

const normBatch = (b) => ({
  root: fromHex(b.root),
  manifestDigest: fromHex(b.manifestDigest),
  firstSeq: Number(b.firstSeq),
  lastSeq: Number(b.lastSeq),
  anchoredAt: Number(b.anchoredAt),
});

class Verifier {
  constructor({ contract, gatewayAddress, db, store }) {
    this.contract = contract;
    this.gateway = getAddress(gatewayAddress);
    this.db = db;
    this.store = store;
    this.batches = null; // chain batches, cached by loadChain()
    this.evidenceCache = new Map();
  }

  /** Forget cached chain state and evidence, so the next check reads everything again. */
  reset() {
    this.batches = null;
    this.evidenceCache.clear();
  }

  /** Read every anchored batch for the gateway from the contract (view calls, no gas). */
  async loadChain() {
    const registered = await this.contract.isGateway(this.gateway);
    const n = Number(await this.contract.batchCount(this.gateway));
    const batches = [];
    for (let i = 0; i < n; i++) batches.push(normBatch(await this.contract.getBatch(this.gateway, i)));
    this.batches = batches;
    this.registered = registered;
    this.evidenceCache.clear();
    return batches;
  }

  /** Locate the anchored batch covering `seq`: cached list if loaded, else the contract's binary search. */
  async batchForSeq(seq) {
    if (this.batches) {
      let lo = 0;
      let hi = this.batches.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const b = this.batches[mid];
        if (seq < b.firstSeq) hi = mid;
        else if (seq > b.lastSeq) lo = mid + 1;
        else return { batchNo: mid, batch: b };
      }
      return null;
    }
    const res = await this.contract.findBatch(this.gateway, seq);
    return res.found ? { batchNo: Number(res.batchNo), batch: normBatch(res.batch) } : null;
  }

  /** Leaves for an anchored batch: from its batch object if retrievable, else from operator rows. */
  evidence(batchNo, batch) {
    if (this.evidenceCache.has(batchNo)) return this.evidenceCache.get(batchNo);
    const size = batch.lastSeq - batch.firstSeq + 1;
    const cid = cidFromDigest(batch.manifestDigest);
    let ev = { source: 'none', cid, objectAvailable: false };
    const bytes = this.store ? this.store.getVerified(cid) : null;
    if (bytes) {
      const obj = JSON.parse(bytes.toString('utf8'));
      const leaves = obj.records.map((x) => recordHash(x.r));
      const levels = buildLevels(leaves);
      ev = {
        source: 'object',
        cid,
        objectAvailable: true,
        levels,
        rootMatches: levels.at(-1)[0].equals(batch.root) && leaves.length === size,
        position: new Map(leaves.map((l, i) => [l.toString('hex'), i])),
      };
    } else {
      const rows = this.db.readingsInRange(batch.firstSeq, batch.lastSeq);
      if (rows.length === size) {
        const levels = buildLevels(rows.map((r) => recordHash(recordFromRow(r))));
        ev = { source: 'operator', cid, objectAvailable: false, levels, rootMatches: levels.at(-1)[0].equals(batch.root) };
      }
    }
    this.evidenceCache.set(batchNo, ev);
    return ev;
  }

  /** Verify the record stored under `seq`. */
  async verifyRecord(seq) {
    const found = await this.batchForSeq(seq);
    const row = this.db.getReading(seq);
    if (!found) {
      return row
        ? { seq, status: 'NOT_ANCHORED', reasons: ['no anchored batch covers this sequence number yet'] }
        : { seq, status: 'UNKNOWN', reasons: ['no such record and no anchored batch covers it'] };
    }
    return this._check(seq, row, found.batchNo, found.batch);
  }

  _check(seq, row, batchNo, batch) {
    const base = { seq, batchNo, root: toHex(batch.root), firstSeq: batch.firstSeq, lastSeq: batch.lastSeq };
    if (!row) return { ...base, status: 'MISSING', reasons: ['anchored on-chain but the row is gone from the operator database'] };

    const record = recordFromRow(row);
    const hash = recordHash(record);
    const reasons = [];
    const signer = signerOf(hash, row.sig);
    const sigOk = signer !== null && signer === this.gateway;
    if (!sigOk) reasons.push('signature was not made by the registered gateway key over these contents');
    if (row.hash !== toHex(hash)) reasons.push('stored hash column does not match the record contents');

    const index = seq - batch.firstSeq;
    const size = batch.lastSeq - batch.firstSeq + 1;
    const ev = this.evidence(batchNo, batch);
    if (ev.source === 'none') {
      return { ...base, status: 'UNVERIFIABLE', reasons: ['batch object unavailable and operator rows incomplete'], hash: toHex(hash) };
    }
    const proof = proofFromLevels(ev.levels, index);
    const merkleOk = verifyInclusion(hash, index, size, proof, batch.root);
    if (!merkleOk) {
      if (ev.source === 'operator') {
        return {
          ...base,
          status: 'UNVERIFIABLE',
          reasons: ['batch object unavailable; operator rows for this batch do not reproduce the anchored root', ...reasons],
          hash: toHex(hash),
        };
      }
      const elsewhere = ev.position.get(hash.toString('hex'));
      reasons.unshift(
        elsewhere === undefined
          ? 'record hash is not in the anchored batch'
          : `record contents were anchored at position ${elsewhere}, not ${index} (reordered)`
      );
    }
    const status = merkleOk && sigOk ? 'VALID' : 'TAMPERED';
    return {
      ...base,
      status,
      reasons,
      hash: toHex(hash),
      leafIndex: index,
      batchSize: size,
      proof: proof.map(toHex),
      evidence: ev.source,
      signer,
    };
  }

  /**
   * Audit every record of the gateway against the chain. Returns per-status counts,
   * the list of non-VALID records, and batch-level evidence problems.
   */
  async audit() {
    await this.loadChain();
    const results = [];
    for (let b = 0; b < this.batches.length; b++) {
      const batch = this.batches[b];
      const rows = new Map(this.db.readingsInRange(batch.firstSeq, batch.lastSeq).map((r) => [Number(r.seq), r]));
      for (let seq = batch.firstSeq; seq <= batch.lastSeq; seq++) results.push(this._check(seq, rows.get(seq) ?? null, b, batch));
    }
    const lastAnchored = this.batches.length ? this.batches.at(-1).lastSeq : -1;
    for (const seq of this.db.allSeqs()) {
      if (seq > lastAnchored) results.push({ seq, status: 'NOT_ANCHORED', reasons: ['no anchored batch covers this sequence number yet'] });
    }
    const counts = { VALID: 0, TAMPERED: 0, MISSING: 0, UNVERIFIABLE: 0, NOT_ANCHORED: 0 };
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    const batchProblems = [];
    for (let b = 0; b < this.batches.length; b++) {
      const ev = this.evidenceCache.get(b);
      if (ev && ev.source !== 'object') batchProblems.push({ batchNo: b, problem: `batch object ${ev.cid} unavailable (evidence from ${ev.source})` });
      else if (ev && !ev.rootMatches) batchProblems.push({ batchNo: b, problem: 'batch object does not reproduce the anchored root' });
    }
    return {
      gateway: this.gateway,
      registered: this.registered,
      anchoredBatches: this.batches.length,
      lastAnchoredSeq: lastAnchored,
      checked: results.length,
      counts,
      problems: results.filter((r) => r.status !== 'VALID'),
      batchProblems,
      results,
    };
  }

  /**
   * Everything an outside auditor needs to check one record without the operator's
   * systems: the record, its signature, the leaf position and the proof. Checked by
   * verifyBundle() against nothing but the chain.
   */
  async exportBundle(seq) {
    const r = await this.verifyRecord(seq);
    const row = this.db.getReading(seq);
    if (!row || !r.proof) throw new Error(`record ${seq} cannot be exported (${r.status})`);
    return {
      v: 1,
      contract: await this.contract.getAddress(),
      gateway: this.gateway,
      record: recordFromRow(row),
      sig: row.sig,
      leafIndex: r.leafIndex,
      batchSize: r.batchSize,
      proof: r.proof,
    };
  }
}

/**
 * Independent check of an exported bundle. Needs only a read-only contract handle
 * (any RPC endpoint): recompute the hash, recover the signer, look up the anchored
 * batch on-chain, verify the proof against the anchored root.
 */
async function verifyBundle(bundle, contract) {
  const gateway = getAddress(bundle.gateway);
  const hash = recordHash(bundle.record);
  const signer = signerOf(hash, bundle.sig);
  const registered = await contract.isGateway(gateway);
  const res = await contract.findBatch(gateway, bundle.record.seq);
  if (!res.found) return { ok: false, reason: 'no anchored batch covers this record' };
  const batch = normBatch(res.batch);
  const index = bundle.record.seq - batch.firstSeq;
  const size = batch.lastSeq - batch.firstSeq + 1;
  const proofOk =
    index === bundle.leafIndex &&
    size === bundle.batchSize &&
    verifyInclusion(hash, index, size, bundle.proof.map(fromHex), batch.root);
  const sigOk = signer === gateway;
  // Current registration is reported but not required: the contract only accepted the
  // batch while the gateway was registered, so records survive a later key rotation.
  return {
    ok: proofOk && sigOk,
    proofOk,
    sigOk,
    registered,
    batchNo: Number(res.batchNo),
    anchoredAt: batch.anchoredAt,
    root: toHex(batch.root),
  };
}

module.exports = { Verifier, verifyBundle };
