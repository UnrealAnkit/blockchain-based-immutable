'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Wallet } = require('ethers');
const { createSystem } = require('../src/system');
const { SensorFleet } = require('../src/sensors');
const { verifyBundle } = require('../src/verifier');
const { recordFromRow, recordHash, signHash } = require('../src/record');
const { toHex, cidFromDigest } = require('../src/hash');
const { startBroker, attachGateway, startPublishers } = require('../src/mqtt');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `iotlog-${name}-`));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('end-to-end pipeline and tamper detection', async (t) => {
  const sys = await createSystem({ dir: tmp('pipe'), batchSize: 50 });
  t.after(() => sys.stop());
  const fleet = new SensorFleet({ devices: 4, seed: 11 });
  for (const r of fleet.take(320)) sys.gateway.ingest(r);
  await sys.gateway.flush();
  const q = (sql, ...a) => sys.db.db.prepare(sql).run(...a);

  await t.test('all batches anchor and every record verifies', async () => {
    assert.equal(sys.anchorer.log.length, 7); // 6 x 50 + 1 x 20
    assert.ok(sys.anchorer.log.every((e) => e.ok));
    const a = await sys.verifier.audit();
    assert.equal(a.counts.VALID, 320);
    assert.equal(a.problems.length, 0);
    assert.equal(a.batchProblems.length, 0);
  });

  await t.test('an edited value is flagged, and only that record', async () => {
    q('UPDATE readings SET temp = temp + 0.5 WHERE seq = 77');
    const a = await sys.verifier.audit();
    assert.deepEqual(a.problems.map((p) => [p.seq, p.status]), [[77, 'TAMPERED']]);
    q('UPDATE readings SET temp = temp - 0.5 WHERE seq = 77');
    assert.equal((await sys.verifier.audit()).counts.VALID, 320, 'restoring the value restores validity');
  });

  await t.test('a deleted row is reported missing', async () => {
    const row = sys.db.getReading(140);
    q('DELETE FROM readings WHERE seq = 140');
    const a = await sys.verifier.audit();
    assert.deepEqual(a.problems.map((p) => [p.seq, p.status]), [[140, 'MISSING']]);
    q('INSERT INTO readings (seq, gw, dev, ts, temp, hum, hash, sig, batch_no) VALUES (?,?,?,?,?,?,?,?,?)',
      row.seq, row.gw, row.dev, row.ts, row.temp, row.hum, row.hash, row.sig, row.batch_no);
  });

  await t.test('swapping two readings is reported as reordering', async () => {
    const a1 = sys.db.getReading(10);
    const b1 = sys.db.getReading(11);
    q('UPDATE readings SET dev=?, ts=?, temp=?, hum=?, hash=?, sig=? WHERE seq = 10', b1.dev, b1.ts, b1.temp, b1.hum, b1.hash, b1.sig);
    q('UPDATE readings SET dev=?, ts=?, temp=?, hum=?, hash=?, sig=? WHERE seq = 11', a1.dev, a1.ts, a1.temp, a1.hum, a1.hash, a1.sig);
    const a = await sys.verifier.audit();
    assert.deepEqual(a.problems.map((p) => p.seq), [10, 11]);
    q('UPDATE readings SET dev=?, ts=?, temp=?, hum=?, hash=?, sig=? WHERE seq = 10', a1.dev, a1.ts, a1.temp, a1.hum, a1.hash, a1.sig);
    q('UPDATE readings SET dev=?, ts=?, temp=?, hum=?, hash=?, sig=? WHERE seq = 11', b1.dev, b1.ts, b1.temp, b1.hum, b1.hash, b1.sig);
  });

  await t.test('re-signing an edited record with the stolen gateway key is still caught by the anchored root', async () => {
    const row = sys.db.getReading(200);
    const rec = recordFromRow({ ...row, temp: 3.3 });
    const h = recordHash(rec);
    q('UPDATE readings SET temp = 3.3, hash = ?, sig = ? WHERE seq = 200', toHex(h), signHash(sys.wallet.privateKey, h));
    const v = await sys.verifier.verifyRecord(200);
    assert.equal(v.status, 'TAMPERED');
    assert.match(v.reasons[0], /not in the anchored batch/);
    q('UPDATE readings SET temp = ?, hash = ?, sig = ? WHERE seq = 200', row.temp, row.hash, row.sig);
  });

  await t.test('a removed batch object is reported, and records fall back to operator rows', async () => {
    sys.verifier.reset();
    await sys.verifier.loadChain();
    const cid = cidFromDigest(sys.verifier.batches[2].manifestDigest);
    const bytes = sys.store.get(cid);
    sys.store.remove(cid);
    let a = await sys.verifier.audit();
    assert.equal(a.counts.VALID, 320, 'untouched rows still reproduce the anchored root');
    assert.equal(a.batchProblems.length, 1);
    q('UPDATE readings SET hum = hum + 1 WHERE seq = 120'); // batch 2 holds seq 100-149
    a = await sys.verifier.audit();
    assert.equal(a.counts.UNVERIFIABLE, 50, 'without the object the whole batch is unverifiable');
    q('UPDATE readings SET hum = hum - 1 WHERE seq = 120');
    fs.writeFileSync(sys.store.pathOf(cid), bytes);
  });

  await t.test('an outside auditor verifies a bundle with only the contract', async () => {
    const bundle = await sys.verifier.exportBundle(33);
    const ro = sys.contract.connect(sys.chain.provider);
    assert.equal((await verifyBundle(bundle, ro)).ok, true);
    const forged = structuredClone(bundle);
    forged.record.m.t += 1;
    assert.equal((await verifyBundle(forged, ro)).ok, false);
    const otherKey = Wallet.createRandom();
    const sigForged = { ...bundle, sig: signHash(otherKey.privateKey, recordHash(bundle.record)) };
    assert.equal((await verifyBundle(sigForged, ro)).sigOk, false);
  });

  await t.test('a reading not yet anchored is reported as such, never as valid', async () => {
    sys.gateway.ingest({ dev: 'sensor-01', t: 5, h: 60 }); // sits in the open batch
    const v = await sys.verifier.verifyRecord(320);
    assert.equal(v.status, 'NOT_ANCHORED');
  });
});

test('gateway restart: unbatched readings are recovered and numbering continues', async (t) => {
  const dir = tmp('restart');
  const a = await createSystem({ dir, batchSize: 1000 });
  for (const r of new SensorFleet({ seed: 5 }).take(30)) a.gateway.ingest(r);
  // simulate a crash: no flush; reopen the same folder against the same chain
  a.gateway.stop();
  a.db.close();
  const b = await createSystem({ dir, fresh: false, batchSize: 1000, chain: a.chain });
  t.after(async () => { await b.stop(); await a.chain.stop(); });
  assert.equal(b.gateway.buffer.length, 30);
  b.gateway.ingest({ dev: 'sensor-01', t: 5, h: 60 });
  assert.equal(b.gateway.nextSeq, 31);
  await b.gateway.flush();
  const audit = await b.verifier.audit();
  assert.equal(audit.counts.VALID, 31);
});

test('MQTT path: emulated sensors publish, the gateway ingests and anchors', async (t) => {
  const sys = await createSystem({ dir: tmp('mqtt'), batchSize: 10, batchIntervalMs: 500 });
  const broker = await startBroker(0);
  const sub = await attachGateway(sys.gateway, broker.url);
  sys.gateway.start();
  const pubs = await startPublishers(broker.url, new SensorFleet({ devices: 3, seed: 9 }), 40);
  await wait(1200);
  await pubs.stop();
  await wait(300);
  // one malformed message is rejected, not ingested
  const mqtt = require('mqtt');
  const bad = await mqtt.connectAsync(broker.url);
  await bad.publishAsync('iot/sensor-01/reading', '{"t": "hot"}', { qos: 1 });
  await bad.endAsync();
  await wait(200);
  t.after(async () => { await sub.close(); await broker.close(); await sys.stop(); });
  await sys.gateway.flush();
  assert.ok(sub.stats.ingested >= 30, `ingested ${sub.stats.ingested}`);
  assert.equal(sub.stats.rejected, 1);
  const a = await sys.verifier.audit();
  assert.equal(a.counts.VALID, sub.stats.ingested);
});
