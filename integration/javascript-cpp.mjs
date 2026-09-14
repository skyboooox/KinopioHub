import { nameConformance } from './name-conformance.mjs';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import KinopioHub from '../../KinopioHub.JS/src/node.mjs';
import { startManagedBroker, BROKER_VERSION } from '../../KinopioHub.JS/src/mesh-broker.mjs';

const cppRoot = fileURLToPath(new URL('../../KinopioHub.cpp/', import.meta.url));
const cppBinary = process.env.KINOPIO_CPP ?? `${cppRoot}build-v3/kinopio_cpp_worker`;
const report = { server: BROKER_VERSION, transport: 'TCP', authentication: 'none', checks: [], versions: { node: process.version, cppRuntime: execFileSync(cppBinary, ['--version'], { encoding: 'utf8' }).trim() } };
report.versions.javascript = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', 'import fs from "node:fs"; console.log(fs.readFileSync("package.json","utf8"))'], { cwd: fileURLToPath(new URL('../../KinopioHub.JS/', import.meta.url)) })).version;
report.versions.cpp = report.versions.cppRuntime;
const pythonBinary = process.env.KINOPIO_PYTHON ?? fileURLToPath(new URL('../../KinopioHub.py/.venv/bin/python', import.meta.url));
report.versions.pythonRuntime = execFileSync(pythonBinary, ['--version'], { encoding: 'utf8' }).trim();
report.versions.python = execFileSync(pythonBinary, ['-c', 'import kinopio_hub; print(kinopio_hub.__version__)'], { encoding: 'utf8' }).trim();
for (const [label, root] of [['javascript', new URL('../../KinopioHub.JS/', import.meta.url)], ['cpp', new URL('../../KinopioHub.cpp/', import.meta.url)], ['python', new URL('../../KinopioHub.py/', import.meta.url)]]) {
  report[`${label}Commit`] = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(root), encoding: 'utf8' }).trim();
  report[`${label}Dirty`] = !!execFileSync('git', ['status', '--porcelain'], { cwd: fileURLToPath(root), encoding: 'utf8' }).trim();
}
function worker(options, backend = 'cpp') {
  const python = process.env.KINOPIO_PYTHON ?? fileURLToPath(new URL('../../KinopioHub.py/.venv/bin/python', import.meta.url));
  const command = backend === 'python' ? python : cppBinary;
  const args = backend === 'python' ? [fileURLToPath(new URL('./python-worker.py', import.meta.url)), JSON.stringify(options)] : [JSON.stringify(options)];
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let sequence = 0, errors = '', exited = false;
  const pending = new Map();
  child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-8192); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const response = JSON.parse(line), entry = pending.get(response.id);
      if (entry) { clearTimeout(entry.timer); pending.delete(response.id); response.error ? entry.reject(Error(`C++ response: ${response.error}`)) : entry.resolve(response.result); }
    } catch (error) { errors += String(error); }
  });
  const ended = new Promise(resolve => child.once('close', (code, signal) => {
    exited = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(Error(`C++ exited ${code ?? signal}: ${errors}`)); }
    pending.clear(); resolve();
  }));
  child.on('error', error => { errors += String(error); });
  child.stdin.on('error', error => { errors += String(error); });
  const call = (op, fields = {}) => new Promise((resolve, reject) => {
    if (exited) { reject(Error(`C++ already exited: ${errors}`)); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`C++ ${op} timeout: ${errors}`)); }, 65000);
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

let broker, js, py, late, third;
try {
  broker = await startManagedBroker({ host: '127.0.0.1' });
  const namespace = `interop-${randomUUID()}`;
  js = new KinopioHub(namespace, { servers: [broker.url], mesh: false, discovery: false, healthInterval: 200, peerTimeout: 100 });
  py = worker({ namespace, servers: [broker.url], mesh: false, discovery: false, healthInterval: 200, peerTimeout: 100 });
  await Promise.all([js.connected(), py.call('connected')]);
  report.encodingVectors = await nameConformance(js, py.call);
  passed('Shared UTF-8 vectors round-trip with literal names');
  const variable = js.var('battery');
  const payload = { '10': 10, '2': 2, '汉字😀': [null, false, 0, 1e-7, 1.25, '🌍'], nested: { z: 2, a: 1 } };
  await variable.set(payload); await js.flush();
  await until(async () => JSON.stringify((await py.call('get')).meta.version) === JSON.stringify(variable.meta.version), 'C++ did not observe JS version');
  assert.deepEqual((await py.call('get')).value, payload);
  passed('JS to C++: Unicode, JSON types and matching version');
  await py.call('set', { value: null });
  await until(() => variable.value === null, 'C++ null did not reach JS');
  await Promise.all([variable.set('js'), py.call('set', { value: 'python' })]); await js.flush();
  await until(async () => {
    const value = await py.call('get');
    return value.value === variable.value && JSON.stringify(value.meta.version) === JSON.stringify(variable.meta.version);
  }, 'Concurrent writers did not converge');
  passed('C++ to JS: null and concurrent writes converge');
  late = worker({ namespace, servers: [broker.url], mesh: false, discovery: false, peerTimeout: 100 });
  await late.call('connected');
  await until(async () => (await late.call('get')).value === variable.value, 'Late C++ peer did not recover current state');
  await py.call('delete');
  await until(async () => variable.meta.exists === false && (await late.call('get')).meta.exists === false, 'Delete did not propagate');
  passed('Late join and deletion metadata propagate');
  await until(async () => (await js.instances.list()).some(row => row.sdk === 'cpp' && row.online === 'online') && (await py.call('instances')).some(row => row.sdk === 'javascript' && row.online === 'online'), 'Cross-language health missing');
  passed('Both languages observe each other in SDK health');
  await late.close(); late = null; await py.close(); py = null; await js.close(); js = null; await broker.close(); broker = null;

  const meshGroup = `mixed-${randomUUID()}`, meshNamespace = `mesh-${randomUUID()}`, token = `interop-${randomUUID()}`;
  // Start C++ first to verify that Node can use a C++-owned broker.
  py = worker({ namespace: meshNamespace, token, mesh: { group: meshGroup }, discovery: false });
  const initial = await py.call('connected');
  assert.equal(initial.mesh.role, 'leader');
  js = new KinopioHub(meshNamespace, { token, mesh: { group: meshGroup }, discovery: false });
  await js.connected({ timeout: 30000 });
  await until(async () => {
    const status = await py.call('status');
    return status.mesh.members >= 2 && js.status().mesh.members >= 2 && status.mesh.leaderId === js.status().mesh.leaderId && [status.mesh.role, js.status().mesh.role].filter(role => role === 'leader').length === 1;
  }, 'C++ and JS did not converge to one LAN node', 30000);
  const shared = await py.call('status');
  assert.equal(new URL(shared.server).port, new URL(js.status().server).port);
  report.mixedAuthentication = 'token plus HMAC control';
  report.mixedEvidence = { cpp: shared, javascript: js.status() };
  const mixed = js.var('battery');
  await mixed.set(42); await js.flush();
  await until(async () => (await py.call('get')).value === 42, 'Mixed election did not provide data routing');
  passed('C++ and JS share one elected broker and current variables');
  third = worker({ namespace: meshNamespace, token, mesh: { group: meshGroup }, discovery: false }, 'python');
  await third.call('connected');
  await until(async () => {
    const [cpp, python] = await Promise.all([py.call('status'), third.call('status')]);
    return cpp.mesh.members === 3 && python.mesh.members === 3 && js.status().mesh.members === 3
      && cpp.mesh.leaderId === python.mesh.leaderId && cpp.mesh.leaderId === js.status().mesh.leaderId;
  }, 'Three languages did not share one election group', 30000);
  await until(async () => (await third.call('get')).value === 42, 'Python missed mixed-language current value');
  await third.call('set', { value: { source: 'python', reading: 43 } });
  await until(async () => (await py.call('get')).value?.reading === 43 && mixed.value?.reading === 43, 'Python write did not reach C++ and JS');
  report.threeLanguageEvidence = { cpp: await py.call('status'), python: await third.call('status'), javascript: js.status() };
  await third.close(); third = null;
  await mixed.set(42); await js.flush();
  await until(async () => (await py.call('get')).value === 42, 'C++ missed value before takeover');
  passed('C++, Python and JS share one node and exchange values');
  await py.close(); py = null;
  await until(() => js.status().mesh.role === 'leader' && js.state === 'connected', 'JS did not take over the C++-owned node', 30000);
  assert.equal(mixed.value, 42);
  late = worker({ namespace: meshNamespace, token, mesh: { group: meshGroup }, discovery: false });
  await late.call('connected');
  await until(async () => (await late.call('get')).value === 42, 'New C++ peer missed state after JS takeover');
  passed('JS takeover preserves RAM and serves a new C++ peer');
  await js.close(); js = null;
  py = late; late = null;
  await until(async () => {
    const status = await py.call('status');
    return status.mesh.role === 'leader' && status.connection === 'connected';
  }, 'C++ did not take over the JS-owned node', 30000);
  assert.equal((await py.call('get')).value, 42);
  js = new KinopioHub(meshNamespace, { token, mesh: { group: meshGroup }, discovery: false });
  await js.connected({ timeout: 30000 });
  const restored = js.var('battery');
  await until(() => restored.value === 42, 'New JS peer missed state after C++ takeover');
  await until(async () => {
    const status = await py.call('status');
    return status.mesh.leaderId === js.status().mesh.leaderId && status.mesh.members >= 2 && js.status().mesh.members >= 2;
  }, 'Reverse takeover did not converge to one control group');
  assert.equal(new URL((await py.call('status')).server).port, new URL(js.status().server).port);
  passed('C++ takeover preserves RAM and serves a new JS peer');
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally {
  const cleanup = await Promise.allSettled([third?.close(), late?.close(), py?.close(), js?.close(), broker?.close()]);
  const failures = cleanup.filter(item => item.status === 'rejected');
  if (failures.length) { report.passed = false; report.cleanupErrors = failures.map(item => String(item.reason)); process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
}
