'use strict';
/**
 * Canonical JSON (RFC 8785, JSON Canonicalization Scheme).
 *
 * The gateway hashes this exact byte string and the verifier recomputes it,
 * so both sides must produce identical bytes for identical data:
 *   - object keys sorted by UTF-16 code units (JS default string order),
 *   - no whitespace,
 *   - numbers in ECMAScript shortest round-trip form (what JSON.stringify gives),
 *   - strings escaped as JSON.stringify escapes them.
 * Non-finite numbers, undefined, functions and symbols are rejected rather
 * than silently dropped, because a dropped field would change the hash.
 */
function canonicalize(value) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonical JSON: non-finite number ${value}`);
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
      const keys = Object.keys(value).sort();
      const parts = [];
      for (const k of keys) {
        const v = value[k];
        if (v === undefined) throw new TypeError(`canonical JSON: undefined value at key "${k}"`);
        parts.push(JSON.stringify(k) + ':' + canonicalize(v));
      }
      return '{' + parts.join(',') + '}';
    }
    default:
      throw new TypeError(`canonical JSON: unsupported type ${typeof value}`);
  }
}

module.exports = { canonicalize };
