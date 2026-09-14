import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Hub from '../../KinopioHub.JS/src/node.mjs';
import { messagingBroker } from './messaging-broker.mjs';
import { arduinoPeer } from './messaging-arduino.mjs';

const report = { checks: [] }; let broker, device, hub;
function passed(label) { report.checks.push(label); console.log(`PASS ${label}`); }
async function until(check, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await delay(40); }
  throw Error(label);
}
try {
  broker = await messagingBroker(process.env.KINOPIO_TEST_HOST);
  const namespace = `esp-lifecycle-${randomUUID()}`;
  hub = new Hub(namespace, { servers: [broker.url], token: broker.token, tls: { ca: broker.ca, handshakeFirst: true }, mesh: false, discovery: false });
  await hub.connected();
  device = await arduinoPeer({ namespace, server: broker.url, token: broker.token, caCertificate: broker.ca, tlsFirst: true });
  const ownership = await device.call('ownership');
  for (const key of ['inputLinked', 'set', 'retained', 'independent', 'versionUnchanged']) assert.equal(ownership[key], true, key);
  await device.call('flush');
  await until(() => hub.var('ownership').value?.nested?.text === 'owned nested original', 'Owned snapshot was not transmitted');
  passed('Linked input survives source and getter mutation, including remote state');

  for (let index = 0; index < 16; index++) {
    await device.call('handle', {name: `slots.${index}`, key: `slot-${index}`, delay: 0.8});
  }
  assert.equal((await device.call('msg_status')).messaging.subscriptions, 16);
  await assert.rejects(device.call('handle', {name: 'slots.overflow', key: 'overflow'}), error => error.code === 'BUFFER_OVERFLOW');
  const simultaneous = Array.from({length: 16}, (_, index) => hub.var(`slots.${index}`).req(index));
  await until(async () => (await device.call('msg_status')).messaging.inFlightHandlers === 16, 'Sixteen deferred handlers were not admitted');
  assert.deepEqual(await Promise.all(simultaneous), Array.from({length: 16}, (_, index) => index));
  await device.call('snapshot', {clear: true});
  for (let index = 0; index < 16; index++) await device.call('unsubscribe', {key: `slot-${index}`});
  passed('Sixteen subscriptions admit simultaneous small deferred requests within bounded memory');

  const outstanding = [];
  await hub.var('slots.outgoing').handle(data => new Promise(resolve => outstanding.push(() => resolve(data))));
  // Separate subscriptions allow desktop handlers to hold four requests concurrently.
  for (let index = 1; index < 4; index++) {
    await hub.var(`slots.outgoing${index}`).handle(data => new Promise(resolve => outstanding.push(() => resolve(data))));
  }
  const requests = Array.from({length: 4}, (_, index) => device.call('msg_req', {
    name: index ? `slots.outgoing${index}` : 'slots.outgoing', key: `out-${index}`, data: index,
  }));
  await until(() => outstanding.length === 4, 'Four outgoing requests were not admitted');
  await assert.rejects(device.call('msg_req', {name: 'slots.extra', key: 'extra'}), error => error.code === 'BUFFER_OVERFLOW');
  for (const complete of outstanding) complete();
  assert.deepEqual(await Promise.all(requests), [0, 1, 2, 3]);
  passed('Four outgoing requests run concurrently and a fifth fails at the declared limit');

  await device.call('handle', { name: 'slow.work', key: 'slow', delay: 0.25 });
  const replies = Array.from({ length: 12 }, (_, id) => hub.var('slow.work').req(id, { timeout: 1100 }).then(data => ({ data }), error => ({ error: error.code })));
  await until(async () => (await device.call('msg_status', { key: 'slow' })).subscription.droppedMessages > 0, 'No bounded queue overflow was observed');
  const overloaded = await device.call('msg_status', { key: 'slow' });
  assert.ok(overloaded.subscription.pendingMessages <= 2);
  const results = await Promise.all(replies);
  assert.deepEqual(results.filter(row => !row.error).map(row => row.data), [0, 1]);
  assert.ok(results.filter(row => row.error).every(row => row.error === 'TIMEOUT'));
  await until(async () => {
    const row = await device.call('msg_status', { key: 'slow' });
    return row.subscription.pendingMessages === 0 && row.subscription.error === '';
  }, 'Slow subscription did not recover');
  assert.equal(await hub.var('slow.work').req('recovered'), 'recovered');
  report.overload = { dropped: overloaded.subscription.droppedMessages, accepted: results.filter(row => !row.error).length };
  passed('Bounded deferred-handler queue drops new work, preserves FIFO and recovers');

  let releaseReply;
  await hub.var('cancel.result').handle(() => new Promise(resolve => { releaseReply = resolve; }));
  const cancelled = device.call('msg_req', { name: 'cancel.result', key: 'cancel', timeoutMs: 5000 })
    .then(() => { throw Error('Cancelled request unexpectedly succeeded'); }, error => error);
  await until(() => releaseReply, 'Remote handler did not receive the request');
  assert.equal(await device.call('msg_cancel', { key: 'cancel' }), true);
  const cancellation = await cancelled;
  assert.equal(cancellation.code, 'CANCELLED');
  assert.equal((await device.call('msg_status')).messaging.pendingRequests, 0);
  releaseReply('late');
  await hub.var('next.result').handle(() => 'next');
  assert.equal((await device.call('request', { name: 'next.result' })).data, 'next');
  passed('Cancelling a single-response request releases its slot and isolates a late reply');

  for (let id = 0; id < 100; id++) {
    assert.equal(await device.call('set', { name: 'sensor', value: id }), true);
    await device.call('flush');
    await until(() => hub.var('sensor').value === id, 'Current sample missing');
  }
  await device.call('wifiDisconnect');
  await until(async () => !(await device.call('wifi')).connected, 'Wi-Fi did not disconnect');
  assert.equal(await device.call('set', { name: 'sensor', value: 'offline-current' }), true);
  await assert.rejects(device.call('request', { name: 'rpc.offline' }), error => error.code === 'DISCONNECTED');
  await device.call('wifiReconnect');
  await until(async () => (await device.call('connected')).connection === 'connected', 'Wi-Fi reconnect failed', 60000);
  await until(() => hub.var('sensor').value === 'offline-current', 'Offline current value did not merge');
  await until(async () => {
    const status = await device.call('connected');
    return status.pendingVariables === 0 && status.health === 'ok';
  }, 'Recovery left stale transport or pending warnings');
  await until(async () => {
    const status = (await device.call('msg_status', { key: 'slow' })).subscription;
    assert.equal(status.closed, false, 'Recovery permanently closed an established subscription');
    return status.ready;
  }, 'Message subscription did not become ready after Wi-Fi recovery');
  assert.equal(await hub.var('slow.work').req('after-wifi'), 'after-wifi');
  passed('100 current-value writes and Wi-Fi loss recover state, health and message interests');

  await device.call('snapshot', { clear: true });
  const running = hub.var('slow.work').req('draining');
  await until(async () => (await device.call('msg_status', { key: 'slow' })).subscription.inFlightHandlers === 1, 'Deferred handler did not start');
  const drained = device.call('drain');
  assert.equal(await running, 'draining'); await drained;
  assert.equal((await device.call('connected')).connection, 'closed');
  passed('Drain completes an admitted deferred reply before closing');
  report.resources = (await device.call('connected')).resources;
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally {
  if (device && !report.passed) report.diagnostics = await device.call('connected').catch(error => ({ error: error.message }));
  await device?.close(); await hub?.close(); await broker?.close();
  console.log(JSON.stringify(report, null, 2));
}
