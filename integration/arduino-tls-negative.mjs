import assert from 'node:assert/strict';
import tls from 'node:tls';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { serialWorker, setTestClock } from './arduino-worker.mjs';

const host = process.env.KINOPIO_TEST_HOST;
if (net.isIP(host ?? '') !== 4) throw Error('Set KINOPIO_TEST_HOST to the ESP32-reachable development IPv4 address.');
const directory = mkdtempSync(join(tmpdir(), 'kinopio-tls-'));
const file = name => join(directory, name);
const openssl = args => execFileSync(process.env.OPENSSL ?? 'openssl', args, { cwd: directory, stdio: ['ignore', 'ignore', 'pipe'] });
const device = serialWorker();
try {
  for (const name of ['ca', 'other']) openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '2', '-subj', `/CN=Kinopio test ${name}`]);
  openssl(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=Kinopio fixture']);
  writeFileSync(file('index'), ''); writeFileSync(file('serial'), '1000\n');
  const now = Date.now();
  const date = time => new Date(time).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z';
  for (const kind of ['valid', 'expired', 'future', 'wronghost']) {
    writeFileSync(file('ca.cnf'), `[ca]\ndefault_ca=local\n[local]\ndatabase=${file('index')}\nserial=${file('serial')}\nnew_certs_dir=${directory}\ncertificate=${file('ca.pem')}\nprivate_key=${file('ca.key')}\ndefault_md=sha256\npolicy=policy\nunique_subject=no\nx509_extensions=server\n[policy]\ncommonName=supplied\n[server]\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${kind === 'wronghost' ? '192.0.2.1' : host}\n`);
    openssl(['ca', '-batch', '-config', 'ca.cnf', '-in', 'leaf.csr', '-out', `${kind}.pem`, '-startdate', date(now + (kind === 'future' ? 86400000 : -86400000)), '-enddate', date(now + (kind === 'expired' ? -3600000 : 172800000))]);
  }
  await delay(2000);
  await device.call('clock', { unixTime: 0 });
  await assert.rejects(device.call('configure', { namespace: 'clock-negative', server: `tls://${host}:4222`, caCertificate: readFileSync(file('ca.pem'), 'utf8') }), /CLOCK_REQUIRED/);
  console.log('PASS TLS clock unset: CLOCK_REQUIRED');
  await setTestClock(device.call);
  for (const kind of ['valid', 'expired', 'future', 'wronghost', 'wrongca']) {
    const sockets = new Set();
    const server = tls.createServer({ cert: readFileSync(file(`${kind === 'wrongca' ? 'valid' : kind}.pem`)), key: readFileSync(file('leaf.key')) }, socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      socket.write('INFO {"server_id":"tls-fixture","version":"2.14.6","proto":1,"max_payload":1048576}\r\n');
      let bytes = Buffer.alloc(0), remaining = 0;
      socket.on('data', data => {
        bytes = Buffer.concat([bytes, data]);
        for (;;) {
          if (remaining) { if (bytes.length < remaining) return; bytes = bytes.subarray(remaining); remaining = 0; }
          const end = bytes.indexOf('\r\n'); if (end < 0) return;
          const line = bytes.subarray(0, end).toString(); bytes = bytes.subarray(end + 2);
          if (line.startsWith('PUB ')) { remaining = Number(line.split(' ').at(-1)) + 2; continue; }
          if (line === 'PING') socket.write('PONG\r\n');
        }
      });
    });
    server.on('tlsClientError', () => {});
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
    try {
      await device.call('configure', { namespace: 'certificate-test', server: `tls://${host}:${server.address().port}`, caCertificate: readFileSync(file(kind === 'wrongca' ? 'other.pem' : 'ca.pem'), 'utf8') });
      const deadline = Date.now() + (kind === 'valid' ? 15000 : 8000);
      let connected = false;
      while (Date.now() < deadline) {
        if ((await device.call('status')).connection === 'connected') { connected = true; break; }
        await delay(200);
      }
      assert.equal(connected, kind === 'valid', `${kind} certificate result incorrect`);
      console.log(`PASS TLS certificate ${kind}: ${connected ? 'accepted' : 'rejected'}`);
    } finally {
      await device.call('disconnect');
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  }
} finally { device.close(); rmSync(directory, { recursive: true, force: true }); }
