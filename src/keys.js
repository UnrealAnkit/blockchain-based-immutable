'use strict';
/**
 * Gateway key management.
 *
 * The gateway has one secp256k1 key. It signs every record and it is the account
 * that sends anchoring transactions, so the address registered in the contract is
 * the single identity an auditor checks against.
 *
 * Storage:
 *   - If GATEWAY_KEY_PASSWORD is set, the key is kept as an encrypted Ethereum
 *     keystore (scrypt + AES-128-CTR, the standard "UTC JSON" format).
 *   - Otherwise it is kept in plain JSON. Either way the file is created with
 *     mode 0600 (owner read/write only) and a warning is printed for plain keys.
 * Rotation: generate a new key, register it with setGateway(new, true), then
 * setGateway(old, false). Records signed by the old key stay verifiable because
 * their batches were anchored under the old address.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Wallet } = require('ethers');

function loadOrCreateGatewayKey(file, { password = process.env.GATEWAY_KEY_PASSWORD, quiet = false } = {}) {
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    const json = JSON.parse(raw);
    if (json.crypto || json.Crypto) {
      if (!password) throw new Error(`${file} is encrypted; set GATEWAY_KEY_PASSWORD`);
      return Wallet.fromEncryptedJsonSync(raw, password);
    }
    return new Wallet(json.privateKey);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const wallet = Wallet.createRandom();
  const body = password
    ? wallet.encryptSync(password)
    : JSON.stringify({ address: wallet.address, privateKey: wallet.privateKey }, null, 2);
  fs.writeFileSync(file, body, { mode: 0o600 });
  if (!password && !quiet) {
    console.warn(`[keys] created a PLAIN gateway key at ${file} (mode 0600). Set GATEWAY_KEY_PASSWORD to encrypt it.`);
  }
  return new Wallet(wallet.privateKey);
}

module.exports = { loadOrCreateGatewayKey };
