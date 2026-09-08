import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import KinopioHub from '../../KinopioHub.JS/src/node.mjs';

const path = relative => fileURLToPath(new URL(relative, import.meta.url));
function worker(backend, options) {
  const child = backend === 'python'
    ? spawn(process.env.KINOPIO_PYTHON ?? path('../../KinopioHub.py/.venv/bin/python'), [path('./python-worker.py'), JSON.stringify(options)])
    : spawn(process.env.KINOPIO_CPP ?? path('../../KinopioHub.cpp/build-v3/kinopio_cpp_worker'), [JSON.stringify(options)]);
  const pending = new Map(); let sequence = 0;
  child.stderr.pipe(process.stderr);
  const lines = createInterface({ input: child.stdout });
  const rejectAll = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('error', rejectAll); child.on('exit', code => rejectAll(Error(`${backend} exited ${code}`)));
  lines.on('line', line => { let reply; try { reply = JSON.parse(line); } catch { return; } const item = pending.get(reply.id); if (item) { clearTimeout(item.timer); pending.delete(reply.id); reply.error ? item.reject(Error(reply.error)) : item.resolve(reply.result); } });
  function call(op) { return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(`${backend} ${op} timeout`)); }, 65000); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, op }) + '\n'); }); }
  return { call, async close() { try { await call('close'); } finally { child.stdin.end(); child.kill(); lines.close(); rejectAll(Error('Worker closed')); } } };
}
const digest = text => createHash('sha256').update(text).digest('hex');
for (const backend of ['javascript', 'python', 'cpp']) {
  const group = `client-discovery-${randomUUID()}`, token = randomUUID();
  const identity = JSON.stringify({ group, token, upstreams: [] });
  const domain = digest(identity), key = digest(`kinopio-mesh-control-v1:${identity}`);
  const sign = payload => ({ payload, signature: createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex') });
  const verify = message => message?.signature === sign(message.payload).signature && message.payload?.domain === domain;
  let hint, instance;
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (bytes, remote) => { try { const message = JSON.parse(bytes); if (verify(message) && message.payload.kind === 'hint') hint = { ...message.payload, address: remote.address }; } catch {} });
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(44480, '0.0.0.0', resolve); });
  for (const item of Object.values(os.networkInterfaces()).flat()) if (item?.family === 'IPv4') { try { udp.addMembership('239.255.42.100', item.address); } catch {} }
  try {
    const options = { namespace: group, token, mesh: { group }, discovery: false };
    instance = backend === 'javascript' ? new KinopioHub(options) : worker(backend, options);
    if (backend === 'javascript') await instance.connected({ timeout: 60000 }); else await instance.call('connected');
    const status = () => backend === 'javascript' ? instance.status() : instance.call('status');
    const before = (await status()).mesh.members;
    const deadline = Date.now() + 15000;
    while (!hint && Date.now() < deadline) await delay(100);
    assert.ok(hint, `${backend} signed multicast hint missing`);
    const post = envelope => fetch(`http://${hint.address}:${hint.port}/kinopio-mesh/v1`, { method: 'POST', body: JSON.stringify(envelope), signal: AbortSignal.timeout(3000) });
    const challenge = randomUUID();
    const request = sign({ protocol: 1, domain, kind: 'discover', challenge });
    const response = await post(request); assert.equal(response.status, 200);
    const envelope = await response.json(); assert.ok(verify(envelope));
    assert.equal(envelope.payload.kind, 'discovery'); assert.equal(envelope.payload.challenge, challenge);
    assert.ok(envelope.payload.member.broker.port > 0);
    assert.equal((await post({ ...request, signature: '0'.repeat(64) })).status, 403);
    assert.equal((await post(sign({ protocol: 1, domain, kind: 'discover', challenge: '' }))).status, 403);
    assert.equal((await status()).mesh.members, before);
    console.log(`PASS ${backend}: signed multicast/client discovery, broker, challenge/auth rejection, unchanged election membership`);
  } finally { await instance?.close(); udp.close(); }
}
