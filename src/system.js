'use strict';
/**
 * Wires the five layers together: chain + contract, gateway key, operator database,
 * content-addressed store, anchorer, gateway and verifier.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');
const { startChain, deployAnchor, anchorAt } = require('./chain');
const { loadOrCreateGatewayKey } = require('./keys');
const { OperatorDB } = require('./db');
const { ObjectStore } = require('./objectstore');
const { Anchorer } = require('./anchorer');
const { Gateway } = require('./gateway');
const { Verifier } = require('./verifier');

/**
 * @param {object} o
 * @param {string} o.dir         working folder for database, objects and key (wiped if fresh)
 * @param {boolean} [o.fresh]    delete `dir` first
 * @param {number} [o.batchSize]
 * @param {number} [o.batchIntervalMs]
 * @param {number} [o.blockTime] seconds between blocks on the embedded chain (0 = instant)
 * @param {object} [o.chain]     reuse an already-started chain
 */
async function createSystem({ dir, fresh = true, batchSize = 64, batchIntervalMs = 0, blockTime = 0, chain = null, label = 'gw-01', quiet = true, onBatch } = {}) {
  if (fresh) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const ownChain = !chain;
  chain = chain || (await startChain({ blockTime }));
  const keyFile = path.join(dir, 'gateway-key.json');
  const gatewayKey = loadOrCreateGatewayKey(keyFile, { quiet });
  const wallet = new Wallet(gatewayKey.privateKey, chain.provider);
  const db = new OperatorDB(path.join(dir, 'operator.db'));
  const store = new ObjectStore(path.join(dir, 'objects'));
  // Reuse the contract recorded in the database if it still exists on this chain
  // (a restart against a persistent chain); otherwise deploy a new one.
  let contract;
  let contractAddress = db.getMeta('contract');
  let deployGas = 0;
  if (contractAddress && (await chain.provider.getCode(contractAddress)) !== '0x') {
    contract = anchorAt(contractAddress, chain.deployer);
  } else {
    ({ contract, address: contractAddress, deployGas } = await deployAnchor(chain, wallet.address));
  }
  db.setMeta('contract', contractAddress);
  db.setMeta('gateway', wallet.address);
  const anchorer = new Anchorer({ contract: contract.connect(wallet), provider: chain.provider, address: wallet.address, db });
  const gateway = new Gateway({ label, wallet, db, store, anchorer, batchSize, batchIntervalMs, onBatch });
  // The verifier gets a read-only contract handle: it never signs anything.
  const verifier = new Verifier({ contract: contract.connect(chain.provider), gatewayAddress: wallet.address, db, store });
  return {
    dir,
    chain,
    contract,
    contractAddress,
    deployGas,
    wallet,
    db,
    store,
    anchorer,
    gateway,
    verifier,
    async stop() {
      gateway.stop();
      await anchorer.drain();
      db.close();
      if (ownChain) await chain.stop();
    },
  };
}

module.exports = { createSystem };
