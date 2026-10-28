'use strict';
/**
 * Phase III experiments. Writes results/results.json and results/RESULTS.md.
 *
 *   npm run experiments          full run (about 8-10 minutes)
 *   npm run experiments:quick    smaller run (about 2-3 minutes)
 *
 * E1  batch-size sweep: gateway throughput, gas per batch and per record, proof size,
 *     verification cost, storage growth
 * E2  baseline: one transaction per reading (the naive design)
 * E3  anchoring latency and exposure window in real time, 50 readings/s, 2-second blocks
 * E4  tamper-injection matrix: 11 attacks plus a control, detection measured per record
 * E5  cost of each cryptographic step at the gateway and at the verifier
 *
 * Timing numbers depend on the machine; gas numbers do not. Re-run on your own machine
 * and report the numbers it prints, with the environment block at the top of RESULTS.md.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Wallet } = require('ethers');
const { createSystem } = require('../src/system');
const { startChain, deployBaseline, waitReceipt, compileContracts } = require('../src/chain');
const { SensorFleet, rng } = require('../src/sensors');
const { OperatorDB } = require('../src/db');
const { ObjectStore } = require('../src/objectstore');
const { Verifier } = require('../src/verifier');
const { canonicalize } = require('../src/canonical');
const { makeRecord, recordHash, recordBytes, signHash, signerOf, recordFromRow } = require('../src/record');
const { buildLevels, proofFromLevels, verifyInclusion } = require('../src/merkle');
const { sha256, toHex, cidOf } = require('../src/hash');

const QUICK = process.argv.includes('--quick');
const ROOT = path.join(__dirname, '..');
const WORK = path.join(ROOT, 'data', 'experiments');
const OUT = path.join(ROOT, 'results');
const log = (...a) => console.log(...a);

// ---------- small statistics helpers ----------
const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const hr = () => process.hrtime.bigint();
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const sleep = (t) => new Promise((r) => setTimeout(r, t));

function environment() {
  const art = compileContracts();
  return {
    date: new Date().toISOString(),
    mode: QUICK ? 'quick' : 'full',
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    cpu: os.cpus()[0]?.model?.trim() ?? 'unknown',
    cores: os.cpus().length,
    memoryGB: r1(os.totalmem() / 2 ** 30),
    node: process.version,
    ethers: require('ethers').version,
    ganache: require('ganache/package.json').version,
    solc: art.solcVersion,
    evmVersion: art.evmVersion,
  };
}

// ---------- E1: batch-size sweep ----------
async function e1BatchSweep(chain) {
  const sizes = QUICK ? [16, 64, 256] : [16, 64, 256, 1024];
  const N = QUICK ? 1024 : 4096;
  const rows = [];
  for (const size of sizes) {
    log(`E1  batch size ${size}: ${N} readings`);
    const sys = await createSystem({ dir: path.join(WORK, `e1-${size}`), batchSize: size, chain });
    const fleet = new SensorFleet({ devices: 50, seed: 1 });
    const readings = fleet.take(N);
    const t0 = hr();
    for (const r of readings) sys.gateway.ingest(r);
    sys.gateway.closeBatch();
    const ingestMs = ms(t0);
    await sys.anchorer.drain();
    const totalMs = ms(t0);

    const anchors = sys.anchorer.log.filter((e) => e.ok);
    const steady = anchors.filter((e) => e.batchNo > 0); // batch 0 also pays first-write costs
    const gasSteady = mean(steady.map((e) => e.gasUsed));
    const gasFirst = anchors.find((e) => e.batchNo === 0).gasUsed;
    const gasTotal = anchors.reduce((s, e) => s + e.gasUsed, 0);

    // verification: full audit (chain read once) and single cold checks (chain read each time)
    const tA = hr();
    const audit = await sys.verifier.audit();
    const auditMs = ms(tA);
    const proofLens = audit.results.map((r) => r.proof.length);
    const rand = rng(99);
    const coldMs = [];
    const bundleBytes = [];
    for (let i = 0; i < 40; i++) {
      const seq = Math.floor(rand() * N);
      sys.verifier.reset();
      const t = hr();
      const v = await sys.verifier.verifyRecord(seq);
      coldMs.push(ms(t));
      if (v.status !== 'VALID') throw new Error(`unexpected ${v.status} for ${seq}`);
      if (i < 10) bundleBytes.push(Buffer.byteLength(JSON.stringify(await sys.verifier.exportBundle(seq))));
    }

    const dbBytes = sys.db.sizeBytes();
    const objBytes = sys.store.sizeBytes();
    rows.push({
      batchSize: size,
      readings: N,
      batches: anchors.length,
      allValid: audit.counts.VALID === N,
      ingestPerSec: Math.round(N / (ingestMs / 1000)),
      endToEndPerSec: Math.round(N / (totalMs / 1000)),
      batchBuildMs: r3(mean(sys.gateway.batchStats.map((b) => b.buildMs))),
      gasFirstBatch: gasFirst,
      gasPerBatch: Math.round(gasSteady),
      gasPerRecord: r1(gasSteady / size),
      gasTotal,
      calldataBytesPerBatch: anchors[0].calldataBytes,
      txConfirmMsMean: r1(mean(anchors.map((e) => e.confirmedAt - e.submittedAt))),
      proofHashesMax: Math.max(...proofLens),
      proofHashesMean: r2(mean(proofLens)),
      proofBytesMax: Math.max(...proofLens) * 32,
      auditMsPerRecord: r3(auditMs / N),
      coldVerifyMsMean: r1(mean(coldMs)),
      coldVerifyMsP95: r1(pct(coldMs, 95)),
      bundleBytesMean: Math.round(mean(bundleBytes)),
      operatorDbBytesPerRecord: Math.round(dbBytes / N),
      batchObjectBytesPerRecord: Math.round(objBytes / N),
      onChainStateBytesPerRecord: r3(96 / size), // 3 storage slots per batch
    });
    await sys.stop();
  }
  return rows;
}

// ---------- E2: one transaction per reading ----------
async function e2Baseline(chain) {
  const M = QUICK ? 128 : 512;
  log(`E2  baseline: ${M} readings, one transaction each`);
  const baseline = await deployBaseline(chain);
  const wallet = new Wallet(Wallet.createRandom().privateKey, chain.provider);
  await (await chain.deployer.sendTransaction({ to: wallet.address, value: 10n ** 19n })).wait();
  const c = baseline.connect(wallet);
  const fleet = new SensorFleet({ devices: 50, seed: 1 });
  let nonce = await chain.provider.getTransactionCount(wallet.address, 'pending');
  const gas = [];
  const confirm = [];
  const t0 = hr();
  for (let i = 0; i < M; i++) {
    const r = fleet.next();
    const h = recordHash(makeRecord({ gw: 'gw-01', seq: i, ts: Date.now(), dev: r.dev, t: Math.round(r.t * 100) / 100, h: Math.round(r.h * 10) / 10 }));
    const t = Date.now();
    const tx = await c.anchorRecord(toHex(h), { gasLimit: 100000, nonce: nonce++ });
    const rec = await waitReceipt(chain.provider, tx.hash);
    confirm.push(Date.now() - t);
    gas.push(Number(rec.gasUsed));
  }
  const totalMs = ms(t0);
  return {
    readings: M,
    gasPerRecord: Math.round(mean(gas)),
    gasMin: Math.min(...gas),
    gasMax: Math.max(...gas),
    txPerSecAchieved: r1(M / (totalMs / 1000)),
    txConfirmMsMean: r1(mean(confirm)),
    calldataBytesPerRecord: 4 + 32,
    onChainStateBytesPerRecord: 32,
  };
}

// ---------- E3: latency / exposure window in real time ----------
async function e3Latency() {
  const intervals = QUICK ? [2, 5] : [2, 5, 10];
  const duration = QUICK ? 12 : 30;
  const rate = 50; // 50 devices x 1 reading per second
  const blockTime = 2;
  log(`E3  latency: ${rate} readings/s for ${duration}s per interval, ${blockTime}s blocks (${intervals.length} runs)`);
  const chain = await startChain({ blockTime });
  const rows = [];
  for (const T of intervals) {
    const closed = [];
    const sys = await createSystem({
      dir: path.join(WORK, `e3-${T}`),
      batchSize: 1e9,
      batchIntervalMs: T * 1000,
      chain,
      onBatch: (b) => closed.push(b),
    });
    const fleet = new SensorFleet({ devices: 50, seed: 2 });
    sys.gateway.start();
    const t0 = Date.now();
    let sent = 0;
    while (Date.now() - t0 < duration * 1000) {
      const due = Math.floor(((Date.now() - t0) / 1000) * rate);
      while (sent < due) {
        sys.gateway.ingest(fleet.next());
        sent += 1;
      }
      await sleep(5);
    }
    sys.gateway.stop();
    const timerBatches = closed.slice(); // closed by the interval timer
    sys.gateway.closeBatch(); // the tail, closed early; left out of the statistics
    const entries = await Promise.all(timerBatches.map((b) => b.anchored));
    const exposure = [];
    const waitInBatch = [];
    const anchorMs = [];
    timerBatches.forEach((b, i) => {
      const e = entries[i];
      if (!e.ok) return;
      anchorMs.push(e.confirmedAt - b.closedAt);
      for (const a of b.arrivals) {
        exposure.push(e.confirmedAt - a.arrivedAt);
        waitInBatch.push(b.closedAt - a.arrivedAt);
      }
    });
    await sys.anchorer.drain();
    rows.push({
      intervalSec: T,
      blockTimeSec: blockTime,
      readings: exposure.length,
      batches: timerBatches.length,
      meanBatch: Math.round(exposure.length / timerBatches.length),
      waitInBatchMsMean: Math.round(mean(waitInBatch)),
      anchorMsMean: Math.round(mean(anchorMs)),
      anchorMsP95: Math.round(pct(anchorMs, 95)),
      exposureMsMean: Math.round(mean(exposure)),
      exposureMsP50: Math.round(pct(exposure, 50)),
      exposureMsP95: Math.round(pct(exposure, 95)),
      exposureMsMax: Math.round(Math.max(...exposure)),
      gasPerRecord: r1(mean(entries.filter((e) => e.ok && e.batchNo > 0).map((e) => e.gasUsed / e.count))),
    });
    await sys.stop();
  }
  await chain.stop();
  return rows;
}

// ---------- E4: tamper-injection matrix ----------
async function e4Tamper(chain) {
  const N = QUICK ? 512 : 1024;
  const B = 64;
  const trials = QUICK ? 5 : 10;
  const FALSIFIED_SEQ = 300;
  log(`E4  tamper matrix: ${N} readings in batches of ${B}, ${trials} trials per randomised attack`);
  const sys = await createSystem({ dir: path.join(WORK, 'e4-base'), batchSize: B, chain });
  const fleet = new SensorFleet({ devices: 8, seed: 3 });
  for (let i = 0; i < N; i++) {
    const r = fleet.next();
    // Out-of-scope case: a compromised gateway replaces one true reading before signing it.
    sys.gateway.ingest(i === FALSIFIED_SEQ ? { ...r, t: 6.1 } : r);
  }
  await sys.gateway.flush();
  sys.db.sizeBytes(); // checkpoint the WAL so a file copy is complete
  const baseDb = path.join(sys.dir, 'operator.db');
  const baseObjects = path.join(sys.dir, 'objects');
  const gatewayKey = sys.wallet.privateKey;
  const attackerKey = Wallet.createRandom().privateKey;
  const roContract = sys.contract.connect(chain.provider);
  const gwAddress = sys.wallet.address;
  await sys.verifier.loadChain();
  const chainBatches = sys.verifier.batches;

  // helpers that act on a trial copy
  // Every edit below changes the value (a "change" to the same value would not be tampering).
  const bump = (db, seq) => ({ temp: Math.round((db.getReading(seq).temp + 1.25) * 100) / 100 });
  const resign = (db, seq, change, key) => {
    const row = db.getReading(seq);
    const rec = recordFromRow({ ...row, ...change });
    const h = recordHash(rec);
    const sets = Object.keys(change).map((k) => `${k} = ?`).join(', ');
    db.db.prepare(`UPDATE readings SET ${sets}, hash = ?, sig = ? WHERE seq = ?`).run(...Object.values(change), toHex(h), signHash(key, h), seq);
  };
  const rewriteBatch = (db, store, b, seqs) => {
    for (const s of seqs) resign(db, s, bump(db, s), gatewayKey);
    const rows = db.readingsInRange(chainBatches[b].firstSeq, chainBatches[b].lastSeq);
    const records = rows.map((r) => ({ r: recordFromRow(r), s: r.sig }));
    const root = buildLevels(records.map((x) => recordHash(x.r))).at(-1)[0];
    const obj = { v: 1, type: 'iot-batch', gw: 'gw-01', gwAddr: gwAddress, batchNo: b, firstSeq: chainBatches[b].firstSeq, lastSeq: chainBatches[b].lastSeq, root: toHex(root), records };
    const cid = store.put(Buffer.from(canonicalize(obj)));
    db.db.prepare('UPDATE batches SET root = ?, manifest_cid = ? WHERE batch_no = ?').run(toHex(root), cid, b);
    return db.getBatch(b);
  };

  const attacks = [
    { id: 'A1', name: 'Edit a stored value (temperature)', run: ({ db, pick }) => {
      const s = pick(); db.db.prepare('UPDATE readings SET temp = temp - 1.5 WHERE seq = ?').run(s); return [s]; } },
    { id: 'A2', name: 'Shift a timestamp by 10 minutes', run: ({ db, pick }) => {
      const s = pick(); db.db.prepare('UPDATE readings SET ts = ts + 600000 WHERE seq = ?').run(s); return [s]; } },
    { id: 'A3', name: 'Relabel the device of a reading', run: ({ db, pick }) => {
      const s = pick(); db.db.prepare("UPDATE readings SET dev = CASE WHEN dev = 'sensor-01' THEN 'sensor-02' ELSE 'sensor-01' END WHERE seq = ?").run(s); return [s]; } },
    { id: 'A4', name: 'Delete a reading', run: ({ db, pick }) => {
      const s = pick(); db.db.prepare('DELETE FROM readings WHERE seq = ?').run(s); return [s]; } },
    { id: 'A5', name: 'Swap two readings within a batch (reorder)', run: ({ db, pick }) => {
      const a = pick(); const b = a % B === B - 1 ? a - 1 : a + 1;
      const x = db.getReading(a); const y = db.getReading(b);
      const set = db.db.prepare('UPDATE readings SET dev=?, ts=?, temp=?, hum=?, hash=?, sig=? WHERE seq = ?');
      set.run(y.dev, y.ts, y.temp, y.hum, y.hash, y.sig, a); set.run(x.dev, x.ts, x.temp, x.hum, x.hash, x.sig, b);
      return [a, b]; } },
    { id: 'A6', name: 'Edit and re-sign with an attacker key', run: ({ db, pick }) => {
      const s = pick(); resign(db, s, bump(db, s), attackerKey); return [s]; } },
    { id: 'A7', name: 'Edit and re-sign with the stolen gateway key', run: ({ db, pick }) => {
      const s = pick(); resign(db, s, bump(db, s), gatewayKey); return [s]; } },
    { id: 'A8', name: 'Rewrite 5 readings and rebuild the batch object (original copy still pinned)', run: ({ db, store, pickBatch }) => {
      const b = pickBatch(); const f = chainBatches[b].firstSeq; const seqs = [f + 3, f + 10, f + 20, f + 33, f + 50];
      rewriteBatch(db, store, b, seqs); return seqs; } },
    { id: 'A9', name: 'Same as A8, and delete the original batch object', run: ({ db, store, pickBatch }) => {
      const b = pickBatch(); const f = chainBatches[b].firstSeq; const seqs = [f + 3, f + 10, f + 20, f + 33, f + 50];
      const orig = db.getBatch(b).manifest_cid; rewriteBatch(db, store, b, seqs); store.remove(orig); return seqs; } },
    { id: 'A10', name: 'Delete a whole batch (rows, batch entry, object)', run: ({ db, store, pickBatch }) => {
      const b = pickBatch(); const { firstSeq: f, lastSeq: l } = chainBatches[b];
      const cid = db.getBatch(b).manifest_cid;
      db.db.prepare('DELETE FROM readings WHERE seq BETWEEN ? AND ?').run(f, l);
      db.db.prepare('DELETE FROM batches WHERE batch_no = ?').run(b); store.remove(cid);
      return Array.from({ length: l - f + 1 }, (_, i) => f + i); } },
    { id: 'A11', name: 'Insert a fabricated reading after the last anchored one', run: ({ db }) => {
      const seq = N; const rec = makeRecord({ gw: 'gw-01', seq, ts: Date.now(), dev: 'sensor-01', t: 5.0, h: 60 });
      const h = recordHash(rec);
      db.insertReading(rec, toHex(h), signHash(gatewayKey, h)); return [seq]; } },
  ];

  const runTrial = async (attack, seed) => {
    const dir = path.join(WORK, 'e4-trial');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(baseDb, path.join(dir, 'operator.db'));
    fs.cpSync(baseObjects, path.join(dir, 'objects'), { recursive: true });
    const db = new OperatorDB(path.join(dir, 'operator.db'));
    const store = new ObjectStore(path.join(dir, 'objects'));
    const rand = rng(seed);
    const pick = () => Math.floor(rand() * N);
    const pickBatch = () => Math.floor(rand() * chainBatches.length);
    const truth = new Set(attack ? attack.run({ db, store, pick, pickBatch }) : []);
    const verifier = new Verifier({ contract: roContract, gatewayAddress: gwAddress, db, store });
    const t0 = hr();
    const audit = await verifier.audit();
    const auditMs = ms(t0);
    db.close();
    const flagged = new Map(audit.problems.map((p) => [p.seq, p]));
    let tp = 0;
    for (const s of truth) if (flagged.has(s)) tp += 1;
    const extra = [...flagged.keys()].filter((s) => !truth.has(s));
    const statuses = [...new Set([...flagged.values()].map((p) => p.status))];
    const example = [...flagged.values()].find((p) => truth.has(p.seq)) ?? [...flagged.values()][0];
    return { truth: truth.size, tp, fn: truth.size - tp, extra: extra.length, statuses, reason: example?.reasons?.[0] ?? '', auditMs, checked: audit.checked };
  };

  const rows = [];
  // control: nothing changed
  {
    const t = await runTrial(null, 1);
    rows.push({ id: 'C0', name: 'Control: no change', trials: 1, targeted: 0, detected: 0, missed: 0, extraFlagged: t.extra, detectionRate: null, statuses: t.statuses.join(', ') || 'all VALID', exampleReason: '', auditMsMean: Math.round(t.auditMs) });
  }
  for (const a of attacks) {
    const runs = [];
    const n = a.id === 'A11' ? 1 : trials;
    for (let i = 0; i < n; i++) runs.push(await runTrial(a, 1000 + i * 7919));
    const targeted = runs.reduce((s, r) => s + r.truth, 0);
    const detected = runs.reduce((s, r) => s + r.tp, 0);
    rows.push({
      id: a.id,
      name: a.name,
      trials: n,
      targeted,
      detected,
      missed: targeted - detected,
      extraFlagged: runs.reduce((s, r) => s + r.extra, 0),
      detectionRate: r3(detected / targeted),
      statuses: [...new Set(runs.flatMap((r) => r.statuses))].join(', '),
      exampleReason: runs[0].reason,
      auditMsMean: Math.round(mean(runs.map((r) => r.auditMs))),
    });
    log(`    ${a.id} ${a.name}: ${detected}/${targeted} detected, ${rows.at(-1).extraFlagged} extra flagged`);
  }
  // out of scope: falsified before signing
  {
    const t = await runTrial(null, 2);
    const v = new Verifier({ contract: roContract, gatewayAddress: gwAddress, db: new OperatorDB(baseDb), store: new ObjectStore(baseObjects) });
    const r = await v.verifyRecord(FALSIFIED_SEQ);
    v.db.close();
    rows.push({ id: 'X1', name: 'Out of scope: gateway signs a falsified reading', trials: 1, targeted: 1, detected: r.status === 'VALID' ? 0 : 1, missed: r.status === 'VALID' ? 1 : 0, extraFlagged: t.extra, detectionRate: r.status === 'VALID' ? 0 : 1, statuses: `record verifies as ${r.status}`, exampleReason: 'expected: the guarantee begins at the gateway signature', auditMsMean: Math.round(t.auditMs) });
  }
  await sys.stop();
  return { readings: N, batchSize: B, trialsPerAttack: trials, rows };
}

// ---------- E5: cost of each step ----------
function e5Steps() {
  const M = QUICK ? 1000 : 3000;
  log(`E5  per-step costs over ${M} records`);
  const key = Wallet.createRandom().privateKey;
  const addr = new Wallet(key).address;
  const fleet = new SensorFleet({ devices: 10, seed: 4 });
  const recs = Array.from({ length: M }, (_, i) => {
    const r = fleet.next();
    return makeRecord({ gw: 'gw-01', seq: i, ts: 1761638400000 + i * 1000, dev: r.dev, t: Math.round(r.t * 100) / 100, h: Math.round(r.h * 10) / 10 });
  });
  const time = (f) => {
    const t0 = hr();
    const out = f();
    return { us: (ms(t0) * 1000) / M, out };
  };
  const canon = time(() => recs.map((r) => recordBytes(r)));
  const hashes = time(() => canon.out.map((b) => sha256(b)));
  const sigs = time(() => hashes.out.map((h) => signHash(key, h)));
  const rec = time(() => hashes.out.map((h, i) => signerOf(h, sigs.out[i])));
  if (!rec.out.every((a) => a === addr)) throw new Error('signature recovery failed');
  const levels = buildLevels(hashes.out.slice(0, 256));
  const root = levels.at(-1)[0];
  const proofs = Array.from({ length: 256 }, (_, i) => proofFromLevels(levels, i));
  const t0 = hr();
  for (let k = 0; k < M; k++) {
    const i = k % 256;
    if (!verifyInclusion(hashes.out[i], i, 256, proofs[i], root)) throw new Error('proof failed');
  }
  const proofUs = (ms(t0) * 1000) / M;
  const t1 = hr();
  for (let k = 0; k < Math.max(1, M / 100); k++) buildLevels(hashes.out.slice(0, 256));
  const tree256Ms = ms(t1) / Math.max(1, M / 100);
  const recordBytesMean = mean(canon.out.map((b) => b.length));
  return {
    records: M,
    canonicalJsonUs: r2(canon.us),
    sha256Us: r2(hashes.us),
    ecdsaSignUs: r1(sigs.us),
    ecdsaRecoverUs: r1(rec.us),
    merkleProofVerifyUs: r2(proofUs),
    merkleTree256Ms: r3(tree256Ms),
    canonicalRecordBytes: Math.round(recordBytesMean),
    cidExample: cidOf(canon.out[0]),
  };
}

// ---------- report ----------
function table(headers, rows) {
  return [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
}

function writeReport(res) {
  const { env, e1, e2, e3, e4, e5 } = res;
  const big = e1.at(-1);
  const md = [];
  md.push('# Phase III results', '');
  md.push(`Generated ${env.date} by \`npm run experiments${QUICK ? ':quick' : ''}\`. Timing figures depend on the machine below; gas figures do not.`, '');
  md.push('## Environment', '');
  md.push(table(['Item', 'Value'], Object.entries(env).map(([k, v]) => [k, String(v)])), '');
  md.push('## E1 Batch-size sweep', '');
  md.push(table(
    ['Batch size', 'Readings', 'Batches', 'Gas/batch', 'Gas/record', 'Proof hashes (max)', 'Proof bytes (max)', 'Ingest rec/s', 'End-to-end rec/s', 'Audit ms/record', 'Cold verify ms', 'All valid'],
    e1.map((r) => [r.batchSize, r.readings, r.batches, r.gasPerBatch, r.gasPerRecord, r.proofHashesMax, r.proofBytesMax, r.ingestPerSec, r.endToEndPerSec, r.auditMsPerRecord, r.coldVerifyMsMean, r.allValid ? 'yes' : 'NO'])
  ), '');
  md.push(`First batch of each contract costs ${e1[0].gasFirstBatch} gas (it also initialises the gateway's storage); later batches cost the figure shown.`, '');
  md.push(table(
    ['Batch size', 'Operator DB B/record', 'Batch object B/record', 'On-chain state B/record', 'Calldata B/batch', 'Bundle B (auditor download)'],
    e1.map((r) => [r.batchSize, r.operatorDbBytesPerRecord, r.batchObjectBytesPerRecord, r.onChainStateBytesPerRecord, r.calldataBytesPerBatch, r.bundleBytesMean])
  ), '');
  md.push('## E2 Baseline: one transaction per reading', '');
  md.push(table(['Readings', 'Gas/record', 'Tx/s achieved', 'Confirm ms (mean)', 'On-chain state B/record'], [[e2.readings, e2.gasPerRecord, e2.txPerSecAchieved, e2.txConfirmMsMean, e2.onChainStateBytesPerRecord]]), '');
  md.push(`Batching at ${big.batchSize} readings per batch uses ${big.gasPerRecord} gas per reading against ${e2.gasPerRecord} for the baseline: ${Math.round(e2.gasPerRecord / big.gasPerRecord)} times less.`, '');
  md.push('## E3 Anchoring latency and exposure window (50 readings/s, 2 s blocks)', '');
  md.push(table(
    ['Interval s', 'Batches', 'Readings/batch', 'Wait in batch ms (mean)', 'Anchor ms (mean / p95)', 'Exposure ms mean', 'p50', 'p95', 'max', 'Gas/record'],
    e3.map((r) => [r.intervalSec, r.batches, r.meanBatch, r.waitInBatchMsMean, `${r.anchorMsMean} / ${r.anchorMsP95}`, r.exposureMsMean, r.exposureMsP50, r.exposureMsP95, r.exposureMsMax, r.gasPerRecord])
  ), '');
  md.push('Exposure window = time from a reading reaching the gateway until the block containing its batch root is mined. During this window the reading has no ledger protection.', '');
  md.push(`## E4 Tamper-injection matrix (${e4.readings} readings, batches of ${e4.batchSize})`, '');
  md.push(table(
    ['ID', 'Attack', 'Trials', 'Targeted', 'Detected', 'Missed', 'Other records flagged', 'Status seen', 'Example reason'],
    e4.rows.map((r) => [r.id, r.name, r.trials, r.targeted, r.detected, r.missed, r.extraFlagged, r.statuses, r.exampleReason])
  ), '');
  md.push('## E5 Cost of each step (single core)', '');
  md.push(table(['Step', 'Cost'], [
    ['Canonical JSON of one record', `${e5.canonicalJsonUs} µs (${e5.canonicalRecordBytes} bytes)`],
    ['SHA-256 of one record', `${e5.sha256Us} µs`],
    ['ECDSA secp256k1 sign', `${e5.ecdsaSignUs} µs`],
    ['ECDSA recover signer (verifier)', `${e5.ecdsaRecoverUs} µs`],
    ['Merkle tree of 256 leaves', `${e5.merkleTree256Ms} ms`],
    ['Merkle proof check (256-leaf tree)', `${e5.merkleProofVerifyUs} µs`],
  ]), '');
  fs.writeFileSync(path.join(OUT, 'RESULTS.md'), md.join('\n'));
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  const env = environment();
  log(`Environment: ${env.cpu}, ${env.cores} cores, Node ${env.node}`);
  const chain = await startChain({ blockTime: 0 });
  const e1 = await e1BatchSweep(chain);
  const e2 = await e2Baseline(chain);
  const e4 = await e4Tamper(chain);
  await chain.stop();
  const e3 = await e3Latency();
  const e5 = e5Steps();
  const res = { env, e1, e2, e3, e4, e5, runtimeSec: Math.round((Date.now() - t0) / 1000) };
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(res, null, 2));
  writeReport(res);
  log(`\nDone in ${res.runtimeSec}s. See results/RESULTS.md and results/results.json`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
