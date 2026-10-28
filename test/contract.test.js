'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Wallet } = require('ethers');
const { startChain, deployAnchor } = require('../src/chain');

const H = (byte) => '0x' + byte.repeat(32);

test('IoTAnchor contract', async (t) => {
  const chain = await startChain();
  const gw = new Wallet(Wallet.createRandom().privateKey, chain.provider);
  const intruder = new Wallet(Wallet.createRandom().privateKey, chain.provider);
  await (await chain.deployer.sendTransaction({ to: intruder.address, value: 10n ** 18n })).wait();
  const { contract } = await deployAnchor(chain, gw.address);
  const asGw = contract.connect(gw);
  t.after(() => chain.stop());

  await t.test('only a registered gateway can anchor', async () => {
    await assert.rejects(contract.connect(intruder).anchorBatch.staticCall(H('11'), H('22'), 0, 63), /NotGateway/);
  });

  await t.test('only the owner can register gateways', async () => {
    await assert.rejects(contract.connect(intruder).setGateway.staticCall(intruder.address, true), /NotOwner/);
  });

  await t.test('first batch must start at sequence 0', async () => {
    await assert.rejects(asGw.anchorBatch.staticCall(H('11'), H('22'), 5, 63), /SequenceGap/);
  });

  await t.test('a reversed range is refused', async () => {
    await assert.rejects(asGw.anchorBatch.staticCall(H('11'), H('22'), 10, 0), /BadRange/);
  });

  await t.test('consecutive batches are stored and emit events', async () => {
    const r1 = await (await asGw.anchorBatch(H('aa'), H('bb'), 0, 63)).wait();
    const r2 = await (await asGw.anchorBatch(H('cc'), H('dd'), 64, 99)).wait();
    assert.equal(r1.status, 1);
    assert.equal(r2.status, 1);
    const ev = contract.interface.parseLog(r2.logs[0]);
    assert.equal(ev.name, 'BatchAnchored');
    assert.equal(ev.args.batchNo, 1n);
    assert.equal(await contract.batchCount(gw.address), 2n);
    assert.equal(await contract.nextSeq(gw.address), 100n);
    const b = await contract.getBatch(gw.address, 1);
    assert.equal(b.root, H('cc'));
    assert.equal(b.manifestDigest, H('dd'));
    assert.ok(Number(r2.gasUsed) < 120000, `steady-state anchor gas ${r2.gasUsed}`);
  });

  await t.test('a gap or overlap in sequence numbers is refused', async () => {
    await assert.rejects(asGw.anchorBatch.staticCall(H('ee'), H('ff'), 101, 120), /SequenceGap/);
    await assert.rejects(asGw.anchorBatch.staticCall(H('ee'), H('ff'), 64, 120), /SequenceGap/);
  });

  await t.test('findBatch locates the covering batch by binary search', async () => {
    for (let i = 0; i < 6; i++) {
      const first = 100 + i * 10;
      await (await asGw.anchorBatch(H('0' + i), H('1' + i), first, first + 9)).wait();
    }
    const cases = [[0, 0], [63, 0], [64, 1], [99, 1], [100, 2], [125, 4], [159, 7]];
    for (const [seq, batchNo] of cases) {
      const r = await contract.findBatch(gw.address, seq);
      assert.equal(r.found, true, `seq ${seq}`);
      assert.equal(Number(r.batchNo), batchNo, `seq ${seq}`);
    }
    assert.equal((await contract.findBatch(gw.address, 160)).found, false);
    assert.equal((await contract.findBatch(intruder.address, 5)).found, false);
  });

  await t.test('a deactivated gateway can no longer anchor', async () => {
    await (await contract.setGateway(gw.address, false)).wait();
    await assert.rejects(asGw.anchorBatch.staticCall(H('11'), H('22'), 160, 170), /NotGateway/);
  });
});
