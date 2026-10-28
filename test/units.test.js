'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { canonicalize } = require('../src/canonical');
const { sha256, cidOf, cidFromDigest, digestFromCid, toHex } = require('../src/hash');
const merkle = require('../src/merkle');
const { Wallet } = require('ethers');
const { normaliseReading, makeRecord, recordHash, signHash, signerOf, recordFromRow } = require('../src/record');
const { SensorFleet } = require('../src/sensors');

// ---------- canonical JSON ----------
test('canonical JSON sorts keys at every level and drops whitespace', () => {
  assert.equal(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
});

test('canonical JSON uses ECMAScript number form', () => {
  assert.equal(canonicalize([1.0, 4.62, -0, 1e21, 1e-7, 100]), '[1,4.62,0,1e+21,1e-7,100]');
});

test('canonical JSON gives the same bytes regardless of key insertion order', () => {
  const a = { v: 1, gw: 'gw-01', m: { t: 4.5, h: 60 } };
  const b = { m: { h: 60, t: 4.5 }, gw: 'gw-01', v: 1 };
  assert.equal(canonicalize(a), canonicalize(b));
});

test('canonical JSON rejects values that cannot round-trip', () => {
  assert.throws(() => canonicalize({ t: NaN }));
  assert.throws(() => canonicalize({ t: Infinity }));
  assert.throws(() => canonicalize({ t: undefined }));
});

// ---------- hashing and CIDs ----------
test('SHA-256 matches the FIPS 180-4 "abc" test vector', () => {
  assert.equal(sha256(Buffer.from('abc')).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('CID of the empty byte string matches the IPFS raw-leaf CID', () => {
  assert.equal(cidOf(Buffer.alloc(0)), 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku');
});

test('CID <-> digest round trip', () => {
  const d = sha256(Buffer.from('batch object'));
  assert.ok(digestFromCid(cidFromDigest(d)).equals(d));
});

// ---------- Merkle tree ----------
const leaves = (n) => Array.from({ length: n }, (_, i) => sha256(Buffer.from(`leaf-${i}`)));

test('bottom-up root equals the recursive RFC 6962 definition for 1..130 leaves', () => {
  for (let n = 1; n <= 130; n++) {
    const L = leaves(n);
    assert.ok(merkle.rootOf(L).equals(merkle.rootRecursive(L)), `n=${n}`);
  }
});

test('every inclusion proof verifies, for every leaf of every size 1..70', () => {
  for (let n = 1; n <= 70; n++) {
    const L = leaves(n);
    const levels = merkle.buildLevels(L);
    const root = levels.at(-1)[0];
    for (let i = 0; i < n; i++) {
      const p = merkle.proofFromLevels(levels, i);
      assert.ok(p.length <= Math.ceil(Math.log2(n)), `proof too long n=${n} i=${i}`);
      assert.ok(merkle.verifyInclusion(L[i], i, n, p, root), `n=${n} i=${i}`);
    }
  }
});

test('a proof fails for the wrong leaf, position, size, root or a changed sibling', () => {
  const n = 37;
  const L = leaves(n);
  const levels = merkle.buildLevels(L);
  const root = levels.at(-1)[0];
  for (let i = 0; i < n; i++) {
    const p = merkle.proofFromLevels(levels, i);
    assert.equal(merkle.verifyInclusion(L[(i + 1) % n], i, n, p, root), false, 'wrong leaf');
    assert.equal(merkle.verifyInclusion(L[i], (i + 1) % n, n, p, root), false, 'wrong position');
    // A size whose tree has a different path shape fails. (Sizes with the same shape for this
    // leaf, e.g. n+1 here, accept the same proof: RFC 9162 does not bind the exact size. In this
    // system the size is never taken from the operator; it comes from firstSeq/lastSeq on-chain.)
    assert.equal(merkle.verifyInclusion(L[i], i, n * 4, p, root), false, 'wrong size');
    assert.equal(merkle.verifyInclusion(L[i], i, n, p, sha256(Buffer.from('x'))), false, 'wrong root');
    for (let k = 0; k < p.length; k++) {
      const bad = p.map((x, j) => (j === k ? sha256(x) : x));
      assert.equal(merkle.verifyInclusion(L[i], i, n, bad, root), false, 'changed sibling');
    }
    assert.equal(merkle.verifyInclusion(L[i], i, n, p.slice(1), root), false, 'truncated proof');
  }
});

test('leaf and node hashes are domain-separated (a node cannot pose as a leaf)', () => {
  const L = leaves(2);
  const root = merkle.rootOf(L);
  const inner = Buffer.concat([merkle.leafHash(L[0]), merkle.leafHash(L[1])]);
  assert.equal(merkle.verifyInclusion(inner, 0, 1, [], root), false);
});

test('a batch of 1,500 readings needs an 11-hash proof (352 bytes), as estimated in Phase I', () => {
  const L = leaves(1500);
  const levels = merkle.buildLevels(L);
  const lengths = new Set([0, 700, 1499].map((i) => merkle.proofFromLevels(levels, i).length));
  assert.equal(Math.max(...lengths), 11);
  assert.equal(Math.max(...lengths) * 32, 352);
});

// ---------- records and signatures ----------
test('readings are validated and rounded', () => {
  assert.deepEqual(normaliseReading({ dev: 'sensor-01', t: 4.6249, h: 61.26 }), { dev: 'sensor-01', t: 4.62, h: 61.3 });
  assert.throws(() => normaliseReading({ dev: 'Sensor 1', t: 4, h: 50 }));
  assert.throws(() => normaliseReading({ dev: 'sensor-01', t: 400, h: 50 }));
  assert.throws(() => normaliseReading({ dev: 'sensor-01', t: 4, h: -1 }));
  assert.throws(() => normaliseReading({ dev: 'sensor-01', t: '4', h: 50 }));
});

test('record hash is pinned to a known value (catches accidental format changes)', () => {
  const r = makeRecord({ gw: 'gw-01', seq: 0, ts: 1761638400000, dev: 'sensor-01', t: 4.62, h: 61.2 });
  assert.equal(canonicalize(r), '{"dev":"sensor-01","gw":"gw-01","m":{"h":61.2,"t":4.62},"seq":0,"ts":1761638400000,"v":1}');
  assert.equal(toHex(recordHash(r)), toHex(sha256(Buffer.from(canonicalize(r)))));
  assert.equal(toHex(recordHash(r)), '0x4298ca705521fbf75889fa1509407133c4e82ed4370e1a69cdf80564cc4a4299');
});

test('changing any field changes the record hash', () => {
  const base = { gw: 'gw-01', seq: 9, ts: 1761638400000, dev: 'sensor-01', t: 4.62, h: 61.2 };
  const h0 = recordHash(makeRecord(base));
  for (const [k, v] of Object.entries({ gw: 'gw-02', seq: 10, ts: 1761638400001, dev: 'sensor-02', t: 4.63, h: 61.3 })) {
    assert.ok(!recordHash(makeRecord({ ...base, [k]: v })).equals(h0), k);
  }
});

test('ECDSA signature recovers the gateway address and fails for other contents or keys', () => {
  const gw = Wallet.createRandom();
  const other = Wallet.createRandom();
  const h = recordHash(makeRecord({ gw: 'gw-01', seq: 1, ts: 1, dev: 'sensor-01', t: 5, h: 60 }));
  const sig = signHash(gw.privateKey, h);
  assert.equal(signerOf(h, sig), gw.address);
  assert.notEqual(signerOf(sha256(h), sig), gw.address);
  assert.notEqual(signerOf(h, signHash(other.privateKey, h)), gw.address);
  assert.equal(signerOf(h, '0x1234'), null);
});

test('database row round-trips to the identical record', () => {
  const r = makeRecord({ gw: 'gw-01', seq: 3, ts: 1761638400123, dev: 'sensor-04', t: -1.25, h: 55 });
  const row = { gw: r.gw, seq: r.seq, ts: r.ts, dev: r.dev, temp: r.m.t, hum: r.m.h };
  assert.equal(canonicalize(recordFromRow(row)), canonicalize(r));
});

test('emulated sensors are reproducible for a given seed', () => {
  assert.deepEqual(new SensorFleet({ seed: 3 }).take(20), new SensorFleet({ seed: 3 }).take(20));
});
