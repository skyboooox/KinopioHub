import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Hub from '../../KinopioHub.JS/src/node.mjs';
import { childPeer } from './messaging-peer.mjs';
import { sdkPeer } from './messaging-sdk-peer.mjs';
import { browserPeer } from './messaging-browser.mjs';
import { messagingBroker } from './messaging-broker.mjs';
import { messageConformance } from './message-conformance.mjs';
import { arduinoPeer } from './messaging-arduino.mjs';

const report = { checks: [], nativeTransport: 'TLS with certificate verification', browserTransport: 'loopback WebSocket', peers: [] };
const peers = new Map(); let broker;
const passed = label => { report.checks.push(label); console.log(`PASS ${label}`); };
async function until(check, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await check()) return; await delay(30); }
  throw Error(label);
}
try {
  broker = await messagingBroker(process.env.KINOPIO_TEST_HOST);
  report.brokerVersion = broker.version;
  const namespace = `matrix-${randomUUID()}`;
  const common = { namespace, servers: [broker.url], token: broker.token, mesh: false, discovery: false };
  const { namespace: _, ...nodeOptions } = common;
  peers.set('node', sdkPeer(new Hub(namespace, { ...nodeOptions, tls: { ca: broker.ca, handshakeFirst: true } })));
  const python = process.env.KINOPIO_PYTHON ?? fileURLToPath(new URL('../../KinopioHub.py/.venv/bin/python', import.meta.url));
  peers.set('python', childPeer(python, [fileURLToPath(new URL('./messaging-python.py', import.meta.url)), JSON.stringify({ ...common, tls: { ca_file: broker.caFile, handshake_first: true } })]));
  peers.set('browser', await browserPeer({ ...common, servers: [broker.websocketUrl] }));
  if (process.env.KINOPIO_CPP_WORKER) peers.set('cpp', childPeer(process.env.KINOPIO_CPP_WORKER, [JSON.stringify({ ...common, tls: { caFile: broker.caFile, handshakeFirst: true } })]));
  if (process.env.KINOPIO_SERIAL) peers.set('esp32', await arduinoPeer({ namespace, server: broker.url, token: broker.token, caCertificate: broker.ca, tlsFirst: true }));
  await Promise.all([...peers.values()].map(peer => peer.call('connected')));
  report.peers = [...peers.keys()];
  for (const name of ['python', 'cpp']) if (peers.has(name)) {
    report[`${name}EncodingChecks`] = await messageConformance(peers.get(name).call);
  }
  passed('Shared name vectors and verified TLS connection');

  for (const [name, peer] of peers) {
    await peer.call('subscribe', { name: name === 'esp32' ? `${name}.温度` : `${name}.*`, key: 'events' });
    await peer.call('handle', { name: `rpc.${name}`, key: 'rpc', ...(name === 'esp32' ? {} : { headers: { 'X-Test': ['  first  ', 'second'] } }) });
  }
  let eventPairs = 0, requestPairs = 0;
  for (const [senderName, sender] of peers) for (const [receiverName, receiver] of peers) {
    if (senderName === receiverName) continue;
    const data = { from: senderName, to: receiverName, value: [null, false, 0, '', '温度🌡️'] };
    await receiver.call('snapshot', { clear: true });
    await sender.call('publish', { name: `${receiverName}.温度`, data, ...(senderName === 'esp32' ? {} : { headers: { 'X-Test': ['  one  ', 'two'] } }) });
    let observed;
    await until(async () => { observed = (await receiver.call('snapshot')).received; return observed.length > 0; }, `${senderName} -> ${receiverName} event missing`);
    const devicePair = senderName === 'esp32' || receiverName === 'esp32';
    assert.deepEqual(observed, [{ data, topic: `${receiverName}.温度`, testHeaders: devicePair ? [] : ['one', 'two'] }]); eventPairs++;
    assert.deepEqual(await sender.call('request', { name: `rpc.${receiverName}`, data }), { data, testHeaders: devicePair ? [] : ['first', 'second'] }); requestPairs++;
  }
  report.eventPairs = eventPairs; report.requestPairs = requestPairs;
  passed(`${eventPairs} directed event pairs and ${requestPairs} directed request/reply pairs`);

  if (peers.has('esp32')) {
    const id = (await peers.get('esp32').call('connected')).instanceId;
    for (const [name, peer] of peers) if (name !== 'esp32') {
      let row;
      await until(async () => {
        row = (await peer.call('instances')).find(item => item.instanceId === id);
        return row?.online === 'online';
      }, `${name} did not observe the minimal ESP32 heartbeat`);
      assert.equal(row.sdk, 'arduino');
      assert.equal(row.namespace, namespace);
      assert.equal(row.messaging, undefined);
      assert.equal(row.sentBytes, undefined);
    }
    passed('Minimal ESP32 heartbeat is accepted by every desktop/browser observer');
  }

  for (const [name, peer] of peers) await peer.call('handle', { name: 'gather.all', key: 'gather', response: name });
  for (const [name, peer] of peers) {
    if (name !== 'esp32') {
      const result = await peer.call('request_many', { name: 'gather.all', maxReplies: peers.size, timeout: 3 });
      assert.deepEqual(result.data.sort(), [...peers.keys()].sort()); assert.equal(result.reason, 'maxReplies');
    }
    await assert.rejects(peer.call('request', { name: 'absent.service' }), error => error.code === 'NO_RESPONDERS');
    await assert.rejects(peer.call('publish', { name: 'invalid.*', data: 1 }), error => error.code === 'INVALID_TOPIC');
  }
  passed('Desktop/browser callers gather every responder; all SDKs reject invalid requests');

  const queuePeers = new Map([...peers].filter(([name]) => name !== 'esp32'));

  for (const [name, peer] of queuePeers) {
    await peer.call('snapshot', { clear: true });
    await peer.call('handle', { name: 'jobs.run', key: 'workers', queue: 'workers.队列', response: name });
  }
  for (let id = 0; id < 40; id++) {
    const caller = id % 2 === 1 && peers.has('esp32') ? peers.get('esp32') : peers.get('node');
    assert.ok(queuePeers.has((await caller.call('request', { name: 'jobs.run', data: id })).data));
  }
  const jobs = [];
  for (const peer of queuePeers.values()) jobs.push(...(await peer.call('snapshot')).handled.filter(row => row.name === 'jobs.run').map(row => row.data));
  assert.deepEqual(jobs.sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
  passed('Desktop/browser queue workers handle each observed request once, including ESP32 callers');
  if (peers.has('esp32')) {
    const device = peers.get('esp32');
    await assert.rejects(device.call('subscribe', {name: 'invalid.*', key: 'invalid'}), error => error.code === 'INVALID_TOPIC');
    report.esp32Capabilities = {events:'exact names', requests:'single response', gatherCaller:false, queueWorker:false, applicationHeaders:false};
  }
  if (peers.has('esp32')) report.esp32Resources = (await peers.get('esp32').call('snapshot')).status.resources;
  for (const peer of peers.values()) await peer.call('drain');
  passed('Every SDK drains and closes its own resources');
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally {
  const cleanup = await Promise.allSettled([...peers.values()].map(peer => peer.close()));
  if (broker) cleanup.push(await broker.close().then(() => ({ status: 'fulfilled' }), reason => ({ status: 'rejected', reason })));
  const failures = cleanup.filter(row => row.status === 'rejected');
  if (failures.length) { report.passed = false; report.cleanupErrors = failures.map(row => String(row.reason)); process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
}
