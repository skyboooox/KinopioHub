#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { buildNetworkPlan, cleanupOwnedNetwork, createOwnedNetwork, inspectOwnedNamespacePids, runCommands, validatePairFilterCoverage, validateSandboxIsolation, writeOwnershipManifest } from "./mesh-quality-network.mjs";
import { NetnsQualityController } from "./mesh-quality-controller.mjs";

export const FORMAL_ORDER = Object.freeze([["Q", "S"], ["S", "Q"], ["Q", "S"]]);
export const TIMING = Object.freeze({ setupTimeoutMs: 240000, initialStableMs: 60000, baselineMs: 60000, postReversalMs: 180000, quietMs: 30000, cleanupMs: 30000, runHardLimitMs: 540000, cohortHardLimitMs: 3600000 });
export const APPARATUS_REVISION = "2026-09-09-r3";
export const DRAIN_GRACE_MS = 1000;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function absolute(value, label) { if (typeof value !== "string" || !path.isAbsolute(value)) throw Error(`${label} must be an absolute path`); return value; }
function id(value, label) { if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw Error(`${label} must be a safe identifier`); return value; }

export function validateRunnerConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("config must be an object");
  const mode = raw.mode ?? "preflight";
  if (!["preflight", "run"].includes(mode)) throw Error("mode must be preflight or run");
  const policy = raw.policy;
  if (mode === "run" && !["Q", "S"].includes(policy)) throw Error("formal run policy must be Q or S");
  const runId = id(raw.runId, "runId"), outputRoot = absolute(raw.outputRoot, "outputRoot");
  const runtime = Object.fromEntries(Object.entries(raw.runtime ?? {}).map(([key, value]) => [key, absolute(value, `runtime.${key}`)]));
  for (const required of ["node", "sdkDir", "natsBinary", "studyWorker", "qualityWorker", "policyAdapter", "probes"]) if (!runtime[required]) throw Error(`runtime.${required} is required`);
  const expectedHashes = raw.expectedHashes;
  if (!expectedHashes || typeof expectedHashes !== "object" || Object.values(expectedHashes).some(value => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))) throw Error("expectedHashes must contain SHA-256 strings");
  for (const required of ["node", "natsBinary", "meshElection", "meshNode", "meshBroker", "hub", "packageLock", "studyWorker", "qualityWorker", "policyAdapter", "network", "controller", "probes", "runner", "analysis"]) if (!expectedHashes[required]) throw Error(`expectedHashes.${required} is required`);
  if (runtime.tcpdump && !expectedHashes.tcpdump) throw Error("expectedHashes.tcpdump is required when runtime.tcpdump is configured");
  if (raw.timing !== undefined && JSON.stringify(raw.timing) !== JSON.stringify(TIMING)) throw Error("formal timing is fixed; omit timing or provide the exact defaults");
  return { ...raw, mode, policy: policy ?? null, runId, outputRoot, runtime, expectedHashes: { ...expectedHashes }, timing: { ...TIMING }, network: { ...(raw.network ?? {}), owner: raw.network?.owner ?? runId } };
}

export function namespaceWorkerArgv(config, nodeId, configPath) {
  const plan = buildNetworkPlan(config.network), ns = plan.config.names.namespaces[nodeId];
  if (!ns) throw Error(`unknown node ${nodeId}`);
  return ["ip", "netns", "exec", ns, config.runtime.node, config.runtime.qualityWorker, "--config", configPath];
}

async function hashFile(filename) { return sha256(await fs.readFile(filename)); }
export async function verifyFrozenInputs(config) {
  const files = {
    node: config.runtime.node, natsBinary: config.runtime.natsBinary,
    meshElection: path.join(config.runtime.sdkDir, "src", "mesh-election.mjs"), meshNode: path.join(config.runtime.sdkDir, "src", "mesh-node.mjs"), meshBroker: path.join(config.runtime.sdkDir, "src", "mesh-broker.mjs"), hub: path.join(config.runtime.sdkDir, "src", "hub.mjs"), packageLock: path.join(config.runtime.sdkDir, "package-lock.json"),
    studyWorker: config.runtime.studyWorker, qualityWorker: config.runtime.qualityWorker, policyAdapter: config.runtime.policyAdapter, probes: config.runtime.probes,
    network: new URL("./mesh-quality-network.mjs", import.meta.url), controller: new URL("./mesh-quality-controller.mjs", import.meta.url), runner: new URL("./mesh-quality-runner.mjs", import.meta.url), analysis: new URL("./mesh-quality-analysis.mjs", import.meta.url),
  };
  if (config.runtime.tcpdump) files.tcpdump = config.runtime.tcpdump;
  const actual = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([key, filename]) => [key, await hashFile(filename)])));
  const mismatches = Object.keys(files).filter(key => actual[key] !== config.expectedHashes[key]);
  return { ok: mismatches.length === 0, actual, mismatches };
}

export function assessScoreGate(evaluations, phase) {
  const relevant = evaluations.filter(row => row.phase === phase), expected = phase === "initial" ? "a" : "b";
  const views = new Map();
  for (const row of relevant) {
    const view = row.instanceId;
    if (typeof view !== "string" || !view) continue;
    const scores = row.scores ?? {}, target = scores[expected], others = Object.entries(scores).filter(([id]) => id !== expected).map(([, score]) => score);
    const qualifies = Number.isFinite(target) && others.length === 2 && others.every(score => Number.isFinite(score) && score - target >= 0.085) && row.coverage === "3/3" && row.loss < 0.01 && row.timeouts === 0;
    const state = views.get(view) ?? { consecutive: 0, maximum: 0 };
    state.consecutive = qualifies ? state.consecutive + 1 : 0; state.maximum = Math.max(state.maximum, state.consecutive); views.set(view, state);
  }
  const perView = Object.fromEntries([...views].map(([view, state]) => [view, state.maximum]));
  return { ok: views.size === 3 && [...views.values()].every(state => state.maximum >= 10), expected, perView };
}

export function assessPreflight(evidence) {
  const checks = {
    uniqueHostIds: Array.isArray(evidence.hostIds) && evidence.hostIds.length === 3 && evidence.hostIds.every(value => typeof value === "string" && value.length > 0) && new Set(evidence.hostIds).size === 3,
    namespaceInterfaces: evidence.namespaceInterfaces === true,
    noExternalRoutes: evidence.noExternalRoutes === true,
    uniqueAliases: evidence.uniqueAliases === true,
    packetPaths: evidence.packetPaths?.allSixDirections === true && evidence.packetPaths?.udp === true && evidence.packetPaths?.http === true && evidence.packetPaths?.tcp === true && evidence.packetPaths?.unaffectedPairsClean === true,
    switchCounters: evidence.switchCounters?.parserOk === true && evidence.switchCounters?.completeStats === true && evidence.switchCounters?.filtersPresent === true && evidence.switchCounters?.classified === true && evidence.switchCounters?.drops === 0,
    fixedDrain: evidence.drain?.ok === true,
    initialScores: assessScoreGate(evidence.evaluations ?? [], "initial").ok,
    reversedScores: assessScoreGate(evidence.evaluations ?? [], "reversed").ok,
    endpointAndWorkload: evidence.endpointNormalization === true && evidence.writerSequenceAndVersion === true,
    postReversalState: evidence.postReversalState?.ok === true,
    instrumentationIntegrity: evidence.instrumentationIntegrity === true,
    cleanup: evidence.ownedCleanup === true,
  };
  return { schema: "kinopio-mesh-quality-preflight/v1", go: Object.values(checks).every(Boolean), checks, scoreGates: { initial: assessScoreGate(evidence.evaluations ?? [], "initial"), reversed: assessScoreGate(evidence.evaluations ?? [], "reversed") } };
}

export function assessFixedDrain({ graceMs, elapsedMs, processesExited, pidsBefore, pidsAfter, counters }) {
  const ok = graceMs === DRAIN_GRACE_MS && Number.isFinite(elapsedMs) && elapsedMs >= DRAIN_GRACE_MS && processesExited === true && pidsBefore?.ok === true && pidsAfter?.ok === true && counters?.parserOk === true && counters?.completeStats === true && counters?.drops === 0 && counters?.drained === true;
  return { schema: "kinopio-mesh-quality-drain/v1", ok, graceMs, elapsedMs, processesExited: processesExited === true, pidsBefore, pidsAfter, counters };
}

export function validationProbeMatrix(config, ports) {
  const plan = buildNetworkPlan(config.network), byId = Object.fromEntries(plan.config.nodes.map(node => [node.id, node]));
  return plan.config.nodes.flatMap(source => plan.config.nodes.filter(target => target.id !== source.id).flatMap(target => {
    const ns = plan.config.names.namespaces[source.id], address = byId[target.id].address;
    return [
      { source: source.id, target: target.id, protocol: "udp", argv: ["ip", "netns", "exec", ns, ports.udpProbe, address, String(ports.udpPort)] },
      { source: source.id, target: target.id, protocol: "http", argv: ["ip", "netns", "exec", ns, ports.curl, "--fail", "--silent", "--max-time", "0.75", `http://${address}:${ports.httpPort}/kinopio-mesh/v1`] },
      { source: source.id, target: target.id, protocol: "tcp", argv: ["ip", "netns", "exec", ns, ports.tcpProbe, address, String(ports.tcpPort)] },
    ];
  }));
}

export function parseBoundedJsonlLine(line, maxBytes = 1024 * 1024) {
  if (typeof line !== "string") throw Error("JSONL line must be text");
  if (Buffer.byteLength(line) > maxBytes) throw Error("JSONL line exceeds the configured bound");
  let event; try { event = JSON.parse(line); } catch { throw Error("malformed worker JSONL"); }
  if (!event || typeof event !== "object" || Array.isArray(event) || typeof event.type !== "string") throw Error("worker JSONL event must contain type");
  return event;
}

class Jsonl {
  constructor(handle, maxBytes) { this.handle = handle; this.maxBytes = maxBytes; this.bytes = 0; this.closed = false; }
  async write(event) { const line = `${JSON.stringify({ wallTime: new Date().toISOString(), wallMs: Date.now(), monoMs: performance.now(), ...event })}\n`, size = Buffer.byteLength(line); if (this.closed || this.bytes + size > this.maxBytes) throw Error("bounded run JSONL limit exceeded"); await this.handle.write(line); this.bytes += size; }
  async close() { if (!this.closed) { this.closed = true; await this.handle.sync(); await this.handle.close(); } }
}

export async function createRunArtifacts(config) {
  const output = path.join(config.outputRoot, config.runId); await fs.mkdir(output, { recursive: false });
  const configuration = path.join(output, "configuration.json"); await fs.writeFile(configuration, JSON.stringify(config, null, 2), { flag: "wx" });
  const handle = await fs.open(path.join(output, "events.jsonl"), "wx");
  return { output, configuration, events: new Jsonl(handle, config.maxLogBytes ?? 256 * 1024 * 1024) };
}

/** One apparatus-only round. It never starts the prescribed formal workload. */
export async function runApparatusPreflight(raw, controller, dependencies = {}) {
  const config = validateRunnerConfig({ ...raw, mode: "preflight", policy: null }), plan = buildNetworkPlan(config.network), artifacts = await createRunArtifacts(config);
  let journal = null, evidence = null, failure = null, cleanupError = null, networkCleanupAttempted = false;
  try {
    await artifacts.events.write({ type: "configuration", configuration: config, apparatusOnly: true, apparatusRevision: APPARATUS_REVISION });
    const frozenInputs = await verifyFrozenInputs(config), filterCoverage = validatePairFilterCoverage(plan);
    await artifacts.events.write({ type: "frozenInputs", ...frozenInputs });
    if (!frozenInputs.ok || !filterCoverage.ok) throw Error("apparatus source freeze or pair-filter coverage failed");
    const [linksResult, routesResult] = await runCommands([["ip", "-j", "link", "show"], ["ip", "-j", "route", "show"]], dependencies.commandOptions);
    const isolation = validateSandboxIsolation(JSON.parse(linksResult.stdout), JSON.parse(routesResult.stdout));
    await artifacts.events.write({ type: "sandboxIsolation", ...isolation }); if (!isolation.ok) throw Error(isolation.reason);
    await writeOwnershipManifest(artifacts.output, plan);
    try { ({ journal } = await createOwnedNetwork(plan, { ...(dependencies.commandOptions ?? {}), journalPath: path.join(artifacts.output, "network-journal.json") })); } catch (error) { journal = error.networkJournal ?? null; throw error; }
    await runCommands(plan.initial, dependencies.commandOptions);
    await controller.start({ config, plan, output: artifacts.output, emit: event => artifacts.events.write(event), apparatusOnly: true });
    const initial = await controller.collectApparatusPhase("initial");
    const switchStartedMonoMs = performance.now(); await runCommands(plan.reversed, dependencies.commandOptions); const switchCompletedMonoMs = performance.now(); controller.noteReversalBoundary?.(switchCompletedMonoMs);
    if (switchCompletedMonoMs - switchStartedMonoMs > 1000) throw Error("apparatus reversal exceeded 1 s");
    const reversed = await controller.collectApparatusPhase("reversed");
    evidence = { apparatusRevision: APPARATUS_REVISION, timestampSemantics: "source monoMs is preserved; controllerReceiptMonoMs is controller-local ingest time and does not resolve the separate formal clock-analysis blockers", ...controller.staticEvidence(), evaluations: [...(initial.evaluations ?? []), ...(reversed.evaluations ?? [])], packetPaths: { initial: initial.packetPaths, reversed: reversed.packetPaths, ...(controller.packetPathSummary?.() ?? {}) }, switchCounters: controller.switchCounterSummary(initial, reversed), drain: null, ownedCleanup: false };
  } catch (error) { failure = String(error?.message ?? error); }
  try {
    const shutdownRequestMonoMs = performance.now(); let processesExited = true;
    try { await controller.close(); } catch (error) { processesExited = false; cleanupError = String(error?.message ?? error); }
    const shutdownCompleteMonoMs = performance.now(); await artifacts.events.write({ type: "ownedProcessesStopped", apparatusRevision: APPARATUS_REVISION, shutdownRequestMonoMs, shutdownCompleteMonoMs, ok: processesExited });
    let pidsBefore = null, pidsAfter = null, drainCounters = null;
    if (journal) {
      pidsBefore = await inspectOwnedNamespacePids(plan, dependencies.commandOptions); await artifacts.events.write({ type: "namespacePids", point: "before-drain", ...pidsBefore });
      const drainStartedMonoMs = performance.now(); const drainDelay = dependencies.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms))); await drainDelay(DRAIN_GRACE_MS); const drainEndpointMonoMs = performance.now(), drainElapsedMs = drainEndpointMonoMs - drainStartedMonoMs;
      await artifacts.events.write({ type: "drainInterval", apparatusRevision: APPARATUS_REVISION, graceMs: DRAIN_GRACE_MS, drainStartedMonoMs, drainEndpointMonoMs, drainElapsedMs });
      pidsAfter = await inspectOwnedNamespacePids(plan, dependencies.commandOptions); await artifacts.events.write({ type: "namespacePids", point: "drain-endpoint", ...pidsAfter });
      try { drainCounters = controller.drainCounterSummary(await controller.inspectNetwork("drain", "fixed-1000ms-endpoint")); }
      catch (error) { drainCounters = { parserOk: false, drained: false, error: String(error?.message ?? error) }; cleanupError ??= drainCounters.error; }
      if (evidence) evidence.drain = assessFixedDrain({ graceMs: DRAIN_GRACE_MS, elapsedMs: drainElapsedMs, processesExited, pidsBefore, pidsAfter, counters: drainCounters });
      await artifacts.events.write({ type: "drainAssessment", ...(evidence?.drain ?? assessFixedDrain({ graceMs: DRAIN_GRACE_MS, elapsedMs: drainElapsedMs, processesExited, pidsBefore, pidsAfter, counters: drainCounters })) });
      try { await controller.flush?.(); } catch (error) { cleanupError ??= String(error?.message ?? error); }
    }
    if (journal) { networkCleanupAttempted = true; try { await cleanupOwnedNetwork(config.network, { ...(dependencies.commandOptions ?? {}), journal }); } catch (error) { cleanupError ??= String(error?.message ?? error); } }
    if (evidence) evidence.ownedCleanup = cleanupError === null;
    const assessment = evidence ? assessPreflight(evidence) : { schema: "kinopio-mesh-quality-preflight/v1", go: false, checks: {}, scoreGates: {} };
    if (cleanupError) { failure ??= cleanupError; await artifacts.events.write({ type: "cleanupFailure", error: cleanupError, fatal: true }); }
    if (!assessment.go) failure ??= "apparatus preflight did not meet frozen go/no-go checks";
    const report = { ...assessment, go: !failure && assessment.go, ...(failure ? { error: failure } : {}), output: artifacts.output };
    await artifacts.events.write({ type: "preflight", ...report, evidence, fatal: !report.go });
    return report;
  } finally {
    if (journal && !networkCleanupAttempted) { try { await cleanupOwnedNetwork(config.network, { ...(dependencies.commandOptions ?? {}), journal }); } catch {} }
    await artifacts.events.close();
  }
}

/** Controller owns worker stdio and evidence collection; all deadlines remain runner-owned. */
export async function runExperiment(raw, controller, dependencies = {}) {
  const config = validateRunnerConfig(raw), plan = buildNetworkPlan(config.network), artifacts = await createRunArtifacts(config), delay = dependencies.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let journal = null, result = { runId: config.runId, policy: config.policy, outcome: "failed", evidenceValidity: "invalid" };
  const deadline = performance.now() + config.timing.runHardLimitMs;
  const bounded = async (label, task, limitMs) => {
    let timer; const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out`)), Math.min(limitMs, Math.max(1, deadline - performance.now()))); });
    try { return await Promise.race([task, timeout]); } finally { clearTimeout(timer); }
  };
  try {
    await artifacts.events.write({ type: "configuration", configuration: config });
    const frozen = await verifyFrozenInputs(config); await artifacts.events.write({ type: "frozenInputs", ...frozen }); if (!frozen.ok) throw Error(`frozen input mismatch: ${frozen.mismatches.join(", ")}`);
    const coverage = validatePairFilterCoverage(plan); if (!coverage.ok) throw Error("pair filter plan is incomplete");
    const [linksResult, routesResult] = await runCommands([["ip", "-j", "link", "show"], ["ip", "-j", "route", "show"]], dependencies.commandOptions);
    const isolation = validateSandboxIsolation(JSON.parse(linksResult.stdout), JSON.parse(routesResult.stdout));
    await artifacts.events.write({ type: "sandboxIsolation", ...isolation }); if (!isolation.ok) throw Error(isolation.reason);
    await writeOwnershipManifest(artifacts.output, plan);
    try { ({ journal } = await createOwnedNetwork(plan, { ...(dependencies.commandOptions ?? {}), journalPath: path.join(artifacts.output, "network-journal.json") })); } catch (error) { journal = error.networkJournal ?? null; throw error; }
    await runCommands(plan.initial, dependencies.commandOptions);
    await controller.start({ config, plan, output: artifacts.output, emit: event => artifacts.events.write(event) });
    const stable = await bounded("setup", controller.waitForStable({ host: "a", continuousMs: 60000 }), 240000);
    await artifacts.events.write({ type: "phase", phase: "setup", stable, monoMs: performance.now() });
    await controller.startWrites(); await artifacts.events.write({ type: "phase", phase: "measurement", monoMs: performance.now() }); await delay(60000);
    const switchStartedMonoMs = performance.now(); const beforeCounters = await runCommands(plan.inspect, dependencies.commandOptions); await runCommands(plan.reversed, dependencies.commandOptions); const switchCompletedMonoMs = performance.now(); const afterCounters = await runCommands(plan.inspect, dependencies.commandOptions);
    await artifacts.events.write({ type: "phase", phase: "reversal", monoMs: switchCompletedMonoMs, switchStartedMonoMs, switchCompletedMonoMs, beforeCounters, afterCounters });
    if (switchCompletedMonoMs - switchStartedMonoMs > 1000) throw Error("network reversal exceeded 1 s");
    await delay(180000); await controller.stopWrites(); await controller.markMeasurementEnd(); await artifacts.events.write({ type: "phase", phase: "quiet", monoMs: performance.now() }); await delay(30000);
    const functional = await controller.finalizeEvidence(); result = { ...result, functional, outcome: "completed", evidenceValidity: "pending-analysis" };
  } catch (error) { result.error = String(error?.message ?? error); await artifacts.events.write({ type: "runFailure", error: result.error, fatal: true }); }
  finally {
    try { await bounded("controller cleanup", controller.close(), 30000); } catch (error) { result.cleanupError = String(error?.message ?? error); }
    if (journal) { try { await cleanupOwnedNetwork(config.network, { ...(dependencies.commandOptions ?? {}), journal }); } catch (error) { result.networkCleanupError = String(error?.message ?? error); } }
    await artifacts.events.write({ type: "runComplete", result }); await artifacts.events.close();
  }
  return { ...result, output: artifacts.output };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--config") throw Error("usage: mesh-quality-runner.mjs --config CONFIG.json");
  const config = validateRunnerConfig(JSON.parse(await fs.readFile(path.resolve(process.argv[3]), "utf8")));
  if (config.mode === "run") throw Error("formal CLI execution remains disabled until an apparatus preflight passes independent review");
  if (process.platform !== "linux" || process.getuid?.() !== 0) throw Error("apparatus preflight requires root inside an isolated Linux container");
  await fs.mkdir(config.outputRoot, { recursive: true });
  const controller = new NetnsQualityController(); const report = await runApparatusPreflight(config, controller);
  process.stdout.write(`${JSON.stringify(report)}\n`); if (!report.go) process.exitCode = 1;
}
