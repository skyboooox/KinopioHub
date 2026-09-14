import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCohort, analyzeQualityRun, completedGapBounds, validatePhaseTimeline } from "./mesh-quality-analysis.mjs";

const phases = [
  { type: "phase", phase: "setup", monoMs: 1 }, { type: "phase", phase: "measurement", monoMs: 60_001 },
  { type: "phase", phase: "reversal", monoMs: 120_501, switchStartedMonoMs: 120_000, switchCompletedMonoMs: 120_501 },
  { type: "phase", phase: "quiet", monoMs: 300_501 },
];

test("phase order and non-atomic switch duration are validity gates", () => {
  assert.equal(validatePhaseTimeline(phases).ok, true);
  assert.match(validatePhaseTimeline(phases.map(row => row.phase === "reversal" ? { ...row, switchCompletedMonoMs: 121_500 } : row)).errors.join(), /exceeds 1 s/);
  assert.match(validatePhaseTimeline(phases.filter(row => row.phase !== "measurement")).errors.join(), /measurement phase count/);
});

test("gap metric preserves both censored lower bounds", () => {
  assert.deepEqual(completedGapBounds([{ monoMs: 20 }, { monoMs: 50 }], 0, 100), { completedMaximumMs: 30, leftCensoredLowerBoundMs: 20, rightCensoredLowerBoundMs: 50, observationCount: 2, interpretation: "completedMaximumMs is sampling-bounded and censored bounds are lower bounds, not propagation latency" });
});

test("analysis refuses a green result when instrumentation or functional evidence fails", () => {
  const events = [...phases, { type: "preflight", go: true }, { type: "qualityDiagnosticOverflow", fatal: true }];
  const run = analyzeQualityRun(events, { runId: "q1", policy: "Q", functional: { directedPairsFresh: true, finalAgreement: true, finalOwnerMatch: true } });
  assert.equal(run.evidenceValidity, "invalid"); assert.equal(run.outcome, "failed");
});

test("cohort requires all six frozen block positions and never turns 2/3 into success", () => {
  const policies = ["Q", "S", "S", "Q", "Q", "S"];
  const runs = policies.map((policy, index) => ({ runId: `r${index}`, policy, block: Math.floor(index / 2) + 1, evidenceValidity: "complete", outcome: "passed" }));
  assert.equal(analyzeCohort(runs).verdict, "repeated-quality-reversal");
  runs[0].outcome = "failed"; assert.equal(analyzeCohort(runs).verdict, "negative-mechanism-result");
  runs[0].evidenceValidity = "invalid"; assert.equal(analyzeCohort(runs).verdict, "instrumentation-invalid");
});
