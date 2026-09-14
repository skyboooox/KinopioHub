import { nameConformance } from './name-conformance.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { serialWorker, setTestClock } from './arduino-worker.mjs';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import KinopioHub from '../../KinopioHub.JS/src/node.mjs';

const serial = serialWorker();
const { call } = serial;
async function until(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw Error(label);
}
const report = { transport: 'ESP32 serial / NATS', checks: [] };
function pass(label) { report.checks.push(label); console.log(`PASS ${label}`); }
const namespace = `arduino-${randomUUID()}`;
const server = process.env.KINOPIO_SERVER ?? '';
const token = process.env.KINOPIO_TOKEN ?? '';
const caCertificate = process.env.KINOPIO_CA_FILE ? readFileSync(process.env.KINOPIO_CA_FILE, 'utf8') : '';
const user = process.env.KINOPIO_USER ?? '';
const password = process.env.KINOPIO_PASSWORD ?? '';
const credentials = { token, user, password, caCertificate };
const group = process.env.KINOPIO_GROUP ?? 'default';
const options = { ...(token ? { token } : {}), ...(user ? { user, pass: password } : {}), ...(caCertificate ? { tls: { ca: caCertificate, handshakeFirst: true } } : {}), healthInterval: 500, peerTimeout: 500, ...(server ? { servers: [server], mesh: false, discovery: false } : { mesh: { group } }) };
let js;
try {
  await delay(2000);
  js = new KinopioHub(namespace, options);
  await js.connected({ timeout: 60000 });
  const variable = js.var('battery');
  report.initialResources = (await call('wifi')).resources;
  const payload = { '汉字😀': [null, false, 0, 1e-7, 1.2345678901234567, 5e-324, 2.2250738585072014e-308, '🌍'], nested: { a: 1, z: 2 } };
  await variable.set(payload); await js.flush();
  if (server.startsWith('tls:')) await setTestClock(call);
  await call('configure', { namespace, server, ...credentials, group });
  await until(async () => (await call('status')).connection === 'connected', 'ESP32 did not connect', 60000);
  await until(async () => JSON.stringify((await call('get')).version) === JSON.stringify(variable.meta.version), 'Late ESP32 snapshot/version missing');
  assert.deepEqual((await call('get')).value, payload);
  pass('Late ESP32 snapshot: JS JSON, Unicode and identical version');
  assert.equal(await call('set', { value: null }), true); await call('flush');
  await until(() => variable.meta.exists === true && variable.value === null, 'Present null missing');
  pass('ESP32 to JS: present JSON null');
  assert.equal(await call('set', { value: payload }), true); await call('flush');
  await until(() => isDeepStrictEqual(variable.value, payload), 'ESP32 JSON missing');
  assert.deepEqual(variable.value, payload);
  await call('delete'); await call('flush');
  await until(() => variable.meta.exists === false, 'ESP32 deletion missing');
  await variable.set('delete-from-js'); await js.flush();
  await until(async () => (await call('get')).value === 'delete-from-js', 'JS write missing');
  await variable.delete(); await js.flush();
  await until(async () => (await call('get')).exists === false, 'JS deletion missing');
  pass('Bidirectional JSON and deletion');
  await call('disconnect');
  assert.equal(await call('set', { value: 'offline-esp32' }), true);
  await variable.set('offline-js');
  const offline = await call('get');
  assert.equal(offline.version.counter, variable.meta.version.counter);
  const expected = offline.version.writer > variable.meta.version.writer ? 'offline-esp32' : 'offline-js';
  assert.equal((await call('get')).value, 'offline-esp32');
  await call('reconnect');
  await until(async () => variable.value === expected && isDeepStrictEqual(variable.meta.version, (await call('get')).version), 'Disconnected RAM update did not merge', 60000);
  pass('Concurrent offline equal-clock writes converge by writer ordering');
  await until(async () => (await js.instances.list()).some(row => row.sdk === 'arduino' && row.online === 'online'), 'ESP32 SDK health report missing');
  pass('JS observes ESP32 SDK health');
  report.encodingVectors = await nameConformance(js, call);
  pass('Shared UTF-8 vectors round-trip with literal ESP32 names');
  report.connectedResources = (await call('status')).resources;
  if (!server) pass('ESP32 discovers LAN broker as client');
  await js.close(); js = null;
  await call('reboot'); await delay(5000);
  if (server.startsWith('tls:')) await setTestClock(call);
  await call('configure', { namespace, server, ...credentials, group });
  const fresh = await call('get');
  assert.notEqual(fresh.exists, true);
  assert.equal(fresh.value, null);
  pass('Reboot without online SDK peers starts empty');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await js?.close();
  serial.close();
}
