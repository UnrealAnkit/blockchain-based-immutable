'use strict';
/**
 * Independent auditor check. Needs nothing from the operator except the bundle file:
 *
 *   node scripts/verify-bundle.js bundle.json <rpc-url>
 *
 * The bundle comes from GET /api/bundle/<seq>. The script recomputes the record hash,
 * recovers the signer, asks the contract (over the given RPC endpoint) for the anchored
 * batch and checks the Merkle proof against the anchored root.
 */
const fs = require('node:fs');
const { JsonRpcProvider } = require('ethers');
const { anchorAt } = require('../src/chain');
const { verifyBundle } = require('../src/verifier');

(async () => {
  const [file, rpc] = process.argv.slice(2);
  if (!file || !rpc) {
    console.error('usage: node scripts/verify-bundle.js <bundle.json> <rpc-url>');
    process.exit(2);
  }
  const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
  const provider = new JsonRpcProvider(rpc);
  const result = await verifyBundle(bundle, anchorAt(bundle.contract, provider));
  console.log(JSON.stringify(result, null, 2));
  provider.destroy();
  process.exit(result.ok ? 0 : 1);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
