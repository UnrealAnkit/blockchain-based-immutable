'use strict';
/**
 * Terminal walkthrough of the whole system (about 10 seconds):
 *   cold-chain sensors -> gateway (sign) -> database + batch objects -> chain (anchor)
 *   -> audit (all valid) -> an insider hides a temperature excursion -> audit catches it.
 *
 *   npm run demo
 */
const path = require('node:path');
const { createSystem } = require('../src/system');
const { SensorFleet } = require('../src/sensors');
const { verifyBundle } = require('../src/verifier');

const line = (s = '') => console.log(s);
const step = (n, s) => line(`\n[${n}] ${s}`);

(async () => {
  const sys = await createSystem({ dir: path.join(__dirname, '..', 'data', 'demo'), batchSize: 64 });
  step(1, 'Chain started and contract deployed');
  line(`    chain     ${sys.chain.info.kind} ${sys.chain.info.version || ''} (chainId ${sys.chain.chainId})`);
  line(`    contract  ${sys.contractAddress}  (deploy gas ${sys.deployGas})`);
  line(`    gateway   ${sys.wallet.address}  registered as the only account allowed to anchor`);

  // sensor-03 breaks the 2-8 C cold-chain limit for 20 of its readings
  const fleet = new SensorFleet({ devices: 5, seed: 7, excursion: { dev: 'sensor-03', from: 50, to: 69, peak: 9.1 } });
  step(2, 'Ingesting 640 readings from 5 emulated cold-chain sensors (batch size 64)');
  for (const r of fleet.take(640)) sys.gateway.ingest(r);
  await sys.gateway.flush();
  const log = sys.anchorer.log;
  line(`    ${log.length} batches anchored, gas per batch ${Math.min(...log.map((e) => e.gasUsed))}-${Math.max(...log.map((e) => e.gasUsed))}`);
  const b0 = sys.db.getBatch(0);
  line(`    batch 0: seq ${b0.first_seq}-${b0.last_seq}, root ${b0.root.slice(0, 18)}..., object ${b0.manifest_cid.slice(0, 20)}..., tx ${b0.tx_hash.slice(0, 18)}...`);
  const hot = sys.db.db.prepare("SELECT COUNT(*) AS c FROM readings WHERE dev = 'sensor-03' AND temp > 8").get().c;
  line(`    sensor-03 recorded ${hot} readings above 8 C (a cold-chain excursion)`);

  step(3, 'Audit every record against the chain');
  let a = await sys.verifier.audit();
  line(`    ${JSON.stringify(a.counts)}`);

  step(4, 'An insider with database access hides the excursion');
  const changed = sys.db.db.prepare("UPDATE readings SET temp = 6.4 WHERE dev = 'sensor-03' AND temp > 8").run().changes;
  line(`    UPDATE readings SET temp = 6.4 WHERE dev = 'sensor-03' AND temp > 8   -> ${changed} rows changed`);
  const victim = sys.db.db.prepare("SELECT seq FROM readings WHERE dev = 'sensor-01' ORDER BY seq LIMIT 1 OFFSET 30").get().seq;
  sys.db.db.prepare('DELETE FROM readings WHERE seq = ?').run(victim);
  line(`    DELETE FROM readings WHERE seq = ${victim}   -> 1 row deleted`);

  step(5, 'Audit again');
  a = await sys.verifier.audit();
  line(`    ${JSON.stringify(a.counts)}`);
  const tampered = a.problems.filter((p) => p.status === 'TAMPERED').map((p) => p.seq);
  line(`    tampered: seq ${tampered.slice(0, 8).join(', ')}${tampered.length > 8 ? ', ...' : ''} (${tampered.length} flagged; ${changed} were edited)`);
  line(`    reason:   ${a.problems.find((p) => p.status === 'TAMPERED').reasons[0]}`);
  line(`    missing:  seq ${a.problems.filter((p) => p.status === 'MISSING').map((p) => p.seq).join(', ')}`);

  step(6, 'An outside auditor checks one untouched record using only the chain');
  const bundle = await sys.verifier.exportBundle(5);
  const v = await verifyBundle(bundle, sys.contract.connect(sys.chain.provider));
  line(`    bundle: record + signature + ${bundle.proof.length}-hash proof (${JSON.stringify(bundle).length} bytes)`);
  line(`    result: ${JSON.stringify(v)}`);

  await sys.stop();
  line('\nDone.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
