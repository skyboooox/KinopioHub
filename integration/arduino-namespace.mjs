import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { serialWorker } from './arduino-worker.mjs';

const device = serialWorker();
const checks = [];
try {
  await delay(1500);
  await device.call('configure', { server: 'nats://127.0.0.1:4222' });
  const first = await device.call('status');
  assert.match(first.namespace, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first.namespace, first.instanceId);
  assert.equal(await device.call('set', { name: 'battery', value: 12 }), true);
  assert.equal((await device.call('status')).namespace, first.namespace);
  checks.push('Default UUID is stable and separate from instance identity');
  for (const name of ['', '\u0000', 'a\nb', '\u007f', 'a'.repeat(129), '界'.repeat(43)]) {
    assert.equal(await device.call('set', { name, value: 1 }), false);
  }
  assert.equal((await device.call('get', { name: 'battery' })).value, 12);
  checks.push('Invalid names preserve the accepted value');
  await device.call('configure', { server: 'nats://127.0.0.1:4222' });
  assert.notEqual((await device.call('status')).namespace, first.namespace);
  assert.equal((await device.call('get', { name: 'battery' })).exists, false);
  checks.push('A new default Hub rotates namespace and starts empty');
  await device.call('configure', { namespace: '空间.*.>', server: 'nats://127.0.0.1:4222' });
  assert.equal((await device.call('status')).namespace, '空间.*.>');
  checks.push('Explicit UTF-8 namespace is literal');
  console.log(JSON.stringify({ passed: true, checks }, null, 2));
} finally {
  try { await device.call('disconnect'); } finally { device.close(); }
}
