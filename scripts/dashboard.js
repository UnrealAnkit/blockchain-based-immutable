'use strict';
/**
 * Live system with dashboard:
 *   emulated sensors --MQTT--> gateway --> SQLite + batch objects --> chain (2 s blocks)
 *   http://localhost:3000  shows readings, batches, single-record verification, full audit
 *   and demo buttons that tamper with the database the way an insider could.
 *
 *   npm run dashboard
 *   npm run dashboard -- --broker mqtt://192.168.1.20:1883 --no-sensors   (real sensors, e.g. ESP32)
 *
 * Options: --port 3000  --batch 50  --interval 10  --block-time 2  --rate 5  --broker <url>  --no-sensors  --no-demo
 */
const path = require('node:path');
const { createSystem } = require('../src/system');
const { SensorFleet } = require('../src/sensors');
const { startBroker, attachGateway, startPublishers } = require('../src/mqtt');
const { createServer } = require('../src/server');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

(async () => {
  const port = Number(opt('port', process.env.PORT || 3000));
  const sys = await createSystem({
    dir: path.join(__dirname, '..', 'data', 'live'),
    batchSize: Number(opt('batch', 50)),
    batchIntervalMs: Number(opt('interval', 10)) * 1000,
    blockTime: Number(opt('block-time', 2)),
    quiet: false,
  });
  let broker = null;
  let brokerUrl = opt('broker', null);
  if (!brokerUrl) {
    try {
      broker = await startBroker(Number(process.env.MQTT_PORT || 1883));
    } catch {
      broker = await startBroker(0); // 1883 busy: take any free port
    }
    brokerUrl = broker.url;
  }
  const sub = await attachGateway(sys.gateway, brokerUrl, {
    onReject: (topic, err) => console.warn(`[gateway] rejected message on ${topic}: ${err.message}`),
  });
  sys.gateway.start();
  let pubs = null;
  if (!flag('no-sensors')) {
    const fleet = new SensorFleet({ devices: 5, seed: Date.now() & 0xffff, excursion: { dev: 'sensor-03', from: 40, to: 55, peak: 9.2 } });
    pubs = await startPublishers(brokerUrl, fleet, Number(opt('rate', 5)));
  }
  const server = createServer(sys, { allowDemoTamper: !flag('no-demo') });
  server.listen(port, () => {
    console.log(`\nDashboard      http://localhost:${port}`);
    console.log(`MQTT broker    ${brokerUrl}  (topic iot/<device-id>/reading, payload {"t":5.1,"h":61.2})`);
    console.log(`Contract       ${sys.contractAddress} on ${sys.chain.rpcUrl}`);
    console.log(`Gateway        ${sys.wallet.address}`);
    console.log('Ctrl+C to stop.\n');
  });

  const shutdown = async () => {
    server.close();
    if (pubs) await pubs.stop();
    await sub.close();
    await sys.gateway.flush();
    if (broker) await broker.close();
    await sys.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
