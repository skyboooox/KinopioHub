import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import KinopioHub from '../../KinopioHub.JS/src/node.mjs';
import { startManagedBroker } from '../../KinopioHub.JS/src/mesh-broker.mjs';
import { serialWorker } from './arduino-worker.mjs';

const host = process.env.KINOPIO_TEST_HOST;
if (net.isIP(host ?? '') !== 4) throw Error('Set KINOPIO_TEST_HOST to the ESP32-reachable development IPv4 address.');
const namespace = `repair-${randomUUID()}`, token = randomUUID();
const broker = await startManagedBroker({ host: '127.0.0.1', token });
const address = new URL(broker.url);
const sockets = new Set(); let suppress = false, dropped = 0, connections = 0;
const proxy = net.createServer(client => {
  connections++;
  const upstream = net.connect(Number(address.port), address.hostname);
  for (const socket of [client, upstream]) { sockets.add(socket); socket.on('error', () => { client.destroy(); upstream.destroy(); }); socket.on('close', () => sockets.delete(socket)); }
  client.on('close', () => upstream.destroy()); upstream.on('close', () => client.destroy());
  client.pipe(upstream);
  let bytes = Buffer.alloc(0);
  upstream.on('data', data => {
    bytes = Buffer.concat([bytes, data]);
    for (;;) {
      const end = bytes.indexOf('\r\n'); if (end < 0) return;
      const line = bytes.subarray(0, end).toString();
      const fields = line.split(' ');
      const message = fields[0] === 'MSG' || fields[0] === 'HMSG';
      const length = end + 2 + (message ? Number(fields.at(-1)) + 2 : 0);
      if (bytes.length < length) return;
      const frame = bytes.subarray(0, length); bytes = bytes.subarray(length);
      if (suppress && message && /^[0-9a-f]+\.[0-9a-f]+$/.test(fields[1])) dropped++;
      else client.write(frame);
    }
  });
});
await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, host, resolve); });
const device = serialWorker();
const js = new KinopioHub(namespace, { servers: [broker.url], token, mesh: false, discovery: false });
async function until(check, label) { const end = Date.now() + 45000; while (Date.now() < end) { if (await check()) return; await delay(100); } throw Error(label); }
try {
  await delay(2000); await js.connected();
  const value = js.var('battery');
  await value.set(1); await js.flush();
  await device.call('configure', { namespace, server: `nats://${host}:${proxy.address().port}`, token });
  await until(async () => (await device.call('get')).value === 1, 'Initial snapshot missing');
  await delay(1000);
  const before = connections;
  suppress = true;
  await value.set(2); await js.flush();
  await until(() => dropped > 0, 'Proxy did not suppress the update');
  await until(async () => (await device.call('get')).value === 2, 'Periodic snapshot did not repair suppressed update');
  assert.ok(dropped > 0);
  const after = await device.call('status');
  assert.equal(connections, before);
  assert.equal(after.connection, 'connected');
  console.log(JSON.stringify({ check: 'PASS periodic snapshot repairs dropped live updates without reconnect', dropped, status: await device.call('status') }, null, 2));
} finally {
  device.close(); await js.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => proxy.close(resolve)); await broker.close();
}
