import assert from "node:assert/strict";
import test from "node:test";
import { buildNetworkPlan } from "./mesh-quality-network.mjs";
import { evaluateSnapshotQuorum, NetnsQualityController, parseTcInspection, summarizeTcEvidence } from "./mesh-quality-controller.mjs";

test("controller normalizes candidate instance scores to physical A/B/C views", () => {
  const controller = new NetnsQualityController(); controller.phase = "initial"; controller.addresses = { a: "10.0.0.1", b: "10.0.0.2", c: "10.0.0.3" };
  const members = ["a", "b", "c"].map((id, index) => ({ id: `i${id}`, address: id === "a" ? "127.0.0.1" : `10.0.0.${index + 1}`, observations: Object.fromEntries(["a", "b", "c"].filter(other => other !== id).map(other => [`i${other}`, { rtt: 1, loss: 0 }])) }));
  const row = controller.normalizeEvaluation({ instanceId: "ia", members, result: { scores: { ia: 0, ib: .09, ic: .1 } }, }, "a");
  assert.deepEqual(row.scores, { a: 0, b: .09, c: .1 }); assert.equal(row.coverage, "3/3"); assert.equal(row.timeouts, 0);
});

test("RTT matrix rejects a delayed-pair miss or collateral delay", () => {
  const controller = new NetnsQualityController();
  const good = [{ phase: "initial", source: "b", target: "c", rttMs: 120 }, { phase: "initial", source: "a", target: "b", rttMs: 2 }, { phase: "reversed", source: "a", target: "c", rttMs: 120 }, { phase: "reversed", source: "b", target: "c", rttMs: 2 }];
  assert.equal(controller.validateRttMatrix(good), true); assert.equal(controller.validateRttMatrix(good.map((row, index) => index === 0 ? { ...row, rttMs: 2 } : row)), false);
});

const network = { owner: "counter", subnetPrefix: "10.8.1." };
function tcEntries(backlog = 0, malformed = false) {
  const plan = buildNetworkPlan(network), entries = [];
  for (const receiver of ["a", "b", "c"]) {
    const dev = plan.config.names.switchVeth[receiver], argv = ["ip", "netns", "exec", plan.config.names.switch, "tc", "-s", "-j", "qdisc", "show", "dev", dev];
    const rows = [{ kind: "prio", handle: "1:", packets: 60, drops: 0, backlog: backlog * 3, qlen: 3 }, ...[1, 2, 3].map(band => ({ kind: "netem", handle: `${9 + band}:`, parent: `1:${band}`, packets: 10, drops: 0, backlog, qlen: backlog ? 1 : 0 }))];
    const entry = { argv, stdout: malformed && receiver === "a" ? "{" : JSON.stringify(rows) }; entry.parser = parseTcInspection(entry); entries.push(entry);
    const filter = { argv: ["tc", "-j", "filter", "show", "dev", dev], stdout: JSON.stringify([{ kind: "u32" }]) }; filter.parser = parseTcInspection(filter); entries.push(filter);
  }
  return { plan, entries };
}

test("tc evidence retains raw rows and counts leaf occupancy once", () => {
  const active = tcEntries(504), summary = summarizeTcEvidence(active.entries, active.plan);
  assert.equal(active.entries[0].stdout.includes('"prio"'), true); assert.equal(summary.parserOk, true); assert.equal(summary.completeStats, true); assert.equal(summary.filtersPresent, true);
  assert.equal(summary.activeOccupancy.backlogBytes, 9 * 504); // Parent backlog is deliberately excluded.
  assert.equal(summary.drops, 0); assert.equal(summary.classified, true);
  const drained = tcEntries(0); assert.equal(summarizeTcEvidence(drained.entries, drained.plan, { drain: true }).drained, true);
});

test("missing or malformed tc evidence cannot pass counter parsing", () => {
  const malformed = tcEntries(0, true), summary = summarizeTcEvidence(malformed.entries, malformed.plan, { drain: true });
  assert.equal(summary.parserOk, false); assert.ok(summary.parserFailures.length); assert.ok(summary.missingLeaves.length);
  assert.equal(summary.drained, false);
});

test("post-reversal quorum rejects stale and missing snapshots", () => {
  const workers = new Map(["a", "b", "c"].map(id => [id, { events: [] }]));
  const values = Array.from({ length: 64 }, (_, key) => { const source = ["a", "b", "c"][key % 3], value = { run: "run", source, key, seq: key + 1, data: "x".repeat(64) }, version = { counter: String(key + 1), writer: source }; workers.get(source).events.push({ type: "write", accepted: true, key, seq: key + 1, version }); return { key, value, meta: { exists: true, version } }; });
  const snapshots = ["a", "b", "c"].map(nodeId => ({ nodeId, controllerReceiptMonoMs: 200, snapshot: { values: structuredClone(values) } }));
  const current = { label: "post-reversal", capturedMonoMs: 200, snapshots };
  assert.equal(evaluateSnapshotQuorum(current, workers, "run", 100).ok, true);
  assert.equal(evaluateSnapshotQuorum({ ...current, capturedMonoMs: 50 }, workers, "run", 100).ok, false);
  assert.equal(evaluateSnapshotQuorum({ ...current, snapshots: snapshots.map((item, index) => index ? item : { ...item, controllerReceiptMonoMs: 50 }) }, workers, "run", 100).ok, false);
  assert.equal(evaluateSnapshotQuorum({ ...current, snapshots: snapshots.slice(0, 2) }, workers, "run", 100).ok, false);
  const corrupt = structuredClone(current); corrupt.snapshots[0].snapshot.values[0].value.data = "corrupt"; assert.equal(evaluateSnapshotQuorum(corrupt, workers, "run", 100).ok, false);
  const deleted = structuredClone(current); deleted.snapshots[0].snapshot.values[0].meta.exists = false; assert.equal(evaluateSnapshotQuorum(deleted, workers, "run", 100).ok, false);
});

test("inspectNetwork persists malformed raw tc output before rejecting the phase", async () => {
  const plan = buildNetworkPlan(network), emitted = [];
  const controller = new NetnsQualityController({ executeArgv: async argv => ({ argv, stdout: argv.includes("qdisc") ? "{" : "[]", stderr: "", code: 0 }) });
  controller.plan = plan; controller.emit = async event => emitted.push(event);
  await assert.rejects(controller.inspectNetwork("initial", "before"), /parse failed/); await controller.writeChain;
  const failure = emitted.find(event => event.type === "networkInspection" && event.parser?.ok === false);
  assert.equal(failure.stdout, "{"); assert.equal(failure.phase, "initial"); assert.equal(failure.point, "before"); assert.ok(failure.completeMonoMs >= failure.requestMonoMs);
});

test("ingest stamps controller receipt without replacing source monotonic time", () => {
  const controller = new NetnsQualityController(), source = { type: "status", monoMs: 12 };
  const received = controller.record(source); assert.equal(received.monoMs, 12); assert.ok(received.controllerReceiptMonoMs >= 0); assert.equal(source.controllerReceiptMonoMs, undefined);
});
