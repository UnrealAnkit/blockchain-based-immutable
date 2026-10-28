'use strict';
/**
 * Merkle tree over SHA-256 in the RFC 6962 / RFC 9162 (Certificate Transparency) form.
 *
 *   leaf hash  = SHA-256(0x00 || leafData)
 *   node hash  = SHA-256(0x01 || left || right)
 *
 * The 0x00 / 0x01 prefixes keep a leaf from ever being passed off as an internal
 * node (second-preimage protection). An odd node at the end of a level is carried
 * up unchanged rather than duplicated, which avoids the duplicate-leaf ambiguity
 * of Bitcoin-style trees. Inclusion proofs are verified with the RFC 9162
 * section 2.1.3.2 algorithm, which also binds the proof to the leaf's position
 * and the tree size.
 */
const { sha256 } = require('./hash');

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

const leafHash = (data) => sha256(LEAF, data);
const nodeHash = (left, right) => sha256(NODE, left, right);

/** All levels of the tree, bottom (leaf hashes) to top (root). */
function buildLevels(leafData) {
  if (!leafData.length) throw new Error('cannot build a Merkle tree with no leaves');
  const levels = [leafData.map(leafHash)];
  while (levels.at(-1).length > 1) {
    const prev = levels.at(-1);
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? nodeHash(prev[i], prev[i + 1]) : prev[i]);
    }
    levels.push(next);
  }
  return levels;
}

const rootOf = (leafData) => buildLevels(leafData).at(-1)[0];

/** Inclusion proof (sibling hashes, bottom to top) for the leaf at `index`. */
function proofFromLevels(levels, index) {
  const size = levels[0].length;
  if (!Number.isInteger(index) || index < 0 || index >= size) throw new RangeError(`leaf index ${index} out of range`);
  const proof = [];
  let i = index;
  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const nodes = levels[lvl];
    const sib = i ^ 1;
    if (sib < nodes.length) proof.push(nodes[sib]);
    i >>= 1;
  }
  return proof;
}

const inclusionProof = (leafData, index) => proofFromLevels(buildLevels(leafData), index);

/**
 * Verify that `leafData` sits at `index` in a tree of `size` leaves whose root is `root`.
 * Returns false (never throws) for any malformed or non-matching input.
 */
function verifyInclusion(leafData, index, size, proof, root) {
  if (!Number.isInteger(index) || !Number.isInteger(size) || index < 0 || index >= size) return false;
  let fn = index;
  let sn = size - 1;
  let r = leafHash(leafData);
  for (const p of proof) {
    if (!Buffer.isBuffer(p) || p.length !== 32) return false;
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) {
        while (!((fn & 1) === 1 || fn === 0)) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return sn === 0 && Buffer.from(root).equals(r);
}

/** Reference implementation: the recursive MTH() definition from RFC 6962, used only by tests. */
function rootRecursive(leafData) {
  const n = leafData.length;
  if (n === 1) return leafHash(leafData[0]);
  let k = 1;
  while (k * 2 < n) k *= 2;
  return nodeHash(rootRecursive(leafData.slice(0, k)), rootRecursive(leafData.slice(k)));
}

module.exports = { leafHash, nodeHash, buildLevels, rootOf, proofFromLevels, inclusionProof, verifyInclusion, rootRecursive };
