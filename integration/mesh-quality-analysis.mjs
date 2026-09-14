#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REQUIRED_PHASES = Object.freeze(["setup", "measurement", "reversal", "quiet"]);

export function validatePhaseTimeline(events) {
  const rows = events.filter(event => event.type === "phase"), errors = [];
  let previous = -Infinity;
  for (let index = 0; index < REQUIRED_PHASES.length; index++) {
    const matching = rows.filter(row => row.phase === REQUIRED_PHASES[index]);
    if (matching.length !== 1) { errors.push(`${REQUIRED_PHASES[index]} phase count is ${matching.length}`); continue; }
    const row = matching[0];
    if (!Number.isFinite(row.monoMs) || row.monoMs < previous) errors.push(`${row.phase} phase timestamp is invalid or out of order`);
    previous = row.monoMs;
  }
  const reversal = rows.find(row => row.phase === "reversal");
  if (reversal && (!Number.isFinite(reversal.switchStartedMonoMs) || !Number.isFinite(reversal.switchCompletedMonoMs) || reversal.switchCompletedMonoMs < reversal.switchStartedMonoMs || reversal.switchCompletedMonoMs - reversal.switchStartedMonoMs > 1000)) errors.push("reversal switch interval is invalid or exceeds 1 s");
  return { ok: errors.length === 0, errors, phases: Object.fromEntries(rows.map(row => [row.phase, row])) };
}

export function completedGapBounds(observations, windowStart, windowEnd) {
  const times = [...new Set(observations.map(row => row.monoMs).filter(value => Number.isFinite(value) && value >= windowStart && value <= windowEnd))].sort((a, b) => a - b);
  const completed = times.slice(1).map((value, index) => value - times[index]);
  return {
    completedMaximumMs: completed.length ? Math.max(...completed) : null,
    leftCensoredLowerBoundMs: times.length ? times[0] - windowStart : windowEnd - windowStart,
    rightCensoredLowerBoundMs: times.length ? windowEnd - times.at(-1) : windowEnd - windowStart,
    observationCount: times.length,
    interpretation: "completedMaximumMs is sampling-bounded and censored bounds are lower bounds, not propagation latency",
  };
}

function leaderHost(event, identities) { return identities[event.sdk?.mesh?.leaderId] ?? null; }
export function analyzeQualityRun(events, config) {
  const timeline = validatePhaseTimeline(events), failures = [];
  const fatal = events.filter(event => event.fatal || event.type === "qualityDiagnosticOverflow" || event.type === "malformedJsonl" || event.outputIntegrity === "incomplete");
  if (!timeline.ok) failures.push(...timeline.errors);
  if (fatal.length) failures.push("instrumentation is incomplete");
  if (events.some(event => event.type === "processExit" && event.expected !== true)) failures.push("an owned process exited unexpectedly");
  if (events.some(event => event.type === "networkValidation" && event.ok !== true)) failures.push("network validation failed");
  if (events.some(event => event.type === "preflight" && event.go !== true)) failures.push("preflight did not pass");
  const identities = config.instanceHosts ?? {};
  const statuses = events.filter(event => event.type === "status" && event.sdk?.connection === "connected" && event.sdk?.mesh);
  const reversalAt = timeline.phases.reversal?.switchCompletedMonoMs;
  const observationEnd = timeline.phases.quiet?.monoMs;
  const post = statuses.filter(event => Number.isFinite(reversalAt) && event.monoMs >= reversalAt && event.monoMs <= observationEnd);
  const final60Start = Number.isFinite(observationEnd) ? observationEnd - 60000 : Infinity;
  const finalHosts = post.filter(event => event.monoMs >= final60Start).map(event => leaderHost(event, identities)).filter(Boolean);
  const expectedFinal = config.policy === "Q" ? "b" : "a";
  const finalStable = finalHosts.length > 0 && finalHosts.every(host => host === expectedFinal);
  if (!finalStable) failures.push(`final 60 s did not remain on ${expectedFinal.toUpperCase()}`);
  let handoffAt = null;
  if (config.policy === "Q") handoffAt = post.find(event => leaderHost(event, identities) === "b")?.monoMs ?? null;
  if (config.policy === "Q" && (handoffAt === null || handoffAt - reversalAt > 120000)) failures.push("Q did not hand off to B within 120 s");
  const diagnostics = events.filter(event => event.type === "qualityEvaluation");
  const challenge = diagnostics.filter(event => event.monoMs >= reversalAt && event.result?.vote && event.result.vote !== event.before?.incumbent);
  if (config.policy === "Q" && !challenge.some(event => event.after?.rounds >= 3 && event.evaluationNow - event.before.incumbentSince >= 45000)) failures.push("no complete default-term three-round quality challenge was recorded");
  const functional = config.functional ?? {};
  if (functional.directedPairsFresh !== true || functional.finalAgreement !== true || functional.finalOwnerMatch !== true) failures.push("functional current-value evidence is incomplete");
  return { schema: "kinopio-mesh-quality-analysis/v1", runId: config.runId, policy: config.policy, evidenceValidity: failures.some(item => item.includes("instrumentation") || item.includes("network validation") || item.includes("preflight") || item.includes("phase")) ? "invalid" : "complete", outcome: failures.length ? "failed" : "passed", failures, timeline, handoffMs: handoffAt === null ? null : handoffAt - reversalAt, finalStable, diagnosticEvaluations: diagnostics.length };
}

export function analyzeCohort(runs) {
  const invalid = runs.filter(run => run.evidenceValidity !== "complete");
  const groups = [0, 1, 2].map(block => runs.filter(run => run.block === block + 1));
  const completeOrder = groups.every((rows, index) => rows.map(row => row.policy).join(",") === [["Q", "S"], ["S", "Q"], ["Q", "S"]][index].join(","));
  const passed = invalid.length === 0 && completeOrder && runs.length === 6 && runs.every(run => run.outcome === "passed");
  return { schema: "kinopio-mesh-quality-cohort/v1", verdict: invalid.length || !completeOrder || runs.length !== 6 ? "instrumentation-invalid" : passed ? "repeated-quality-reversal" : "negative-mechanism-result", runs: runs.length, invalidRuns: invalid.map(run => run.runId), completeOrder };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 6 || process.argv[2] !== "--input" || process.argv[4] !== "--output") throw Error("usage: mesh-quality-analysis.mjs --input RUN.jsonl --output ANALYSIS.json");
  const events = (await fs.readFile(path.resolve(process.argv[3]), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const configuration = events.find(event => event.type === "configuration")?.configuration;
  if (!configuration) throw Error("configuration event is missing");
  await fs.writeFile(path.resolve(process.argv[5]), JSON.stringify(analyzeQualityRun(events, configuration), null, 2), { flag: "wx" });
}
