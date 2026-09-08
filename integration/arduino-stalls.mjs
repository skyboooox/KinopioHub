import assert from 'node:assert/strict';
import net from 'node:net';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { serialWorker, setTestClock } from './arduino-worker.mjs';

const host = process.env.KINOPIO_TEST_HOST;
if (net.isIP(host ?? '') !== 4) throw Error('Set KINOPIO_TEST_HOST to the ESP32-reachable development IPv4 address.');
if (!process.env.KINOPIO_CA_FILE) throw Error('Set KINOPIO_CA_FILE to a trusted test PEM CA.');
const caCertificate = readFileSync(process.env.KINOPIO_CA_FILE, 'utf8');
const device = serialWorker();
const report = [];
async function fixture(tls) {
  const sockets = new Set(); let accepted = false, subscription;
  const server = net.createServer(socket => {
    sockets.add(socket); accepted = true;
    socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    if (tls) return; // Accept TCP but never answer TLS ClientHello.
    socket.write('INFO {"server_id":"stall-fixture","version":"2.14.6","proto":1,"max_payload":1048576}\r\n');
    let bytes = Buffer.alloc(0), remaining = 0;
    socket.on('data', data => {
      bytes = Buffer.concat([bytes, data]);
      for (;;) {
        if (remaining) { if (bytes.length < remaining) return; bytes = bytes.subarray(remaining); remaining = 0; }
        const end = bytes.indexOf('\r\n'); if (end < 0) return;
        const line = bytes.subarray(0, end).toString(); bytes = bytes.subarray(end + 2);
        if (line.startsWith('PUB ')) { remaining = Number(line.split(' ').at(-1)) + 2; continue; }
        if (line.startsWith('SUB ')) { const fields = line.split(' '); subscription = { socket, subject: fields[1].replace('>', 'record').replace('*', 'record'), sid: fields.at(-1) }; }
        if (line === 'PING') socket.write('PONG\r\n');
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
  return { get accepted() { return accepted; }, url: `${tls ? 'tls' : 'nats'}://${host}:${server.address().port}`,
    partial() { assert.ok(subscription); subscription.socket.write(`MSG ${subscription.subject} ${subscription.sid} 100\r\n{`); },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
}
async function until(check, label) { const end = Date.now() + 20000; while (Date.now() < end) { if (await check()) return; await delay(100); } throw Error(label); }
try {
  await delay(2000);
  await setTestClock(device.call);
  for (const tls of [true, false]) {
    const server = await fixture(tls);
    try {
      await device.call('configure', { namespace: 'stall-regression', server: server.url, caCertificate });
      await until(() => server.accepted, 'Fixture was not contacted');
      if (!tls) {
        await until(async () => (await device.call('status')).connection === 'connected', 'Plaintext fixture did not connect');
        server.partial(); await delay(100);
      }
      const started = performance.now();
      const status = await device.call('status');
      const elapsedMs = performance.now() - started;
      assert.ok(elapsedMs < 5500, 'Stalled peer blocked Arduino loop beyond bound');
      if (tls) assert.notEqual(status.connection, 'connected');
      else await until(async () => (await device.call('status')).connection !== 'connected', 'Partial frame did not disconnect');
      assert.ok(status.resources.freeHeap > 32768);
      report.push({ check: tls ? 'stalled TLS handshake' : 'partial NATS frame', elapsedMs: Math.round(elapsedMs), resources: status.resources });
      console.log(`PASS ${report.at(-1).check}: bounded loop responsiveness`);
    } finally { await device.call('disconnect'); await server.close(); }
  }
  console.log(JSON.stringify(report, null, 2));
} finally { device.close(); }
