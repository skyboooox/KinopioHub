import assert from "node:assert/strict";
import test from "node:test";
import { assessFixedDrain, assessPreflight, assessScoreGate, DRAIN_GRACE_MS, namespaceWorkerArgv, parseBoundedJsonlLine, validateRunnerConfig } from "./mesh-quality-runner.mjs";

const runtime = { node: "/runtime/node", sdkDir: "/runtime/sdk", natsBinary: "/runtime/nats", studyWorker: "/runtime/study.mjs", qualityWorker: "/runtime/quality.mjs", policyAdapter: "/runtime/policy.mjs", probes: "/runtime/probes.mjs" };
const expectedHashes = Object.fromEntries(["node", "natsBinary", "meshElection", "meshNode", "meshBroker", "hub", "packageLock", "studyWorker", "qualityWorker", "policyAdapter", "network", "controller", "probes", "runner", "analysis"].map(key => [key, "a".repeat(64)]));
const base = { mode: "run", policy: "Q", runId: "quality_q_1", outputRoot: "/output", runtime, expectedHashes, network: { owner: "q1", subnetPrefix: "10.88.1." } };

test("runner freezes timing, hashes, paths, and namespace management argv", () => {
  const config = validateRunnerConfig(base), argv = namespaceWorkerArgv(config, "b", "/output/b.json");
  assert.deepEqual(argv.slice(0, 4), ["ip", "netns", "exec", "mqq1b"]); assert.equal(argv.at(-1), "/output/b.json");
  assert.throws(() => validateRunnerConfig({ ...base, timing: { baselineMs: 1 } }), /timing is fixed/);
  assert.throws(() => validateRunnerConfig({ ...base, expectedHashes: { ...expectedHashes, runner: "bad" } }), /SHA-256/);
});

test("preflight requires transport paths and ten consecutive score-margin rounds in both phases", () => {
  const evaluations = ["initial", "reversed"].flatMap(phase => ["view-a", "view-b", "view-c"].flatMap(instanceId => Array.from({ length: 10 }, () => ({ phase, instanceId, scores: phase === "initial" ? { a: 0, b: .09, c: .09 } : { a: .09, b: 0, c: .09 }, coverage: "3/3", loss: 0, timeouts: 0 }))));
  const drain = assessFixedDrain({ graceMs: DRAIN_GRACE_MS, elapsedMs: 1001, processesExited: true, pidsBefore: { ok: true }, pidsAfter: { ok: true }, counters: { parserOk: true, completeStats: true, drops: 0, drained: true } });
  const evidence = { hostIds: ["ha", "hb", "hc"], namespaceInterfaces: true, noExternalRoutes: true, uniqueAliases: true, packetPaths: { allSixDirections: true, udp: true, http: true, tcp: true, unaffectedPairsClean: true }, switchCounters: { parserOk: true, completeStats: true, filtersPresent: true, classified: true, drops: 0, activeOccupancy: { backlogBytes: 1512, qlen: 1 } }, drain, evaluations, endpointNormalization: true, writerSequenceAndVersion: true, postReversalState: { ok: true }, instrumentationIntegrity: true, ownedCleanup: true };
  assert.equal(assessPreflight(evidence).go, true);
  assert.equal(assessScoreGate(evaluations.filter(row => row.instanceId !== "view-c"), "initial").ok, false);
  evidence.packetPaths.tcp = false; assert.equal(assessPreflight(evidence).go, false);
});

test("fixed drain rejects a sender still alive and nonzero terminal leaves", () => {
  const baseDrain = { graceMs: 1000, elapsedMs: 1000, processesExited: true, pidsBefore: { ok: true }, pidsAfter: { ok: true }, counters: { parserOk: true, completeStats: true, drops: 0, drained: true } };
  assert.equal(assessFixedDrain(baseDrain).ok, true);
  assert.equal(assessFixedDrain({ ...baseDrain, elapsedMs: 999 }).ok, false);
  assert.equal(assessFixedDrain({ ...baseDrain, pidsBefore: { ok: false, entries: [{ pids: [42] }] } }).ok, false);
  assert.equal(assessFixedDrain({ ...baseDrain, counters: { parserOk: true, completeStats: true, drops: 0, drained: false } }).ok, false);
});

test("worker JSONL rejects malformed, oversized, and typeless commands", () => {
  assert.deepEqual(parseBoundedJsonlLine('{"type":"ready"}'), { type: "ready" });
  assert.throws(() => parseBoundedJsonlLine("{"), /malformed/);
  assert.throws(() => parseBoundedJsonlLine('{"x":1}'), /contain type/);
  assert.throws(() => parseBoundedJsonlLine('{"type":"x"}', 2), /bound/);
});
