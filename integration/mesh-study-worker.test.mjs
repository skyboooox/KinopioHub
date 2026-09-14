import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createStudyWorker, ownedKeyIndexes, validateConfig } from "./mesh-study-worker.mjs";

const workerPath = fileURLToPath(new URL("./mesh-study-worker.mjs", import.meta.url));
const base = { sdkPath: workerPath, runId: "run_1", sourceId: "a", sourceIds: ["a", "b"], policy: "F", namespace: "study_1", servers: ["nats://127.0.0.1:4222"], keys: 4, payloadBytes: 8, rateHz: 20 };
const mockedProvenance = async () => ({ unavailable: "mocked SDK used by protocol unit test" });

test("config validates policy boundaries and assigns disjoint round-robin keys", () => {
  assert.deepEqual(ownedKeyIndexes(validateConfig(base)), [0, 2]);
  assert.deepEqual(ownedKeyIndexes(validateConfig({ ...base, sourceId: "b" })), [1, 3]);
  assert.throws(() => validateConfig({ ...base, policy: "F", servers: [] }), /requires at least one server/);
  assert.throws(() => validateConfig({ ...base, policy: "Q", servers: [], group: undefined }), /requires group/);
  assert.equal(validateConfig({ ...base, policy: "S", servers: [], group: "pilot" }).group, "pilot");
});

class FakeVariable {
  constructor(index) { this.index = index; this.value = undefined; this.meta = { initialized: true, exists: false, version: undefined, pending: false, connected: true }; this.listeners = new Set(); }
  watch(callback) { this.listeners.add(callback); callback(this.value, this.meta); return () => this.listeners.delete(callback); }
  async set(value) { this.value = structuredClone(value); this.meta = { ...this.meta, exists: true, version: { counter: String(value.seq), writer: "fake" } }; for (const listener of this.listeners) listener(this.value, this.meta); }
  receive(value) { this.value = value; this.meta = { ...this.meta, exists: true, version: { counter: String(value.seq), writer: value.source } }; for (const listener of this.listeners) listener(value, this.meta); }
}

class DeferredVariable extends FakeVariable {
  constructor(index) { super(index); this.pending = []; }
  set(value) {
    this.value = structuredClone(value);
    this.meta = { ...this.meta, exists: true, version: { counter: String(value.seq), writer: "fake" } };
    for (const listener of this.listeners) listener(this.value, this.meta);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }
  resolveNext() { this.pending.shift()?.resolve(); }
}

class FakeHub {
  static last;
  constructor(namespace, options) { this.namespace = namespace; this.options = options; this.variables = Array.from({ length: 4 }, (_, index) => new FakeVariable(index)); this.espProbe = new FakeVariable(-1); this.closed = false; FakeHub.last = this; }
  var(name) { return name === "esp-probe" ? this.espProbe : this.variables[Number(name.slice(-2))]; }
  async ready() {}
  status() { return { connection: this.closed ? "closed" : "connected", mesh: { role: "disabled", leaderId: null, members: 0, reason: "fixture", upstreamConnected: null } }; }
  async close() { this.closed = true; }
}

test("JSONL commands drive writes, filter observations, snapshot, and clean up on close", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", chunk => { text += chunk; });
  const worker = await createStudyWorker(base, { KinopioHub: FakeHub, input, output, provenanceProvider: mockedProvenance });
  input.write('{"id":1,"op":"start"}\n');
  await new Promise(resolve => setTimeout(resolve, 130));
  input.write('{"id":2,"op":"stop"}\n');
  const remote = { run: "run_1", source: "b", seq: 7, key: 1, data: "xxxxxxxx" };
  FakeHub.last.variables[1].receive(remote); FakeHub.last.variables[1].receive(remote);
  input.write('{"id":3,"op":"snapshot"}\n');
  input.write('{"id":4,"op":"close"}\n');
  await new Promise(resolve => setTimeout(resolve, 80));
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.ok(events.some(event => event.type === "ready" && event.ownedKeys.join() === "0,2" && event.runtime.provenance.unavailable));
  assert.ok(events.some(event => event.type === "write" && event.accepted));
  assert.equal(events.filter(event => event.type === "observation").length, 1);
  assert.ok(events.some(event => event.type === "snapshot" && event.espProbe.meta.initialized));
  assert.equal(events.at(-1).type, "closed");
  assert.equal(events.at(-1).outputIntegrity, "complete");
  assert.equal(events.at(-1).fatal, false);
  assert.equal(FakeHub.last.closed, true);
  assert.equal(FakeHub.last.variables.every(variable => variable.listeners.size === 0), true);
  await worker.close();
});

test("stdin EOF closes SDK resources and resolves done", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", chunk => { text += chunk; });
  const worker = await createStudyWorker(base, { KinopioHub: FakeHub, input, output, provenanceProvider: mockedProvenance });
  input.end();
  await worker.done;
  assert.equal(FakeHub.last.closed, true);
  const closed = text.trim().split("\n").map(line => JSON.parse(line)).at(-1);
  assert.equal(closed.type, "closed");
  assert.equal(closed.reason, "stdin-eof");
  assert.equal(closed.outputEventsDroppedTotal, 0);
});

test("receiver-local phase markers enforce the documented lifecycle", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", chunk => { text += chunk; });
  const worker = await createStudyWorker(base, { KinopioHub: FakeHub, input, output, provenanceProvider: mockedProvenance });
  await worker.command({ id: "start-1", op: "mark", phase: "measurementStart" });
  await worker.command({ id: "start-2", op: "mark", phase: "measurementStart" });
  await worker.command({ id: "fault-early", op: "mark", phase: "postfaultStart" });
  await worker.command({ id: "base-1", op: "mark", phase: "baselineEnd" });
  await worker.command({ id: "fault-1", op: "mark", phase: "postfaultStart" });
  await worker.command({ id: "end-1", op: "mark", phase: "measurementEnd" });
  assert.throws(() => worker.mark("measurementEnd", "end-2"), /duplicate phase marker/);
  const events = text.trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(events.filter(event => event.type === "phaseMarker").map(event => event.phase), ["measurementStart", "baselineEnd", "postfaultStart", "measurementEnd"]);
  assert.equal(events.filter(event => event.type === "observationWindowStarted").length, 1);
  assert.equal(events.filter(event => event.type === "observationWindowEnded").length, 1);
  assert.equal(events.find(event => event.type === "phaseMarker" && event.phase === "measurementStart").monoMs, events.find(event => event.type === "observationWindowStarted").monoMs);
  assert.deepEqual(events.filter(event => event.type === "command" && event.op === "mark" && event.ok).map(event => event.result.phase), ["measurementStart", "baselineEnd", "postfaultStart", "measurementEnd"]);
  assert.equal(events.filter(event => event.type === "command" && event.op === "mark" && !event.ok).length, 2);
  await worker.close();
});

test("stop and close wait for accepted writes before resources close", async () => {
  const input = new PassThrough(), output = new PassThrough();
  let text = ""; output.on("data", chunk => { text += chunk; });
  class DeferredHub extends FakeHub {
    constructor(options) { super(options); this.variables = Array.from({ length: 4 }, (_, index) => new DeferredVariable(index)); DeferredHub.last = this; FakeHub.last = this; }
  }
  const worker = await createStudyWorker(base, { KinopioHub: DeferredHub, input, output, provenanceProvider: mockedProvenance });
  await worker.command({ id: 1, op: "start" });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(DeferredHub.last.variables[0].pending.length, 1);
  let stopped = false;
  const stopTask = worker.command({ id: 2, op: "stop" }).then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(stopped, false);
  const writesAtStop = text.split("\n").filter(line => line.includes('"type":"write"')).length;
  DeferredHub.last.variables[0].resolveNext();
  await stopTask;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(text.split("\n").filter(line => line.includes('"type":"write"')).length, writesAtStop + 1);

  await worker.command({ id: 3, op: "start" });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.ok(DeferredHub.last.variables.some(variable => variable.pending.length));
  const closeTask = worker.close();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(DeferredHub.last.closed, false);
  for (const variable of DeferredHub.last.variables) variable.resolveNext();
  await closeTask;
  assert.equal(DeferredHub.last.closed, true);
});
