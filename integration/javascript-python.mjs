import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import KinopioHub from '../../KinopioHub.JS/src/node.mjs';
import { startManagedBroker, BROKER_VERSION } from '../../KinopioHub.JS/src/mesh-broker.mjs';

const pythonRoot = fileURLToPath(new URL('../../KinopioHub.py/', import.meta.url));
const python = process.env.KINOPIO_PYTHON ?? `${pythonRoot}.venv/${process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'}`;
const report = { server: BROKER_VERSION, transport: 'TCP', authentication: 'none', checks: [], versions: { node: process.version, pythonRuntime: execFileSync(python, ['--version'], { encoding: 'utf8' }).trim() } };
report.versions.javascript = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', 'import fs from "node:fs"; console.log(fs.readFileSync("package.json","utf8"))'], { cwd: fileURLToPath(new URL('../../KinopioHub.JS/', import.meta.url)) })).version;
report.versions.python = execFileSync(python, ['-c', 'import importlib.metadata; print(importlib.metadata.version("kinopio-hub"))'], { encoding: 'utf8' }).trim();
for (const [label, root] of [['javascript', new URL('../../KinopioHub.JS/', import.meta.url)], ['python', new URL('../../KinopioHub.py/', import.meta.url)]]) {
  report[`${label}Commit`] = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8' }).trim();
  report[`${label}Dirty`] = !!execFileSync('git', ['status', '--porcelain'], { cwd: fileURLToPath(root), encoding: 'utf8' }).trim();
}
function worker(options) {
  const child = spawn(python, [fileURLToPath(new URL('./python-worker.py', import.meta.url)), JSON.stringify(options)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, errors = '', exited = false;
  const pending = new Map();
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-8192); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const response = JSON.parse(line), entry = pending.get(response.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(response.id); response.error ? entry.reject(Error(`Python response: ${response.error}`)) : entry.resolve(response.result); }
    } catch (error) { errors += String(error); }
  });
  const ended = new Promise(resolve => child.once('close', (code, signal) => {
    exited = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error(`Python exited ${code ?? signal}: ${errors}`)); }
    pending.clear(); resolve();
  }));
  child.on('error', error => { errors += String(error); });
  child.stdin.on('error', error => { errors += String(error); });
  const call = (op, fields = {}) => new Promise((resolve, reject) => {
    if (exited) { reject(Error(`Python already exited: ${errors}`)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Python ${op} timeout: ${errors}`)); }, 65000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, op, ...fields }) + '\n');
  });
  return { call, async close() {
    if (exited) return;
    try { await Promise.race([call('close'), delay(3000)]); } catch {}
    child.stdin.end();
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await ended; clearTimeout(timer); lines.close();
  } };
}
async function until(check, label, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await delay(100); }
  throw Error(label);
}
function passed(label) { report.checks.push(label); console.log(`PASS ${label}`); }

let broker, js, py, late;
try {
  broker = await startManagedBroker({ host: '127.0.0.1' });
  const namespace = `interop-${randomUUID()}`;
  js = new KinopioHub({ namespace, servers: [broker.url], mesh: false, discovery: false, healthInterval: 200, peerTimeout: 100 });
  py = worker({ namespace, servers: [broker.url], mesh: false, discovery: false, health_interval: 0.2, peer_timeout: 0.1 });
  await Promise.all([js.connected(), py.call('connected')]);
  const variable = js.scope('devices').var('battery');
  const payload = { '10': 10, '2': 2, '汉字😀': [null, false, 0, 1e-7, 1.25, '🌍'], nested: { z: 2, a: 1 } };
  await variable.set(payload); await js.flush();
  await until(async () => JSON.stringify((await py.call('get')).meta.version) === JSON.stringify(variable.meta.version), 'Python did not observe JS version');
  assert.deepEqual((await py.call('get')).value, payload);
  passed('JS to Python: Unicode, JSON types and matching version');
  await py.call('set', { value: null });
  await until(() => variable.value === null, 'Python null did not reach JS');
  await Promise.all([variable.set('js'), py.call('set', { value: 'python' })]); await js.flush();
  await until(async () => {
    const value = await py.call('get');
    return value.value === variable.value && JSON.stringify(value.meta.version) === JSON.stringify(variable.meta.version);
  }, 'Concurrent writers did not converge');
  passed('Python to JS: null and concurrent writes converge');
  late = worker({ namespace, servers: [broker.url], mesh: false, discovery: false, peer_timeout: 0.1 });
  await late.call('connected');
  await until(async () => (await late.call('get')).value === variable.value, 'Late Python peer did not recover current state');
  await py.call('delete');
  await until(async () => variable.meta.exists === false && (await late.call('get')).meta.exists === false, 'Delete did not propagate');
  passed('Late join and deletion metadata propagate');
  await until(async () => (await js.instances.list()).some(row => row.sdk === 'python' && row.online === 'online') && (await py.call('instances')).some(row => row.sdk === 'javascript' && row.online === 'online'), 'Cross-language health missing');
  passed('Both languages observe each other in SDK health');
  await late.close(); late = null; await py.close(); py = null; await js.close(); js = null; await broker.close(); broker = null;

  const meshGroup = `mixed-${randomUUID()}`, meshNamespace = `mesh-${randomUUID()}`, token = `interop-${randomUUID()}`;
  // Start Python first to verify that Node can use a Python-owned broker.
  py = worker({ namespace: meshNamespace, token, mesh: { group: meshGroup }, discovery: false });
  const initial = await py.call('connected');
  assert.equal(initial.mesh.role, 'leader');
  js = new KinopioHub({ namespace: meshNamespace, token, mesh: { group: meshGroup }, discovery: false });
  await js.connected({ timeout: 30000 });
  await until(async () => {
    const status = await py.call('status');
    return status.mesh.members >= 2 && js.status().mesh.members >= 2 && status.mesh.leaderId === js.status().mesh.leaderId && [status.mesh.role, js.status().mesh.role].filter(role => role === 'leader').length === 1;
  }, 'Python and JS did not converge to one LAN node', 30000);
  const shared = await py.call('status');
  assert.equal(new URL(shared.server).port, new URL(js.status().server).port);
  report.mixedAuthentication = 'token plus HMAC control';
  report.mixedEvidence = { python: shared, javascript: js.status() };
  const mixed = js.scope('devices').var('battery');
  await mixed.set(42); await js.flush();
  await until(async () => (await py.call('get')).value === 42, 'Mixed election did not provide data routing');
  passed('Python and JS share one elected broker and current variables');
  await py.close(); py = null;
  await until(() => js.status().mesh.role === 'leader' && js.state === 'connected', 'JS did not take over the Python-owned node', 30000);
  assert.equal(mixed.value, 42);
  late = worker({ namespace: meshNamespace, token, mesh: { group: meshGroup }, discovery: false });
  await late.call('connected');
  await until(async () => (await late.call('get')).value === 42, 'New Python peer missed state after JS takeover');
  passed('JS takeover preserves RAM and serves a new Python peer');
  await js.close(); js = null;
  py = late; late = null;
  await until(async () => {
    const status = await py.call('status');
    return status.mesh.role === 'leader' && status.connection === 'connected';
  }, 'Python did not take over the JS-owned node', 30000);
  assert.equal((await py.call('get')).value, 42);
  js = new KinopioHub({ namespace: meshNamespace, token, mesh: { group: meshGroup }, discovery: false });
  await js.connected({ timeout: 30000 });
  const restored = js.scope('devices').var('battery');
  await until(() => restored.value === 42, 'New JS peer missed state after Python takeover');
  await until(async () => {
    const status = await py.call('status');
    return status.mesh.leaderId === js.status().mesh.leaderId && status.mesh.members >= 2 && js.status().mesh.members >= 2;
  }, 'Reverse takeover did not converge to one control group');
  assert.equal(new URL((await py.call('status')).server).port, new URL(js.status().server).port);
  passed('Python takeover preserves RAM and serves a new JS peer');
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally {
  const cleanup = await Promise.allSettled([late?.close(), py?.close(), js?.close(), broker?.close()]);
  const failures = cleanup.filter(item => item.status === 'rejected');
  if (failures.length) { report.passed = false; report.cleanupErrors = failures.map(item => String(item.reason)); process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
}
