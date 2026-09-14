import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import process from "node:process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createFixedBrokerSupervisor, validateConfig, verifyOwnedBroker } from "./mesh-fixed-supervisor.mjs";

const base = {
  sdkRoot: "/tmp/sdk", binary: "/tmp/nats-server", binarySha256: "a".repeat(64),
  runId: "fixed_1", sourceId: "host_a", advertiseAddress: "127.0.0.1", restartDelayMs: 1000,
};
const provenanceProvider = async () => ({ files: { mocked: { sha256: "b".repeat(64) } } });

class FakeChild extends EventEmitter {
  constructor(pid) { super(); this.pid = pid; this.exitCode = null; this.signalCode = null; }
  exit(code = 1, signal = null) { this.exitCode = code; this.signalCode = signal; this.emit("exit", code, signal); }
}

function harness(startManagedBroker) {
  const input = new PassThrough(), output = new PassThrough();
  const events = [];
  let pending = "";
  output.setEncoding("utf8");
  output.on("data", chunk => {
    pending += chunk;
    const lines = pending.split("\n"); pending = lines.pop();
    for (const line of lines) if (line) events.push(JSON.parse(line));
  });
  return { input, output, events, dependencies: { input, output, startManagedBroker, provenanceProvider } };
}

async function until(predicate, label, timeout = 4000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    const result = predicate();
    if (result) return result;
    await sleep(10);
  }
  throw Error(`timed out waiting for ${label}`);
}

function fakeFactory() {
  const calls = [], handles = [];
  const startManagedBroker = async options => {
    calls.push(options);
    const index = calls.length, child = new FakeChild(7000 + index);
    const handle = {
      port: options.port ?? 43111, wsPort: options.wsPort ?? 43112, pid: 8000 + index, child,
      closeCalls: 0, async close() { this.closeCalls++; },
    };
    handles.push(handle); return handle;
  };
  return { calls, handles, startManagedBroker };
}

test("config requires the fixed one-second restart policy", () => {
  assert.deepEqual(validateConfig(base), base);
  assert.throws(() => validateConfig({ ...base, restartDelayMs: 999 }), /exactly 1000/);
  assert.throws(() => validateConfig({ ...base, binarySha256: "A".repeat(64) }), /lowercase SHA-256/);
});

test("unexpected exits restart repeatedly after one second on the frozen endpoint", async () => {
  const factory = fakeFactory(), io = harness(factory.startManagedBroker);
  const supervisor = await createFixedBrokerSupervisor(base, { ...io.dependencies });
  assert.deepEqual(supervisor.status(), { generation: 1, server: "nats://127.0.0.1:43111", port: 43111, wsPort: 43112, pid: 8001, watchdogPid: 7001 });

  factory.handles[0].child.exit(9, null);
  const firstSchedule = await until(() => io.events.find(event => event.type === "restartScheduled"), "first restart schedule");
  const secondStart = await until(() => io.events.find(event => event.type === "brokerStarted" && event.generation === 2), "second generation");
  assert.ok(secondStart.monoMs - firstSchedule.monoMs >= 900, "restart must not be immediate");
  assert.equal(factory.calls[1].port, 43111); assert.equal(factory.calls[1].wsPort, 43112);

  factory.handles[1].child.exit(null, "SIGSEGV");
  const secondSchedule = await until(() => io.events.filter(event => event.type === "restartScheduled").length === 2 && io.events.filter(event => event.type === "restartScheduled")[1], "second restart schedule");
  const thirdStart = await until(() => io.events.find(event => event.type === "brokerStarted" && event.generation === 3), "third generation");
  assert.ok(thirdStart.monoMs - secondSchedule.monoMs >= 900);
  assert.equal(factory.calls[2].port, 43111); assert.equal(factory.calls[2].wsPort, 43112);
  assert.equal(io.events.filter(event => event.type === "brokerExited").length, 2);

  const closed = await supervisor.close("test");
  assert.equal(closed.fatal, false); assert.equal(factory.handles[2].closeCalls, 1);
  assert.equal(io.events.at(-1).type, "closed"); assert.equal(io.events.at(-1).outputIntegrity, "complete");
});

test("close cancels a scheduled restart", async () => {
  const factory = fakeFactory(), io = harness(factory.startManagedBroker);
  const supervisor = await createFixedBrokerSupervisor(base, io.dependencies);
  factory.handles[0].child.exit(1);
  await until(() => io.events.some(event => event.type === "restartScheduled"), "restart schedule");
  await supervisor.close("test-close-during-delay");
  await sleep(1100);
  assert.equal(factory.calls.length, 1);
});

test("close command aborts and cleans up a broker start in flight", async () => {
  let resolveStart;
  const started = new Promise(resolve => { resolveStart = resolve; });
  const io = harness(() => started);
  const creating = createFixedBrokerSupervisor(base, io.dependencies);
  await sleep(10); io.input.write('{"id":"close-race","op":"close"}\n');
  const child = new FakeChild(7101), handle = { port: 44001, wsPort: 44002, pid: 8101, child, closeCalls: 0, async close() { this.closeCalls++; } };
  resolveStart(handle);
  const supervisor = await creating;
  const closed = await supervisor.done;
  assert.equal(closed.reason, "command"); assert.equal(closed.fatal, false); assert.equal(handle.closeCalls, 1);
  assert.equal(io.events.some(event => event.type === "ready"), false);
});

test("startup failure emits an explicit fatal close", async () => {
  const error = Object.assign(Error("deliberate startup failure"), { code: "BROKER_FAILED" });
  const io = harness(async () => { throw error; });
  const supervisor = await createFixedBrokerSupervisor(base, io.dependencies);
  const closed = await supervisor.done;
  assert.equal(closed.fatal, true);
  assert.ok(io.events.some(event => event.type === "error" && event.operation === "startup"));
  assert.equal(io.events.at(-1).type, "closed"); assert.equal(io.events.at(-1).fatal, true);
});

test("consecutive restart failures are serialized and terminate after a bounded count", async () => {
  let calls = 0;
  const child = new FakeChild(7301);
  const startManagedBroker = async () => {
    calls++;
    if (calls > 1) throw Object.assign(Error(`restart failure ${calls - 1}`), { code: "BROKER_FAILED" });
    return { port: 45001, wsPort: 45002, pid: 8301, child, async close() {} };
  };
  const delays = [];
  const io = harness(startManagedBroker);
  const supervisor = await createFixedBrokerSupervisor(base, {
    ...io.dependencies,
    setTimeout(callback, delay) { delays.push(delay); queueMicrotask(callback); return { callback }; },
    clearTimeout() {},
  });
  child.exit(1);
  const closed = await supervisor.done;
  assert.equal(closed.reason, "restart-exhausted"); assert.equal(closed.fatal, true);
  assert.equal(calls, 6); assert.deepEqual(delays, [1000, 1000, 1000, 1000, 1000]);
  assert.equal(io.events.filter(event => event.type === "error" && event.operation === "restart").length, 5);
});

test("ownership verification requires the recorded watchdog-to-NATS relationship", async () => {
  const record = { brokerPid: 8123, watchdogPid: 7123, binary: "/tmp/nats-server" };
  const valid = [
    { pid: 7123, ppid: process.pid, command: "node mesh-watchdog.mjs" },
    { pid: 8123, ppid: 7123, command: "/tmp/nats-server -c /tmp/nats.json" },
  ];
  assert.equal((await verifyOwnedBroker(record, async () => valid)).broker.pid, 8123);
  await assert.rejects(verifyOwnedBroker(record, async () => [...valid, { pid: 8124, ppid: 7123, command: "/tmp/nats-server" }]), /exactly/);
  await assert.rejects(verifyOwnedBroker(record, async () => [{ ...valid[0], ppid: 1 }, valid[1]]), /direct child/);
});
