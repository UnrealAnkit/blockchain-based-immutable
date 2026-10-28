'use strict';
/**
 * Blockchain access: compile the contracts, start (or connect to) a chain, deploy.
 *
 * By default an embedded Ethereum development chain (Ganache) is started on a free
 * localhost port and reached over JSON-RPC, exactly as a real node would be.
 * Set CHAIN_RPC (and DEPLOYER_KEY, a funded key) to use any other EVM chain instead,
 * e.g. a Hardhat/Anvil node, a permissioned Besu network, or a public testnet.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { JsonRpcProvider, Wallet, ContractFactory, Contract, parseEther } = require('ethers');

const ROOT = path.join(__dirname, '..');
const CONTRACTS_DIR = path.join(ROOT, 'contracts');
const BUILD_DIR = path.join(ROOT, 'build');
const EVM_VERSION = 'shanghai'; // Ganache 7 does not implement Cancun opcodes

/** Compile every .sol file in contracts/ with solc-js; cached in build/ by source hash. */
function compileContracts() {
  const files = fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith('.sol')).sort();
  const sources = {};
  for (const f of files) sources[f] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, f), 'utf8') };
  const key = crypto.createHash('sha256').update(JSON.stringify(sources) + EVM_VERSION).digest('hex').slice(0, 16);
  const cacheFile = path.join(BUILD_DIR, `artifacts-${key}.json`);
  if (fs.existsSync(cacheFile)) return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

  const solc = require('solc');
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: EVM_VERSION,
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error('Solidity compile failed:\n' + errors.map((e) => e.formattedMessage).join('\n'));
  const artifacts = { solcVersion: solc.version(), evmVersion: EVM_VERSION };
  for (const file of Object.keys(output.contracts)) {
    for (const [name, c] of Object.entries(output.contracts[file])) {
      artifacts[name] = { abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
    }
  }
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(artifacts));
  return artifacts;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Ganache prints a native-module notice on load; keep the console clean. */
function requireGanacheQuietly() {
  const saved = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return require('ganache');
  } finally {
    Object.assign(console, saved);
  }
}

/**
 * Start a chain and return { provider, deployer, rpcUrl, chainId, info, stop }.
 * @param {object} opts
 * @param {number} [opts.blockTime=0] seconds between blocks; 0 = mine each transaction at once
 */
async function startChain({ blockTime = 0, pollingInterval = 50 } = {}) {
  if (process.env.CHAIN_RPC) {
    if (!process.env.DEPLOYER_KEY) throw new Error('CHAIN_RPC is set but DEPLOYER_KEY is not');
    const provider = new JsonRpcProvider(process.env.CHAIN_RPC, undefined, { pollingInterval });
    const deployer = new Wallet(process.env.DEPLOYER_KEY, provider);
    const { chainId } = await provider.getNetwork();
    return {
      provider,
      deployer,
      rpcUrl: process.env.CHAIN_RPC,
      chainId: Number(chainId),
      info: { kind: 'external', rpc: process.env.CHAIN_RPC },
      stop: async () => provider.destroy(),
    };
  }

  const ganache = requireGanacheQuietly();
  const port = await freePort();
  const options = {
    logging: { quiet: true },
    chain: { hardfork: 'shanghai', chainId: 1337 },
    wallet: { deterministic: true, totalAccounts: 4, defaultBalance: 10000 },
    miner: blockTime > 0 ? { blockTime } : { instamine: 'eager' },
  };
  const server = ganache.server(options);
  await server.listen(port, '127.0.0.1');
  const accounts = await server.provider.getInitialAccounts();
  const deployerKey = Object.values(accounts)[0].secretKey;
  const rpcUrl = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(rpcUrl, 1337, { staticNetwork: true, pollingInterval, cacheTimeout: -1 });
  const deployer = new Wallet(deployerKey, provider);
  return {
    provider,
    deployer,
    rpcUrl,
    chainId: 1337,
    info: { kind: 'ganache', version: require('ganache/package.json').version, hardfork: 'shanghai', blockTime },
    stop: async () => {
      provider.destroy();
      await server.close();
    },
  };
}

/** Deploy a fresh IoTAnchor, register the gateway and fund its account for gas. */
async function deployAnchor(chain, gatewayAddress, { fundEth = '10' } = {}) {
  const art = compileContracts();
  const factory = new ContractFactory(art.IoTAnchor.abi, art.IoTAnchor.bytecode, chain.deployer);
  const contract = await factory.deploy();
  const deployTx = contract.deploymentTransaction();
  const deployReceipt = await deployTx.wait();
  await (await contract.setGateway(gatewayAddress, true)).wait();
  if (fundEth && chain.info.kind === 'ganache') {
    await (await chain.deployer.sendTransaction({ to: gatewayAddress, value: parseEther(fundEth) })).wait();
  }
  return { contract, address: await contract.getAddress(), deployGas: Number(deployReceipt.gasUsed) };
}

async function deployBaseline(chain) {
  const art = compileContracts();
  const factory = new ContractFactory(art.PerRecordBaseline.abi, art.PerRecordBaseline.bytecode, chain.deployer);
  const contract = await factory.deploy();
  await contract.deploymentTransaction().wait();
  return contract;
}

/** Read-only handle to an already-deployed IoTAnchor (what an auditor uses). */
function anchorAt(address, runner) {
  return new Contract(address, compileContracts().IoTAnchor.abi, runner);
}

/** Poll for a receipt every `everyMs`; resolves with the receipt (status may be 0). */
async function waitReceipt(provider, txHash, { everyMs = 25, timeoutMs = 120000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const r = await provider.getTransactionReceipt(txHash);
    if (r) return r;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${txHash}`);
    await new Promise((res) => setTimeout(res, everyMs));
  }
}

module.exports = { compileContracts, startChain, deployAnchor, deployBaseline, anchorAt, waitReceipt };
