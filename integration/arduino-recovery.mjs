import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import KinopioHub from '../../KinopioHub.JS/src/node.mjs';
import { serialWorker, setTestClock } from './arduino-worker.mjs';

const serial = serialWorker();
const { call } = serial;
const namespace = `recovery-${randomUUID()}`;
const server = process.env.KINOPIO_SERVER ?? '';
const group = process.env.KINOPIO_GROUP ?? `recovery-${randomUUID()}`;
const token = process.env.KINOPIO_TOKEN ?? '';
const user = process.env.KINOPIO_USER ?? '';
const password = process.env.KINOPIO_PASSWORD ?? '';
const caCertificate = process.env.KINOPIO_CA_FILE ? readFileSync(process.env.KINOPIO_CA_FILE, 'utf8') : '';
const options = { healthInterval: 500, peerTimeout: 500,
  ...(token ? { token } : {}), ...(user ? { user, pass: password } : {}),
  ...(caCertificate ? { tls: { ca: caCertificate, handshakeFirst: true } } : {}),
  ...(server ? { servers: [server], mesh: false, discovery: false } : { mesh: { group } }),
};
const report = { checks: [], resources: {} };
const writes = Number(process.env.KINOPIO_TEST_WRITES ?? 500);
assert.ok(Number.isSafeInteger(writes) && writes > 0, 'KINOPIO_TEST_WRITES must be a positive integer');
const pass = label => { report.checks.push(label); console.log(`PASS ${label}`); };
async function until(check, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(100); }
  throw Error(label);
}
let js;
let stage = "startup", iteration = null, operation = null;
try {
  await delay(2000);
  js = new KinopioHub(namespace, options);
  await js.connected({ timeout: 60000 });
  // Filling all record slots also exercises batched late-join snapshot admission.
  for (let index = 0; index < 128; index++) await js.var(`v${index}`).set(index);
  await js.flush();
  if (server.startsWith('tls:')) await setTestClock(call);
  await call('configure', { namespace, server, group, token, user, password, caCertificate });
  await until(async () => (await call('status')).connection === 'connected', 'ESP32 not connected');
  await until(async () => (await call('status')).variables === 128, '128-record late snapshot missing');
  for (let index = 0; index < 128; index++) assert.equal((await call('get', { name: `v${index}` })).value, index);
  report.resources.snapshot = (await call('status')).resources;
  pass('128 small records arrive through late-join snapshot');
  const variable = js.var('v0');
  stage = "alternating updates";
  for (let index = 0; index < writes; index++) {
    iteration = index;
    operation = index % 2 ? "JS set/flush then ESP32 get" : "ESP32 set/flush then JS observe";
    if (index % 2) {
      await variable.set(index); await js.flush();
      await until(async () => (await call('get', { name: 'v0' })).value === index, 'JS update missing');
    } else {
      assert.equal(await call('set', { name: 'v0', value: index }), true);
      await call('flush');
      await until(() => variable.value === index, 'ESP32 update missing');
    }
    if ((index + 1) % 100 === 0) console.log(`PROGRESS ${index + 1}/${writes} alternating writes`);
  }
  stage = "post-update checks"; iteration = null; operation = null;
  const loaded = await call('status');
  assert.equal(loaded.variables, 128);
  assert.ok(loaded.resources.freeHeap > 32768);
  report.resources.updates = loaded.resources;
  pass(`${writes} alternating JS/ESP32 writes converge at full record capacity`);
  stage = 'WiFi recovery';
  await call('wifiDisconnect');
  await until(async () => !(await call('wifi')).connected, 'WiFi did not disconnect', 15000);
  assert.equal(await call('set', { name: 'v0', value: 'wifi-offline' }), true);
  assert.equal((await call('get', { name: 'v0' })).value, 'wifi-offline');
  await assert.rejects(call('flush', { timeoutMs: 50 }));
  await call('wifiReconnect');
  await until(async () => (await call('wifi')).connected, 'WiFi did not reconnect');
  await until(() => variable.value === 'wifi-offline', 'WiFi offline value did not merge');
  await until(async () => (await call('status')).pendingVariables === 0, 'WiFi replay did not finish');
  await until(async () => (await call('status')).health === 'ok', 'Transport failure did not clear after reconnect');
  pass('Actual WiFi loss retains RAM, reconnect merges state and clears transport warning');
  if (!server) {
    stage = "broker replacement";
    await js.close(); js = null;
    await until(async () => (await call('status')).connection !== 'connected', 'Old broker remained connected');
    assert.equal(await call('set', { name: 'v0', value: 'broker-replacement' }), true);
    js = new KinopioHub(namespace, options);
    await js.connected({ timeout: 60000 });
    const replacement = js.var('v0');
    await until(() => replacement.value === 'broker-replacement', 'Replacement broker did not recover ESP32 RAM', 90000);
    await until(async () => isDeepStrictEqual(replacement.meta.version, (await call('get', { name: 'v0' })).version), 'Replacement version mismatch');
    await until(() => Array.from({ length: 127 }, (_, index) => index + 1)
      .every(index => js.var(`v${index}`).value === index), 'Replacement snapshot is incomplete');
    pass('Broker termination and replacement discovery retain ESP32 state');
  }
  stage = 'persistent capacity warning';
  assert.equal(await call('set', { name: 'overflow', value: 1 }), false);
  await call('disconnect'); await call('reconnect');
  await until(async () => (await call('status')).connection === 'connected', 'Reconnect after capacity error failed');
  assert.equal((await call('status')).health, 'warning');
  pass('Persistent capacity failure remains visible after reconnect');
  report.resources.final = (await call('status')).resources;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const diagnostics = { stage, iteration, operation, message: error.message };
  // Observe once after failure; never retry the failed write or flush.
  for (const [name, op, fields] of [['status', 'status', {}], ['variable', 'get', { name: 'v0' }]]) {
    try { diagnostics[name] = await call(op, fields); }
    catch (failure) { diagnostics[name] = { diagnosticError: failure.message }; }
  }
  diagnostics.javascript = js ? { connection: js.status().connection, value: js.var('v0').value, meta: js.var('v0').meta } : null;
  console.error(JSON.stringify({ failure: diagnostics, completedChecks: report.checks }, null, 2));
  throw error;
} finally {
  await js?.close(); serial.close();
}
