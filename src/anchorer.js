'use strict';
/**
 * Submits batch commitments to the IoTAnchor contract from the gateway's account.
 *
 * Transactions are sent strictly in batch order with explicit, consecutive nonces,
 * but the anchorer does not wait for one batch to be mined before sending the next,
 * so a slow block does not hold up later batches. The gas limit is set explicitly:
 * estimating gas for batch N+1 while batch N is still pending would fail the
 * contract's sequence check, because estimation runs against the last mined state.
 */
const { waitReceipt } = require('./chain');
const { toHex } = require('./hash');

class Anchorer {
  constructor({ contract, provider, address, db, gasLimit = 200000n, onAnchored = () => {} }) {
    this.contract = contract; // IoTAnchor connected to the gateway wallet
    this.provider = provider;
    this.address = address;
    this.db = db;
    this.gasLimit = gasLimit;
    this.onAnchored = onAnchored;
    this.nonce = null;
    this.sendQueue = Promise.resolve();
    this.inflight = new Set();
    this.log = []; // one entry per batch: timings and gas
  }

  /** Queue one batch for anchoring. Resolves when it is mined (or failed). */
  submit(batch) {
    const send = this.sendQueue.then(async () => {
      if (this.nonce === null) this.nonce = await this.provider.getTransactionCount(this.address, 'pending');
      const submittedAt = Date.now();
      const tx = await this.contract.anchorBatch(toHex(batch.root), toHex(batch.digest), batch.firstSeq, batch.lastSeq, {
        gasLimit: this.gasLimit,
        nonce: this.nonce,
      });
      this.nonce += 1;
      this.db.updateBatch(batch.batchNo, { submitted_at: submittedAt, tx_hash: tx.hash, status: 'submitted' });
      return { tx, submittedAt };
    });
    this.sendQueue = send.catch(() => {}); // keep the queue alive after a failed send

    const done = send
      .then(async ({ tx, submittedAt }) => {
        const receipt = await waitReceipt(this.provider, tx.hash);
        const confirmedAt = Date.now();
        const ok = receipt.status === 1;
        this.db.updateBatch(batch.batchNo, {
          confirmed_at: confirmedAt,
          block_number: receipt.blockNumber,
          gas_used: Number(receipt.gasUsed),
          status: ok ? 'anchored' : 'failed',
        });
        const entry = {
          batchNo: batch.batchNo,
          count: batch.count,
          closedAt: batch.closedAt,
          submittedAt,
          confirmedAt,
          gasUsed: Number(receipt.gasUsed),
          calldataBytes: (tx.data.length - 2) / 2,
          blockNumber: receipt.blockNumber,
          txHash: tx.hash,
          ok,
        };
        this.log.push(entry);
        this.onAnchored(entry);
        return entry;
      })
      .catch((err) => {
        this.db.updateBatch(batch.batchNo, { status: 'failed' });
        const entry = { batchNo: batch.batchNo, ok: false, error: err.shortMessage || err.message };
        this.log.push(entry);
        return entry;
      });

    this.inflight.add(done);
    done.finally(() => this.inflight.delete(done));
    return done;
  }

  /** Wait until every queued batch is mined or failed. */
  async drain() {
    while (this.inflight.size) await Promise.allSettled([...this.inflight]);
  }
}

module.exports = { Anchorer };
