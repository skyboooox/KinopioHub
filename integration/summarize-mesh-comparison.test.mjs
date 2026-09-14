import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { computeReceiverStreams, evaluateContrast, summarizeMeshComparison } from "./summarize-mesh-comparison.mjs";

const ids = ["a", "b", "c"];
const version = seq => ({ counter: String(seq), writer: "fixture" });
async function json(filename, value) { await fs.writeFile(filename, `${JSON.stringify(value, null, 2)}\n`); }
async function jsonl(filename, events, malformed = "") { await fs.writeFile(filename, `${events.map(event => JSON.stringify(event)).join("\n")}\n${malformed}`); }

function phaseEvents(runId, receiver) {
  return [
    ["measurementStart", 0], ["baselineEnd", 200], ["postfaultStart", 300], ["measurementEnd", 1000],
  ].flatMap(([phase, monoMs], index) => {
    const id = `${receiver}-phase-${index}`;
    const marker = { type: "phaseMarker", phase, id, runId, sourceId: receiver, monoMs };
    const boundary = phase === "measurementStart" ? [{ type: "observationWindowStarted", phase, id, runId, sourceId: receiver, monoMs }] : phase === "measurementEnd" ? [{ type: "observationWindowEnded", phase, id, runId, sourceId: receiver, monoMs }] : [];
    return [marker, ...boundary, { type: "command", id, op: "mark", ok: true, result: { phase, monoMs }, monoMs }];
  });
}

function finalValues(runId) {
  return Array.from({ length: 64 }, (_, key) => {
    const source = ids[key % ids.length], seq = key + 100;
    return { key, value: { run: runId, source, seq, key, data: "x".repeat(64) }, meta: { version: version(seq), exists: true } };
  });
}

async function makeRun(root, { runId = "run-S", policy = "S", block = 1, functionalPass = true, malformedHost = null, badCleanupHost = null } = {}) {
  const directory = path.join(root, runId); await fs.mkdir(directory);
  const harnessBytes = "fixture worker source\n", harnessHash = createHash("sha256").update(harnessBytes).digest("hex");
  await fs.mkdir(path.join(directory, "harness")); await fs.writeFile(path.join(directory, "harness", "mesh-study-worker.mjs"), harnessBytes);
  const hosts = ids.map(id => ({ id, sdkBase: "/sdk/base", sdkPolicy: { S: "/sdk/S", Q: "/sdk/Q" }, binarySha256: `binary-${id}` }));
  const configuration = { runId, block, policy, hosts, fault: "broker-kill" };
  await json(path.join(directory, "configuration.json"), configuration);
  const closed = id => ({ type: "closed", runId, sourceId: id, outputIntegrity: badCleanupHost === id ? "incomplete" : "complete", outputEventsDropped: 0, outputEventsDroppedTotal: badCleanupHost === id ? 1 : 0, fatal: badCleanupHost === id });
  const result = {
    schema: "kinopio-controlled-mesh-comparison/v1", runId, policy, outcome: functionalPass ? "passed" : "failed", functionalFailures: functionalPass ? [] : [{ stage: "postfault", message: "fresh data did not recover" }],
    harnessHashes: { "mesh-study-worker.mjs": harnessHash }, runtime: { node: "v24.11.0", expectedFiles: { worker: harnessHash } },
    postfaultThresholds: { a: 0, b: 0, c: 0 },
    postfaultEvidence: { completed: true, connectedEndpointStableAtLeastOnce: true, connectedEndpointStableAtWindowEnd: true, directedPairsEverSimultaneouslyFresh: functionalPass, directedPairsFreshAtWindowEnd: functionalPass },
    phases: Object.fromEntries(["measurementStart", "baselineEnd", "postfaultStart", "measurementEnd"].map((phase, phaseIndex) => [phase, ids.map(receiver => ({ phase, monoMs: [0, 200, 300, 1000][phaseIndex], commandId: `${receiver}-phase-${phaseIndex}` }))])),
    fault: { host: "a", acknowledgement: { result: { commandId: "fault-1", brokerPid: 41 } } },
    instrumentation: { workers: ids.map(id => ({ id, exited: true, exitCode: 0, exitSignal: null, closedEvent: closed(id) })), supervisors: [] },
  };
  await json(path.join(directory, "result.json"), result);
  await jsonl(path.join(directory, "controller.jsonl"), ids.map(host => ({ type: "workerExit", host, code: 0, signal: null })));
  const values = finalValues(runId);
  for (const receiver of ids) {
    const events = [{ type: "ready", runId, sourceId: receiver, policy, runtime: { sdkPath: `/sdk/${policy}/src/node.mjs`, node: "v24.11.0", provenance: { files: { worker: { sha256: harnessHash } }, meshBinary: { sha256: `binary-${receiver}` } } } }, ...phaseEvents(runId, receiver)];
    for (const source of ids.filter(id => id !== receiver)) for (const [seq, monoMs] of [[1, 50], [2, 400], [3, 700], [4, 950]]) events.push({ type: "observation", runId, receiver, sourceId: source, key: ids.indexOf(source), seq, monoMs });
    for (let key = 0; key < 64; key++) if (ids[key % ids.length] === receiver) events.push({ type: "write", accepted: true, runId, sourceId: receiver, key, seq: key + 100, version: version(key + 100), monoMs: 800 + key / 100 });
    if (receiver === "a") events.push({ type: "command", id: "fault-1", op: "killBroker", ok: true, result: { brokerPid: 41 }, monoMs: 250 });
    events.push({ type: "snapshot", id: `${receiver}-final`, runId, sourceId: receiver, values, monoMs: 1100 }, closed(receiver));
    await jsonl(path.join(directory, `${receiver}.jsonl`), events, malformedHost === receiver ? "{bad\n" : "");
  }
  return directory;
}

async function protocol(root, arms = ["S"]) {
  const plan = path.join(root, "plan.json"), amendment = path.join(root, "amendment.json");
  await json(plan, { schema: "plan/v1", blocks: [{ block: 1, arms }] });
  await json(amendment, { schema: "amendment/v1", status: "before data" });
  return { plan, amendment };
}

test("fault-straddling observations remain one completed gap across rotating keys", () => {
  const runId = "fault-gap", receiver = "a";
  const events = [...phaseEvents(runId, receiver),
    { type: "observation", runId, receiver, sourceId: "b", key: 1, seq: 10, monoMs: 150 },
    { type: "observation", runId, receiver, sourceId: "b", key: 4, seq: 11, monoMs: 650 },
    { type: "observation", runId, receiver, sourceId: "b", key: 4, seq: 11, monoMs: 651 },
    { type: "observation", runId, receiver, sourceId: "b", key: 7, seq: 12, monoMs: 900 }];
  const stream = computeReceiverStreams(events, receiver, [receiver, "b"])[0];
  assert.equal(stream.maximumObservedSilenceMs, 500);
  assert.equal(stream.boundaryDeterminesOrTiesMaximum, false);
  assert.equal(stream.faultStraddlingCompletedGaps.length, 1);
  assert.deepEqual(stream.faultStraddlingCompletedGaps[0].from, { monoMs: 150, key: 1, seq: 10 });
  assert.equal(stream.duplicateEventsRemoved, 1);
});

test("a boundary-censored stall determining the run maximum is not numerically eligible", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "comparison-boundary-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { plan, amendment } = await protocol(root); await makeRun(root);
  const filename = path.join(root, "run-S", "a.jsonl"), lines = (await fs.readFile(filename, "utf8")).trim().split("\n").map(JSON.parse);
  const filtered = lines.filter(event => !(event.type === "observation" && event.sourceId === "b"));
  filtered.push({ type: "observation", runId: "run-S", receiver: "a", sourceId: "b", key: 1, seq: 9, monoMs: 100 });
  await jsonl(filename, filtered);
  const run = (await summarizeMeshComparison(root, plan, amendment)).runs[0];
  assert.equal(run.metric.maximumObservedSilenceMs, 900);
  assert.equal(run.metric.boundaryCensoredMaximum, true);
  assert.equal(run.metric.numericEligible, false);
  assert.ok(run.metric.indeterminateReasons.some(reason => reason.includes("censored boundary")));
});

test("malformed evidence and cleanup failures are reported separately from functional failures", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "comparison-invalid-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { plan, amendment } = await protocol(root); await makeRun(root, { malformedHost: "a", badCleanupHost: "b" });
  const run = (await summarizeMeshComparison(root, plan, amendment)).runs[0];
  assert.equal(run.evidenceValidity.status, "invalid");
  assert.ok(run.evidenceValidity.instrumentationIssues.some(reason => reason.includes("malformed")));
  assert.ok(run.evidenceValidity.cleanupIssues.some(reason => reason.includes("b closed")));
  assert.equal(run.functionalOutcome.status, "passed");
});

test("a genuinely evidence-valid functional failure remains a functional failure", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "comparison-functional-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { plan, amendment } = await protocol(root); await makeRun(root, { functionalPass: false });
  const run = (await summarizeMeshComparison(root, plan, amendment)).runs[0];
  assert.equal(run.evidenceValidity.status, "verified");
  assert.equal(run.functionalOutcome.status, "failed");
  assert.equal(run.metric.numericEligible, false);
});

test("development screens apply both thresholds in the same block and publish all differences", () => {
  const run = (block, policy, max, status = "passed") => ({ runId: `${block}-${policy}`, block, policy, functionalOutcome: { status }, metric: { maximumObservedSilenceMs: max, numericEligible: true } });
  const runs = [run(1, "S", 1000), run(1, "Q", 400), run(2, "S", 2000), run(2, "Q", 1450), run(3, "S", 1000), run(3, "Q", 900)];
  const contrast = evaluateContrast(runs, "Q", "S");
  assert.equal(contrast.verdict, "passes-development-screen");
  assert.deepEqual(contrast.thresholdBlocks, [1, 2]);
  assert.deepEqual(contrast.differences.map(row => row.absoluteImprovementMs), [600, 550, 100]);
  runs.find(row => row.block === 3 && row.policy === "Q").functionalOutcome.status = "failed";
  assert.equal(evaluateContrast(runs, "Q", "S").verdict, "indeterminate");
  assert.equal(evaluateContrast(runs, "Q", "F-R", true).verdict, "descriptive-only");
});
