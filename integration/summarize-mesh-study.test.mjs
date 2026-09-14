import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { summarizeMeshStudy } from "./summarize-mesh-study.mjs";

async function json(filename, value) { await fs.writeFile(filename, JSON.stringify(value)); }
async function jsonl(filename, values) { await fs.writeFile(filename, values.map(value => JSON.stringify(value)).join("\n") + "\n"); }

test("summarizer pools rotating keys per receiver/source and preserves failed or dropped runs", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-summary-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const complete = path.join(root, "run-S"), failed = path.join(root, "run-F"); await fs.mkdir(complete); await fs.mkdir(failed);
  await json(path.join(complete, "configuration.json"), { policy: "S", runId: "run-S", hosts: [{ id: "a" }, { id: "b" }] });
  await json(path.join(complete, "result.json"), { runId: "run-S", policy: "S", outcome: "passed", checks: ["pilot"], harnessHashes: { worker: "hash-a" } });
  await jsonl(path.join(complete, "controller.jsonl"), [{ type: "writesStarted", monoMs: 0 }, { type: "brokerKilled", monoMs: 100, host: "a" }, { type: "reconnected", monoMs: 60100 }, { type: "writesStopped", monoMs: 70000 }]);
  const ready = { type: "ready", sourceId: "a", runtime: { provenance: { files: { node: { sha256: "x" } } } } };
  await jsonl(path.join(complete, "a.jsonl"), [
    ready,
    { type: "status", monoMs: 1, sdk: { connection: "connected", mesh: { leaderId: null, role: "discovering" } }, resources: { worker: { memory: { rss: 10 }, cpuPercent: 2 } } },
    { type: "write", accepted: true }, { type: "write", accepted: true }, { type: "write", accepted: false },
    { type: "observation", sourceId: "b", seq: 1, key: 1, monoMs: 10 },
    { type: "observation", sourceId: "b", seq: 2, key: 3, monoMs: 210 },
    { type: "observation", sourceId: "b", seq: 3, key: 5, monoMs: 410 },
    { type: "observation", sourceId: "b", seq: 4, key: 7, monoMs: 1810 },
    { type: "status", monoMs: 2000, sdk: { connection: "connected", mesh: { leaderId: "one", role: "leader" } }, resources: { worker: { memory: { rss: 20 }, cpuPercent: 4 } } },
    { type: "status", monoMs: 3000, sdk: { connection: "connected", mesh: { leaderId: "two", role: "follower" } }, resources: { worker: { memory: { rss: 15 }, cpuPercent: 3 } } },
    { type: "closed", outputEventsDroppedTotal: 2, fatal: true },
  ]);
  await jsonl(path.join(complete, "b.jsonl"), [{ type: "ready", sourceId: "b" }, { type: "error", operation: "fixture", error: { message: "failed" } }]);

  await json(path.join(failed, "configuration.json"), { policy: "F", runId: "run-F", hosts: [{ id: "a" }] });
  await json(path.join(failed, "result.json"), { runId: "run-F", policy: "F", outcome: "failed", error: "ESP32 did not obtain current desktop state", harnessHashes: { worker: "hash-b" } });
  await jsonl(path.join(failed, "controller.jsonl"), [{ type: "failed", error: "ESP32 did not obtain current desktop state" }]);
  await jsonl(path.join(failed, "a.jsonl"), [{ type: "ready", sourceId: "a", runtime: { provenance: { files: {} } } }, { type: "closed", outputEventsDroppedTotal: 0 }]);

  const summary = await summarizeMeshStudy(root, { schema: "fixture/v1", source: "fixture", runs: { "run-F": { classification: "harness failure", knownHarnessIssues: ["F early acquisition assertion bug"] } } });
  assert.deepEqual(summary.runIds.sort(), ["run-F", "run-S"]);
  assert.equal(summary.harnessGroups.length, 2);
  const s = summary.runs.find(run => run.runId === "run-S"), stream = s.workers.find(worker => worker.receiver === "a").observationStreams[0];
  assert.deepEqual(stream.gaps, { n: 3, minMs: 200, medianMs: 200, maxMs: 1400, gapsOver1000Ms: 1 });
  assert.equal(stream.distinctKeys, 4);
  assert.equal(stream.window.headAndTailExcluded, true);
  assert.equal(stream.window.truncated, false);
  assert.deepEqual(stream.terminalSilence, {
    status: "unknown",
    durationMs: null,
    lowerBoundMs: null,
    censored: true,
    reason: "No complete receiver-local observation-window boundaries are recorded; controller and worker monotonic clocks are not combined.",
  });
  assert.equal(s.eventTotals.writesAccepted, 2);
  assert.equal(s.eventTotals.writesRejected, 1);
  assert.equal(s.controllerRecovery.killedToRequiredStabilizationCompleteMs, 60000);
  assert.match(s.controllerRecovery.interpretation, /not failover latency/);
  assert.equal(s.workers.find(worker => worker.receiver === "a").leaderChanges.length, 2);
  assert.equal(s.workers.find(worker => worker.receiver === "a").logging.fatal, true);
  assert.equal(s.evidenceValidity.status, "invalid");
  assert.ok(s.evidenceValidity.invalidReasons.includes("a reported dropped output events"));
  assert.ok(s.evidenceValidity.invalidReasons.includes("b worker error or failed command event present"));
  assert.ok(s.knownHarnessIssues.includes("missing runtime provenance in early Q harness") === false);
  const f = summary.runs.find(run => run.runId === "run-F");
  assert.equal(f.outcome, "failed");
  assert.ok(f.knownHarnessIssues.includes("F early acquisition assertion bug"));
  assert.equal(f.annotation.classification, "harness failure");
  assert.equal(f.workers[0].observationStreams.length, 0);
});

test("a provisional controller pass cannot become a verified pass after incomplete or failed cleanup", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-summary-incomplete-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await json(path.join(root, "configuration.json"), { policy: "Q", runId: "purported-pass", hosts: [{ id: "a", binarySha256: "binary-a" }] });
  await jsonl(path.join(root, "controller.jsonl"), [
    { type: "writesStarted", monoMs: 0 },
    { type: "writesStopped", monoMs: 10 },
    { type: "passed", monoMs: 20 },
    { type: "workerExit", host: "a", code: 1, signal: null, monoMs: 30 },
  ]);
  await fs.appendFile(path.join(root, "controller.jsonl"), "{truncated\n");
  await jsonl(path.join(root, "a.jsonl"), [
    { type: "ready", runId: "purported-pass", sourceId: "a", policy: "Q", runtime: { provenance: { files: { worker: { sha256: "worker" } }, meshBinary: { sha256: "binary-a" } } } },
    { type: "closed", runId: "purported-pass", sourceId: "a", outputIntegrity: "complete", outputEventsDropped: 0, outputEventsDroppedTotal: 0, fatal: false },
  ]);
  await fs.appendFile(path.join(root, "a.jsonl"), "{truncated\n");

  const run = (await summarizeMeshStudy(root)).runs[0];
  assert.equal(run.outcome, "incomplete");
  assert.equal(run.functionalOutcome.controllerPassed, true);
  assert.equal(run.functionalOutcome.source, "unavailable");
  assert.equal(run.evidenceValidity.verified, false);
  assert.equal(run.evidenceValidity.status, "invalid");
  assert.ok(run.evidenceValidity.incompleteReasons.some(reason => reason.startsWith("result.json missing")));
  assert.ok(run.evidenceValidity.incompleteReasons.some(reason => reason.includes("malformed line")));
  assert.ok(run.evidenceValidity.incompleteReasons.includes("a worker stream has 1 malformed line(s)"));
  assert.ok(run.evidenceValidity.invalidReasons.includes("a worker exited unsuccessfully"));
});

test("an unrecovered stream is retained as receiver-local right-censored evidence", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-summary-censored-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = "unrecovered", hash = "worker-hash";
  const closed = id => ({ type: "closed", runId, sourceId: id, outputIntegrity: "complete", outputEventsDropped: 0, outputEventsDroppedTotal: 0, fatal: false });
  await json(path.join(root, "configuration.json"), { policy: "S", runId, hosts: [{ id: "a", binarySha256: "binary-a" }, { id: "b", binarySha256: "binary-b" }] });
  await json(path.join(root, "result.json"), {
    runId, policy: "S", outcome: "failed", error: "stream b was not recovered", expectedSourceHashes: { worker: hash }, harnessHashes: { worker: hash },
    cleanup: [
      { id: "a", exited: true, exitCode: 0, exitSignal: null, closedEvent: closed("a") },
      { id: "b", exited: true, exitCode: 0, exitSignal: null, closedEvent: closed("b") },
    ],
  });
  await jsonl(path.join(root, "controller.jsonl"), [
    { type: "writesStarted", monoMs: 0 }, { type: "writesStopped", monoMs: 10 }, { type: "failed", monoMs: 20, error: "stream b was not recovered" },
    { type: "workerExit", host: "a", code: 0, signal: null }, { type: "workerExit", host: "b", code: 0, signal: null },
  ]);
  const ready = (id, binary) => ({ type: "ready", runId, sourceId: id, policy: "S", runtime: { provenance: { files: { worker: { sha256: hash } }, meshBinary: { sha256: binary } } } });
  await jsonl(path.join(root, "a.jsonl"), [ready("a", "binary-a"), { type: "observationWindowStarted", monoMs: 100 }, { type: "observationWindowEnded", monoMs: 1100 }, closed("a")]);
  await jsonl(path.join(root, "b.jsonl"), [ready("b", "binary-b"), { type: "observationWindowStarted", monoMs: 200 }, { type: "observation", sourceId: "a", seq: 1, key: 1, monoMs: 600 }, { type: "observationWindowEnded", monoMs: 1200 }, closed("b")]);

  const run = (await summarizeMeshStudy(root)).runs[0];
  assert.equal(run.outcome, "failed");
  assert.equal(run.evidenceValidity.status, "verified");
  const unrecovered = run.workers.find(worker => worker.receiver === "a").observationStreams.find(stream => stream.source === "b");
  assert.equal(unrecovered.observationEvents, 0);
  assert.deepEqual(unrecovered.terminalSilence, {
    status: "right-censored", durationMs: null, lowerBoundMs: 1000, censored: true,
    reason: "No observation was recorded within the explicitly bounded receiver-local window.",
  });
  const recovered = run.workers.find(worker => worker.receiver === "b").observationStreams.find(stream => stream.source === "a");
  assert.deepEqual(recovered.terminalSilence, {
    status: "right-censored", durationMs: null, lowerBoundMs: 600, censored: true,
    reason: "The elapsed silence is a lower bound on the next-observation gap because no subsequent observation is recorded at the explicit receiver-local window end.",
  });
  assert.match(run.evidenceValidity.note, /prerequisite only/);
});

test("non-object result and configuration JSON are reported instead of causing property-access failures", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mesh-summary-metadata-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "result.json"), "null\n");
  await fs.writeFile(path.join(root, "configuration.json"), "[]\n");
  await jsonl(path.join(root, "controller.jsonl"), [{ type: "failed", error: "invalid fixture" }]);

  const summary = await summarizeMeshStudy(root), run = summary.runs[0];
  assert.equal(run.outcome, "failed");
  assert.equal(run.evidenceValidity.status, "incomplete");
  assert.ok(run.evidenceValidity.incompleteReasons.includes("result.json invalid top-level JSON value (expected object)"));
  assert.ok(run.evidenceValidity.incompleteReasons.includes("configuration.json invalid top-level JSON value (expected object)"));
});
