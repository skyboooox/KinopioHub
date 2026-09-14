import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import test, { before, after } from 'node:test';
import { startLink, createPinnedBroker } from './edge-web-link.mjs';
import { startManagedBroker, ensureManagedBroker } from '../../KinopioHub.JS/src/mesh-broker.mjs';
import { connect as connectNats } from '../../KinopioHub.JS/node_modules/@nats-io/transport-node/lib/mod.js';
const exec = promisify(execFile);
const require = createRequire(new URL('../../KinopioHub.JS/package.json', import.meta.url));
const { WebSocket } = require('ws');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label = 'condition', timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  assert.fail(`Timed out: ${label}`);
}
let cert;
before(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kinopio-gate-ca-'));
  cert = { dir, ca: path.join(dir, 'ca.pem'), key: path.join(dir, 'server.key'), pem: path.join(dir, 'server.pem'), wrongCa: path.join(dir, 'wrong-ca.pem') };
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'ca.key'), '-out', cert.ca, '-days', '1', '-subj', '/CN=EWP test CA']);
  await exec('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', cert.key, '-out', path.join(dir, 'server.csr'), '-subj', '/CN=localhost']);
  await fs.writeFile(path.join(dir, 'extensions'), 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n');
  await exec('openssl', ['x509', '-req', '-in', path.join(dir, 'server.csr'), '-CA', cert.ca, '-CAkey', path.join(dir, 'ca.key'), '-CAcreateserial', '-out', cert.pem, '-days', '1', '-extfile', path.join(dir, 'extensions')]);
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'wrong-ca.key'), '-out', cert.wrongCa, '-days', '1', '-subj', '/CN=Untrusted EWP test CA']);
});
after(async () => { if (cert) await fs.rm(cert.dir, { recursive: true, force: true }); });

async function clusterHub(t, secure = true) {
  const binary = await ensureManagedBroker();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kinopio-gate-cluster-'));
  const children = [];
  t.after(async () => {
    for (const { child } of children) child.kill('SIGTERM');
    await Promise.all(children.map(async ({ child, ended }) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await ended; } finally { clearTimeout(timer); }
    }));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const start = async (name, routes = []) => {
    const dir = path.join(directory, name); await fs.mkdir(dir);
    const security = { cert_file: cert.pem, key_file: cert.key };
    const config = { server_name: name, host: '127.0.0.1', port: -1, http: '127.0.0.1:-1', ports_file_dir: dir,
      websocket: { host: '127.0.0.1', port: -1, ...(secure ? { tls: security, advertise: 'localhost' } : { no_tls: true }) },
      leafnodes: { host: '127.0.0.1', port: -1, ...(secure ? { tls: security } : {}) },
      cluster: { name: 'gate-test', host: '127.0.0.1', port: -1, routes } };
    const file = path.join(dir, 'nats.json'); await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
    const child = spawn(binary, ['-c', file], { stdio: 'ignore' });
    children.push({ child, ended: new Promise(resolve => child.once('exit', resolve)) });
    let ports;
    await until(async () => {
      const name = (await fs.readdir(dir)).find(value => value.endsWith('.ports'));
      if (name) { ports = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')); return true; }
    }, 'cluster startup');
    return ports;
  };
  const first = await start('gate-hub-a'); await start('gate-hub-b', first.cluster);
  await until(async () => (await (await fetch(new URL('/routez', first.monitoring[0]))).json()).num_routes > 0, 'cluster routes');
  const endpoint = new URL(first.websocket[0]); if (secure) endpoint.hostname = 'localhost';
  return { url: first.nats[0], websocketUrl: endpoint.href };
}

async function tunnel(proxy, target) {
  const socket = net.connect(Number(new URL(proxy).port), '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  return new Promise((resolve, reject) => {
    let header = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(Error('CONNECT timeout')); }, 3000);
    const read = chunk => {
      header = Buffer.concat([header, chunk]);
      const end = header.indexOf('\r\n\r\n'); if (end < 0) return;
      clearTimeout(timer); socket.removeListener('data', read); socket.pause();
      if (header.length > end + 4) socket.unshift(header.subarray(end + 4));
      resolve({ socket, status: Number(header.toString('latin1').split(' ')[1]) });
    };
    socket.on('data', read);
  });
}
const authority = endpoint => { const url = new URL(endpoint); return `${url.hostname}:${url.port || (url.protocol === 'wss:' ? 443 : 80)}`; };

async function clients(t, hub, leaf) {
  const remote = await connectNats({ servers: hub.url }); t.after(() => remote.close());
  const local = await connectNats({ servers: leaf.url }); t.after(() => local.close());
  remote.subscribe('gate.echo', { callback: (_error, message) => message.respond(message.data) }); await remote.flush();
  const roundTrip = async payload => until(async () => {
    try { return Buffer.from((await local.request('gate.echo', Buffer.from(payload), { timeout: 100 })).data).toString() === payload; }
    catch { return false; }
  }, 'exact request/reply');
  return { local, remote, roundTrip };
}

test('trusted TLS NATS leaf stays cut for five seconds and resumes through CONNECT', { timeout: 20000 }, async t => {
  const hub = await clusterHub(t);
  const probe = new WebSocket(`${hub.websocketUrl.replace(/\/$/, '')}/leafnode`, { ca: await fs.readFile(cert.ca) });
  probe.on('error', () => {}); t.after(() => probe.terminate());
  const [data] = await once(probe, 'message'); const info = JSON.parse(data.toString().trim().replace(/^INFO /, ''));
  assert.equal(info.tls_required, true); assert.ok(info.ws_connect_urls.length > 0); probe.terminate();
  t.diagnostic(`TLSRequired=true; advertised alternatives=${info.ws_connect_urls.length}; NATS=${info.version}; default compression`);
  const link = await startLink({ upstream: hub.websocketUrl }); t.after(() => link.close());
  const pinned = await createPinnedBroker({ upstream: hub.websocketUrl, proxy: link.url }); t.after(() => pinned.close());
  const leaf = await startManagedBroker({ binary: pinned.binary, host: '127.0.0.1', upstreams: [hub.websocketUrl], upstreamTls: { caFile: cert.ca } }); t.after(() => leaf.close());
  const { local, remote, roundTrip } = await clients(t, hub, leaf);
  await until(() => leaf.upstreamConnected(), 'initial TLS leaf'); await roundTrip('before cut');
  link.cut(); await until(async () => !(await leaf.upstreamConnected()), 'leaf disconnected');
  const frozen = link.stats(), deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    assert.equal(await leaf.upstreamConnected(), false);
    await assert.rejects(local.request('gate.echo', Buffer.from('blocked'), { timeout: 100 }));
    for (const key of ['upstreamChunks', 'upstreamBytes', 'downstreamChunks', 'downstreamBytes']) assert.equal(link.stats()[key], frozen[key]);
    await delay(100);
  }
  assert.ok(link.stats().rejectedConnections > 0);
  assert.equal(Buffer.from((await remote.request('gate.echo', Buffer.from('online'))).data).toString(), 'online');
  link.restore(); await until(() => leaf.upstreamConnected(), 'restored TLS leaf'); await roundTrip('after cut');
  for (const key of ['upstreamConnections', 'upstreamBytes', 'downstreamBytes']) assert.ok(link.stats()[key] > frozen[key], key);
  assert.ok(link.stats().activeConnections > 0);
});

for (const invalid of ['CA', 'hostname']) test(`end-to-end TLS rejects wrong ${invalid}`, { timeout: 12000 }, async t => {
  const hub = await clusterHub(t);
  const url = new URL(hub.websocketUrl); if (invalid === 'hostname') url.hostname = '127.0.0.1';
  const endpoint = url.href;
  const caFile = invalid === 'CA' ? cert.wrongCa : cert.ca;
  const link = await startLink({ upstream: endpoint }); t.after(() => link.close());
  const { socket, status } = await tunnel(link.url, authority(endpoint)); assert.equal(status, 200);
  const secure = tls.connect({ socket, servername: invalid === 'hostname' ? '127.0.0.1' : 'localhost', ca: await fs.readFile(caFile), rejectUnauthorized: true });
  let established = false; secure.on('secureConnect', () => { established = true; });
  const [error] = await once(secure, 'error'); assert.equal(established, false);
  assert.ok(invalid === 'hostname' ? error.code === 'ERR_TLS_CERT_ALTNAME_INVALID' : /CERT|VERIFY/.test(error.code)); secure.destroy();
  const before = link.stats().upstreamConnections;
  const pinned = await createPinnedBroker({ upstream: endpoint, proxy: link.url }); t.after(() => pinned.close());
  const leaf = await startManagedBroker({ binary: pinned.binary, host: '127.0.0.1', upstreams: [endpoint], upstreamTls: { caFile } }); t.after(() => leaf.close());
  await until(() => link.stats().upstreamConnections > before, 'real NATS TLS attempt');
  await delay(1500); assert.equal(await leaf.upstreamConnected(), false);
  t.diagnostic(`TLS rejection=${error.code}; real NATS leaf never connected`);
});

test('CONNECT rejects other targets, malformed and oversized headers; close is bounded', { timeout: 5000 }, async t => {
  const sink = net.createServer(socket => socket.pipe(socket)); sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  t.after(() => new Promise(resolve => sink.close(resolve)));
  const endpoint = `ws://127.0.0.1:${sink.address().port}`;
  const link = await startLink({ upstream: endpoint }); t.after(() => link.close());
  const denied = await tunnel(link.url, 'example.com:443'); assert.equal(denied.status, 403); denied.socket.destroy();
  assert.equal(link.stats().rejectedTargets, 1); assert.equal(link.stats().upstreamConnections, 0);
  const partial = net.connect(Number(new URL(link.url).port), '127.0.0.1'); partial.on('error', () => {}); await once(partial, 'connect');
  const ended = new Promise(resolve => partial.once('close', resolve)); partial.write('GET / HTTP/1.1\r\nX: ' + 'x'.repeat(17000)); await ended;
  assert.equal(link.stats().limitClosures, 1);
  const incomplete = net.connect(Number(new URL(link.url).port), '127.0.0.1'); incomplete.on('error', () => {}); await once(incomplete, 'connect'); incomplete.write('CONNE');
  const closed = new Promise(resolve => incomplete.once('close', resolve));
  const start = Date.now(); await link.close(); await closed; assert.ok(Date.now() - start < 1000); await link.close();
  assert.equal(link.stats().activeConnections, 0);
});

test('opaque tunnel preserves large payloads under backpressure', { timeout: 5000 }, async t => {
  const sink = net.createServer(socket => socket.pipe(socket)); sink.listen(0, '127.0.0.1'); await once(sink, 'listening');
  t.after(() => new Promise(resolve => sink.close(resolve)));
  const endpoint = `ws://127.0.0.1:${sink.address().port}`;
  const link = await startLink({ upstream: endpoint }); t.after(() => link.close());
  const { socket, status } = await tunnel(link.url, authority(endpoint)); assert.equal(status, 200); t.after(() => socket.destroy());
  const payload = Buffer.alloc(4 * 1024 * 1024 + 1, 123); let count = 0;
  const received = new Promise(resolve => socket.on('data', data => { assert.ok(data.every(value => value === 123)); count += data.length; if (count === payload.length) resolve(); }));
  socket.resume(); socket.write(payload); await received; assert.equal(count, payload.length); socket.destroy();
});

test('real cluster advertising bypasses an unpinned endpoint bridge (counterexample)', { timeout: 10000 }, async t => {
  const hub = await clusterHub(t, false), target = new URL(hub.websocketUrl);
  const pairs = new Set(); let cut = false, accepted = 0;
  const bridge = net.createServer(local => {
    if (cut) { local.destroy(); return; } accepted++;
    const remote = net.connect(Number(target.port), target.hostname); pairs.add(local); pairs.add(remote);
    const stop = () => { local.destroy(); remote.destroy(); pairs.delete(local); pairs.delete(remote); };
    local.on('error', stop).on('close', stop); remote.on('error', stop).on('close', stop); local.pipe(remote).pipe(local);
  });
  bridge.listen(0, '127.0.0.1'); await once(bridge, 'listening');
  t.after(async () => { for (const socket of pairs) socket.destroy(); await new Promise(resolve => bridge.close(resolve)); });
  const leaf = await startManagedBroker({ host: '127.0.0.1', upstreams: [`ws://127.0.0.1:${bridge.address().port}`] }); t.after(() => leaf.close());
  const { roundTrip } = await clients(t, hub, leaf);
  await until(() => leaf.upstreamConnected()); await roundTrip('initial'); cut = true;
  const before = accepted; for (const socket of pairs) socket.destroy();
  await until(async () => !(await leaf.upstreamConnected())); await until(() => leaf.upstreamConnected()); await roundTrip('bypass');
  assert.equal(accepted, before); assert.equal(pairs.size, 0);
});
