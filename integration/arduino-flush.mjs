// Test-only NATS wire fixture: use only on an isolated development LAN.
import assert from 'node:assert/strict';
import net from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { serialWorker } from './arduino-worker.mjs';

const host = process.env.KINOPIO_TEST_HOST;
if (!host || net.isIP(host) !== 4) throw Error('Set KINOPIO_TEST_HOST to this host\'s ESP32-reachable IPv4 address.');
let armed = false, held = false, pings = 0, releaseTime = 0;
const sockets = new Set();
const timers = new Set();
const server = net.createServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  socket.on('error', () => {});
  socket.write('INFO {"server_id":"test-only","version":"2.14.6","proto":1,"max_payload":1048576}\r\n');
  let bytes = Buffer.alloc(0), remaining = 0;
  socket.on('data', data => {
    bytes = Buffer.concat([bytes, data]);
    for (;;) {
      if (remaining) {
        if (bytes.length < remaining) return;
        bytes = bytes.subarray(remaining); remaining = 0;
      }
      const end = bytes.indexOf('\r\n');
      if (end < 0) return;
      const line = bytes.subarray(0, end).toString(); bytes = bytes.subarray(end + 2);
      if (line.startsWith('PUB ')) { remaining = Number(line.split(' ').at(-1)) + 2; continue; }
      if (line !== 'PING') continue;
      if (!armed) { socket.write('PONG\r\n'); continue; }
      pings++;
      if (!held) { held = true; continue; }
      // The first response acknowledges the timed-out PING, never the new flush.
      socket.write('PONG\r\n');
      const timer = setTimeout(() => {
        timers.delete(timer); releaseTime = performance.now(); socket.write('PONG\r\n');
      }, 400);
      timers.add(timer); armed = false;
    }
  });
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
const serial = serialWorker();
try {
  await delay(2000);
  await serial.call('configure', { namespace: 'flush-regression', server: `nats://${host}:${server.address().port}` });
  const deadline = Date.now() + 30000;
  while ((await serial.call('status')).connection !== 'connected') {
    if (Date.now() > deadline) throw Error('ESP32 fixture connection timed out');
    await delay(100);
  }
  await serial.call('flush');
  armed = true;
  await assert.rejects(serial.call('flush', { timeoutMs: 30 }), /flush failed/);
  const started = performance.now();
  assert.equal(await serial.call('flush', { timeoutMs: 1500 }), true);
  const finished = performance.now();
  assert.equal(pings, 2);
  assert.ok(releaseTime >= started && finished >= releaseTime, 'Flush returned on the older PONG');
  assert.ok(finished - started >= 350, 'Flush did not wait for its own delayed PONG');
  console.log(JSON.stringify({ check: 'PASS timed-out PONG cannot satisfy the next flush', elapsedMs: Math.round(finished - started), resources: (await serial.call('status')).resources }));
} finally {
  serial.close();
  for (const timer of timers) clearTimeout(timer);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
