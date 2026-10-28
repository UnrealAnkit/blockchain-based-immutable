'use strict';
const crypto = require('node:crypto');

/** SHA-256 of one or more byte buffers, concatenated. Returns a Buffer. */
function sha256(...parts) {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

const toHex = (buf) => '0x' + Buffer.from(buf).toString('hex');
const fromHex = (hex) => Buffer.from(hex.startsWith('0x') ? hex.slice(2) : hex, 'hex');

// ---- IPFS-compatible content identifiers (CIDv1, raw codec, sha2-256) ----
// CID bytes = <version 0x01><codec raw 0x55><multihash: sha2-256 0x12, length 0x20, digest>
// rendered in multibase base32 (prefix "b", RFC 4648 lower-case alphabet, no padding).
// A byte string stored with `ipfs add --raw-leaves --cid-version 1` gets this same CID,
// so this local store can be swapped for an IPFS node without changing identifiers.
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of str) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** CID of a byte string. */
function cidOf(bytes) {
  return cidFromDigest(sha256(bytes));
}

/** CID from a 32-byte SHA-256 digest (this is how the on-chain digest maps to a CID). */
function cidFromDigest(digest) {
  const d = Buffer.from(digest);
  if (d.length !== 32) throw new Error('digest must be 32 bytes');
  return 'b' + base32(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), d]));
}

/** The SHA-256 digest inside a CIDv1 raw/sha2-256 identifier. */
function digestFromCid(cid) {
  if (!cid.startsWith('b')) throw new Error('only base32 CIDv1 is supported');
  const bytes = base32Decode(cid.slice(1));
  if (bytes.length !== 36 || bytes[0] !== 0x01 || bytes[1] !== 0x55 || bytes[2] !== 0x12 || bytes[3] !== 0x20) {
    throw new Error('not a CIDv1 raw sha2-256 identifier');
  }
  return bytes.subarray(4);
}

module.exports = { sha256, toHex, fromHex, cidOf, cidFromDigest, digestFromCid };
