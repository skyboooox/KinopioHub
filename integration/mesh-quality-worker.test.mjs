import assert from "node:assert/strict";
import test from "node:test";
import { createQualityWorker, wrapEvaluate } from "./mesh-quality-worker.mjs";

test("diagnostic wrapper calls evaluate once and returns the identical result", () => {
  let calls = 0; const result = { vote: "b", winner: "b", scores: new Map([["b", 0]]) };
  class Election { constructor() { this.id = "instance-a"; this.incumbent = "a"; this.incumbentSince = 0; this.challenger = null; this.rounds = 0; } evaluate() { calls++; this.rounds++; return result; } }
  const events = [], wrapper = wrapEvaluate(Election, event => events.push(event), { now: () => 9 });
  const election = new Election(), actual = election.evaluate([{ id: "a" }], 45_000);
  assert.equal(calls, 1); assert.equal(actual, result); assert.equal(events.length, 1);
  assert.deepEqual(events[0].result.scores, { b: 0 }); assert.equal(events[0].before.rounds, 0); assert.equal(events[0].after.rounds, 1);
  assert.throws(() => wrapEvaluate(Election, () => {}), /already wrapped/);
  wrapper.restore(); election.evaluate([], 0); assert.equal(calls, 2);
});

test("diagnostic overflow is explicit and emitted once", () => {
  class Election { constructor() { this.id = "a"; } evaluate() { return { vote: "a", padding: "x".repeat(200) }; } }
  const events = [], wrapper = wrapEvaluate(Election, event => events.push(event), { maxBytes: 1, now: () => 1 });
  const election = new Election(); election.evaluate([], 0); election.evaluate([], 1);
  assert.deepEqual(events.map(event => event.type), ["qualityDiagnosticOverflow"]); assert.equal(wrapper.stats().overflow, true); wrapper.restore();
});

test("diagnostic write failure cannot alter a successful election result", () => {
  const result = { vote: "a" }; class Election { constructor() { this.id = "a"; } evaluate() { return result; } }
  const wrapper = wrapEvaluate(Election, () => { throw Error("sink failed"); });
  assert.equal(new Election().evaluate([], 0), result); assert.equal(wrapper.stats().loggingError, "sink failed"); wrapper.restore();
});

test("terminal diagnostic write failure marks the worker failed without rejecting done", async () => {
  let resolveDone, failed = 0, writes = 0; const done = new Promise(resolve => { resolveDone = resolve; });
  class Election { constructor() { this.id = "a"; } evaluate() { return { vote: "a", scores: new Map([["a", 0]]) }; } }
  const studyModule = { async createStudyWorker() { new Election().evaluate([], 0); return { done, async close() {} }; } };
  const worker = await createQualityWorker({ sdkPath: "/tmp/sdk/src/node.mjs", studyWorkerPath: "/tmp/study.mjs", runId: "r", sourceId: "a", sourceIds: ["a"], policy: "Q", group: "g", namespace: "n" }, { electionModule: { MeshElection: Election }, studyModule, emit() { if (++writes > 1) throw Error("terminal sink failed"); }, markFailed() { failed++; } });
  resolveDone(); await worker.done; await new Promise(resolve => setImmediate(resolve));
  assert.equal(failed, 1);
});
