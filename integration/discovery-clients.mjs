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
  const pending = new Map(); let sequence = 0, exited = false;
  const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve(); }));
  child.stderr.pipe(process.stderr);
  const lines = createInterface({ input: child.stdout });
  const rejectAll = error => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on('error', rejectAll); child.stdin.on('error', rejectAll); child.on('exit', code => rejectAll(Error(`${backend} exited ${code}`)));
  lines.on('line', line => { let reply; try { reply = JSON.parse(line); } catch { return; } const item = pending.get(reply.id); if (item) { clearTimeout(item.timer); pending.delete(reply.id); reply.error ? item.reject(Error(reply.error)) : item.resolve(reply.result); } });
  function call(op, timeout = 65000) {
    if (exited || child.exitCode !== null || child.signalCode !== null) return Promise.reject(Error(`${backend} already exited`));
    return new Promise((resolve, reject) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(Error(`${backend} ${op} timeout`)); }, timeout); pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, op }) + '\n'); });
  }
  return { call, async close() {
    try { if (!exited) await call('close', 5000); }
    finally {
      child.stdin.end();
      if (!exited) child.kill();
      await Promise.race([closed, delay(2000, undefined, { ref: false })]);
      if (!exited) { child.kill('SIGKILL'); await closed; }
      lines.close(); rejectAll(Error('Worker closed'));
    }
  } };

}
const digest = text => createHash('sha256').update(text).digest('hex');
for (const backend of ['javascript', 'python', 'cpp']) {
  const group = `client-discovery-${randomUUID()}`, token = randomUUID();
  const identity = JSON.stringify({ group, token, upstreams: [] });
  const domain = digest(identity), key = digest(`kinopio-mesh-control-v1:${identity}`);
  const sign = payload => ({ payload, signature: createHmac('sha256', key).update(JSON.stringify(payload)).digest('hex') });
  const verify = message => message?.signature === sign(message.payload).signature && message.payload?.domain === domain;
  const hints = new Map(); let instance;
  const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  udp.on('message', (bytes, remote) => {
    try {
      const message = JSON.parse(bytes);
      if (verify(message) && message.payload.protocol === 4 && message.payload.kind === 'hint' && Number.isInteger(message.payload.port) && message.payload.port > 0 && message.payload.port <= 65535) {
        const hint = { ...message.payload, address: remote.address };
        if (hints.size < 32) hints.set(`${hint.address}:${hint.port}`, hint);
      }
    } catch {}
  });
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(44480, '0.0.0.0', resolve); });
  for (const item of Object.values(os.networkInterfaces()).flat()) if (item?.family === 'IPv4') { try { udp.addMembership('239.255.42.100', item.address); } catch {} }
  try {
    const options = { token, mesh: { group }, discovery: false };
    instance = backend === 'javascript' ? new KinopioHub(group, options) : worker(backend, { namespace: group, ...options });
    if (backend === 'javascript') await instance.connected({ timeout: 60000 }); else await instance.call('connected');
    const status = () => backend === 'javascript' ? instance.status() : instance.call('status');
    const before = (await status()).mesh.members;
    const deadline = Date.now() + 15000;
    const discoverySignal = AbortSignal.timeout(15000);
    const challenge = randomUUID();
    const request = sign({ protocol: 4, domain, kind: 'discover', challenge });
    const postTo = (hint, envelope, overallSignal) => fetch(`http://${hint.address}:${hint.port}/kinopio-mesh/v1`, { method: 'POST', body: JSON.stringify(envelope), signal: overallSignal ? AbortSignal.any([AbortSignal.timeout(3000), overallSignal]) : AbortSignal.timeout(3000) });
    // Keep collecting signed adapters while failed probes are in flight.
    // Any responding endpoint must pass validation; only network failures permit fallback.
    const attempted = new Set(), outcomes = [];
    let selected;
    while (!selected && Date.now() < deadline) {
      const candidates = [...hints.entries()].filter(([key]) => !attempted.has(key)).slice(0, 4);
      if (!candidates.length) { await delay(Math.min(100, Math.max(1, deadline - Date.now()))); continue; }
      const probes = await Promise.all(candidates.map(async ([key, hint]) => {
        attempted.add(key);
        let response;
        try { response = await postTo(hint, request, discoverySignal); } catch (error) { return { error }; }
        return { status: response.status, body: await response.text() };
      }));
      for (const [index, result] of probes.entries()) {
        const [key, hint] = candidates[index];
        outcomes.push(`${key}: ${result.error?.message ?? result.status}`);
        if (process.env.KINOPIO_DISCOVERY_DIAGNOSTICS) console.error(`${backend} ${key}: ${result.error?.name ?? result.status}`);
        if (result.error) continue;
        assert.equal(result.status, 200);
        const envelope = JSON.parse(result.body);
        assert.ok(verify(envelope)); assert.equal(envelope.payload.protocol, 4);
        assert.equal(envelope.payload.kind, 'discovery'); assert.equal(envelope.payload.challenge, challenge);
        assert.ok(envelope.payload.member.broker.port > 0);
        selected ??= hint;
      }
    }
    assert.ok(selected, `${backend} no advertised control address responded within 15 seconds: ${outcomes.join('; ') || 'no signed hints'}`);
    const post = envelope => postTo(selected, envelope);

    assert.equal((await post({ ...request, signature: '0'.repeat(64) })).status, 403);
    assert.equal((await post(sign({ protocol: 4, domain, kind: 'discover', challenge: '' }))).status, 403);
    assert.equal((await status()).mesh.members, before);
    console.log(`PASS ${backend}: signed multicast/client discovery, broker, challenge/auth rejection, unchanged election membership`);
  } finally { try { await instance?.close(); } finally { await new Promise(resolve => udp.close(resolve)); } }
}
