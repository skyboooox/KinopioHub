import { childPeer } from './messaging-peer.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import Hub from '../../KinopioHub.JS/src/node.mjs';
import { startManagedBroker, BROKER_VERSION } from '../../KinopioHub.JS/src/mesh-broker.mjs';
import { messageConformance } from './message-conformance.mjs';

const python = process.env.KINOPIO_PYTHON ?? fileURLToPath(new URL('../../KinopioHub.py/.venv/bin/python', import.meta.url));
const report = { server: BROKER_VERSION, transport: 'TCP loopback', checks: [] };
const peer = options => childPeer(python, [fileURLToPath(new URL('./messaging-python.py', import.meta.url)), JSON.stringify(options)]);

async function until(predicate, label) {
  const deadline = performance.now() + 6000;
  while (performance.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw Error(label);
}
function passed(label) { report.checks.push(label); console.log(`PASS ${label}`); }
function headerValues(headers) { return headers.getAll('x-test'); }

let broker, js, isolated, py;
try {
  broker = await startManagedBroker({ host: '127.0.0.1' });
  const namespace = `消息-${randomUUID()}`;
  js = new Hub(namespace, { servers: [broker.url], mesh: false, discovery: false, healthInterval: 200 });
  isolated = new Hub(`${namespace}-other`, { servers: [broker.url], mesh: false, discovery: false });
  py = peer({ namespace, servers: [broker.url], mesh: false, discovery: false, health_interval: 0.2 });
  await Promise.all([js.connected(), isolated.connected(), py.call('connected')]);
  report.encodingChecks = await messageConformance(py.call);
  passed('Shared UTF-8 message and pattern vectors agree');

  await py.call('subscribe', { name: 'sensor.*', key: 'events' });
  const temperature = js.var('sensor.温度');
  await temperature.set(23.5);
  await temperature.pub({ value: 24, label: '🌡️' }, { headers: { 'X-Test': ['first', 'second'] } });
  await js.flush();
  await until(async () => (await py.call('snapshot')).received.length === 1, 'Python did not receive wildcard event');
  const event = (await py.call('snapshot', { clear: true })).received[0];
  assert.deepEqual(event, { data: { value: 24, label: '🌡️' }, topic: 'sensor.温度', testHeaders: ['first', 'second'] });
  assert.equal(temperature.get(), 23.5);
  passed('JS -> Python Unicode wildcard event, duplicate Headers, state unchanged');

  const events = [];
  const jsSub = await js.var('python.>').sub((data, context) => events.push({ data, topic: context.topic, headers: headerValues(context.headers) }));
  let leaked = 0;
  await isolated.var('>').sub(() => { leaked++; });
  await py.call('publish', { name: 'python.event', data: [null, false, 0, ''], headers: { 'X-Test': ['a', 'b'] } });
  await until(() => events.length === 1, 'JS did not receive Python event');
  assert.deepEqual(events[0], { data: [null, false, 0, ''], topic: 'python.event', headers: ['a', 'b'] });
  await py.call('publish', { name: 'python', data: 'not a descendant' });
  await js.flush();
  await delay(100);
  assert.equal(events.length, 1);
  assert.equal(leaked, 0);
  passed('Python -> JS data-first events, > requires a descendant, namespace isolation');

  await py.call('handle', { key: 'echo', name: 'rpc.echo', headers: { 'X-Test': ['reply-one', 'reply-two'] } });
  const echoed = await js.var('rpc.echo').req({ on: true }, { details: true });
  assert.deepEqual(echoed.data, { on: true });
  assert.deepEqual(headerValues(echoed.headers), ['reply-one', 'reply-two']);
  assert.equal(await js.var('rpc.echo').req(), null);
  assert.equal(js.var('rpc.echo').get('absent'), 'absent');
  const jsHandler = await js.var('rpc.node').handle(data => ({ source: 'js', data }));
  assert.deepEqual((await py.call('request', { name: 'rpc.node', data: false })).data, { source: 'js', data: false });
  await assert.rejects(js.var('no.responder').req(), error => error.code === 'NO_RESPONDERS');
  await assert.rejects(py.call('request', { name: 'no.responder' }), error => error.code === 'NO_RESPONDERS');
  await assert.rejects(js.var('rpc.*').pub(1), error => error.code === 'INVALID_TOPIC');
  await assert.rejects(py.call('publish', { name: 'rpc.*', data: 1 }), error => error.code === 'INVALID_TOPIC');
  passed('Bidirectional automatic replies, null request, details and immediate protocol errors');

  await py.call('reply_many', { key: 'many', name: 'rpc.many', responses: [null, { source: 'py' }] });
  const many = await js.var('rpc.many').requestMany(null, { maxReplies: 2, timeout: 1000, details: true });
  assert.deepEqual(many.replies.map(reply => reply.data), [null, { source: 'py' }]);
  assert.equal(many.reason, 'maxReplies');
  const first = await js.var('rpc.gather').handle(() => 1);
  const second = await js.var('rpc.gather').handle(() => 2);
  const gathered = await py.call('request_many', { name: 'rpc.gather', maxReplies: 2, timeout: 1 });
  assert.deepEqual(gathered.data.sort(), [1, 2]);
  assert.equal(gathered.reason, 'maxReplies');
  passed('Bidirectional bounded multi-response collection with explicit completion reason');

  await py.call('snapshot', { clear: true });
  await py.call('handle', { key: 'queue', name: 'jobs.work', queue: 'workers.队列', response: 'python' });
  const nodeJobs = [];
  const queue = await js.var('jobs.work').handle(data => { nodeJobs.push(data); return 'js'; }, { queue: 'workers.队列' });
  for (let id = 0; id < 40; id++) assert.ok(['js', 'python'].includes(await js.var('jobs.work').req(id)));
  const pythonJobs = (await py.call('snapshot')).handled.filter(row => row.name === 'jobs.work').map(row => row.data);
  assert.deepEqual([...nodeJobs, ...pythonJobs].sort((a, b) => a - b), Array.from({ length: 40 }, (_, i) => i));
  passed('One handler per queue-group request across JS and Python');

  await until(async () => (await js.instances.list()).some(row => row.sdk === 'python' && row.messaging?.phase === 'active'), 'Python messaging health summary was not accepted by JS');
  passed('Optional messaging health interoperates with the current-state report protocol');

  await jsSub.unsubscribe();
  await js.flush();
  await py.call('publish', { name: 'python.event', data: 'after unsubscribe' });
  await delay(100);
  assert.equal(events.length, 1);
  await Promise.all([jsHandler.unsubscribe(), first.unsubscribe(), second.unsubscribe(), queue.unsubscribe()]);
  await js.var('rpc.echo').handle(() => 'remaining-js');
  await py.call('drain');
  assert.equal(await js.var('rpc.echo').req(), 'remaining-js');
  await js.drain();
  passed('Unsubscribe and drain release interest and leave the other peer usable');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.stack; process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([py?.close(), js?.close(), isolated?.close()]);
  if (broker) cleanup.push(await broker.close().then(() => ({ status: 'fulfilled' }), reason => ({ status: 'rejected', reason })));
  const failures = cleanup.filter(row => row.status === 'rejected');
  if (failures.length) { report.passed = false; report.cleanupErrors = failures.map(row => String(row.reason)); process.exitCode = 1; }
  console.log(JSON.stringify(report, null, 2));
}
