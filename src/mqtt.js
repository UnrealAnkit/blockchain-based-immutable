'use strict';
/**
 * MQTT perception-layer transport.
 *
 * Sensors publish JSON readings {"t": <deg C>, "h": <%RH>} to iot/<device-id>/reading.
 * The gateway subscribes to iot/+/reading and ingests each message. An in-process
 * broker (Aedes) is provided so the prototype runs without installing Mosquitto;
 * any MQTT 3.1.1/5 broker works the same way.
 */
const net = require('node:net');
const mqtt = require('mqtt');

const TOPIC_FILTER = 'iot/+/reading';
const topicFor = (dev) => `iot/${dev}/reading`;

async function startBroker(port = 0) {
  const aedes = require('aedes')();
  const server = net.createServer(aedes.handle);
  await new Promise((res, rej) => server.listen(port, '127.0.0.1', res).on('error', rej));
  const actual = server.address().port;
  return {
    url: `mqtt://127.0.0.1:${actual}`,
    port: actual,
    close: () => new Promise((res) => aedes.close(() => server.close(() => res()))),
  };
}

/** Subscribe the gateway to sensor topics. Malformed messages are counted and dropped. */
async function attachGateway(gateway, url, { onReading = () => {}, onReject = () => {} } = {}) {
  const client = await mqtt.connectAsync(url, { clientId: `gateway-${gateway.label}`, clean: true });
  await client.subscribeAsync(TOPIC_FILTER, { qos: 1 });
  const stats = { received: 0, ingested: 0, rejected: 0 };
  client.on('message', (topic, payload) => {
    stats.received += 1;
    try {
      const dev = topic.split('/')[1];
      const body = JSON.parse(payload.toString('utf8'));
      const res = gateway.ingest({ dev, t: body.t, h: body.h });
      stats.ingested += 1;
      onReading(res);
    } catch (err) {
      stats.rejected += 1;
      onReject(topic, err);
    }
  });
  return { client, stats, close: () => client.endAsync() };
}

/** Emulated sensors: publish `fleet.next()` readings at `ratePerSec` in total. */
async function startPublishers(url, fleet, ratePerSec) {
  const client = await mqtt.connectAsync(url, { clientId: 'emulated-sensors' });
  const every = 1000 / ratePerSec;
  let sent = 0;
  const t0 = Date.now();
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const due = Math.floor((Date.now() - t0) / every);
    while (sent < due) {
      const r = fleet.next();
      client.publish(topicFor(r.dev), JSON.stringify({ t: Math.round(r.t * 100) / 100, h: Math.round(r.h * 10) / 10 }), { qos: 1 });
      sent += 1;
    }
    setTimeout(tick, Math.min(every, 100));
  };
  tick();
  return {
    get sent() {
      return sent;
    },
    stop: async () => {
      stopped = true;
      await client.endAsync();
    },
  };
}

module.exports = { startBroker, attachGateway, startPublishers, topicFor, TOPIC_FILTER };
