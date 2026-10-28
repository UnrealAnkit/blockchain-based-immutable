'use strict';
/**
 * The signed sensor record.
 *
 * A record is built at the gateway, never on the sensor:
 *   { v, gw, dev, seq, ts, m: { t, h } }
 *     v    format version (1)
 *     gw   gateway label
 *     dev  device id that produced the reading
 *     seq  gateway-wide monotonic sequence number (0, 1, 2, ...)
 *     ts   capture time at the gateway, Unix milliseconds
 *     m.t  temperature, degrees C (rounded to 0.01)
 *     m.h  relative humidity, % (rounded to 0.1)
 *
 * recordHash = SHA-256(canonical JSON of the record)  — this is the Merkle leaf data.
 * The gateway signs recordHash with its secp256k1 key (ECDSA); anyone can recover the
 * signer's address from the signature and compare it with the gateway registered on-chain.
 */
const { SigningKey, recoverAddress } = require('ethers');
const { canonicalize } = require('./canonical');
const { sha256, toHex } = require('./hash');

const RECORD_VERSION = 1;
const DEV_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

const round = (x, dp) => Math.round(x * 10 ** dp) / 10 ** dp;

/** Validate and normalise an incoming sensor reading. Throws on bad input. */
function normaliseReading(reading) {
  if (!reading || typeof reading !== 'object') throw new TypeError('reading must be an object');
  const { dev, t, h } = reading;
  if (typeof dev !== 'string' || !DEV_RE.test(dev)) throw new TypeError(`bad device id ${JSON.stringify(dev)}`);
  if (typeof t !== 'number' || !Number.isFinite(t) || t < -60 || t > 125) throw new RangeError(`temperature out of range: ${t}`);
  if (typeof h !== 'number' || !Number.isFinite(h) || h < 0 || h > 100) throw new RangeError(`humidity out of range: ${h}`);
  return { dev, t: round(t, 2), h: round(h, 1) };
}

function makeRecord({ gw, seq, ts, dev, t, h }) {
  return { v: RECORD_VERSION, gw, dev, seq, ts, m: { t, h } };
}

const recordBytes = (record) => Buffer.from(canonicalize(record), 'utf8');
const recordHash = (record) => sha256(recordBytes(record));

/** ECDSA (secp256k1) signature over the 32-byte record hash, as a 65-byte hex string. */
function signHash(privateKey, hash) {
  return new SigningKey(privateKey).sign(hash).serialized;
}

/** Address of the key that produced `sig` over `hash`, or null if the signature is malformed. */
function signerOf(hash, sig) {
  try {
    return recoverAddress(toHex(hash), sig);
  } catch {
    return null;
  }
}

/** Database row -> record. The verifier rebuilds every record from the stored columns. */
function recordFromRow(row) {
  return makeRecord({ gw: row.gw, seq: Number(row.seq), ts: Number(row.ts), dev: row.dev, t: row.temp, h: row.hum });
}

module.exports = { RECORD_VERSION, normaliseReading, makeRecord, recordBytes, recordHash, signHash, signerOf, recordFromRow };
