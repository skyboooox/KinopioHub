#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function finite(value) { return Number.isFinite(value) ? value : null; }

function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { n: 0, minMs: null, medianMs: null, maxMs: null, gapsOver1000Ms: 0 };
  const middle = Math.floor(sorted.length / 2);
  return {
    n: sorted.length,
    minMs: sorted[0],
    medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    maxMs: sorted.at(-1),
    gapsOver1000Ms: sorted.filter(value => value > 1000).length,
  };
}

function numericSummary(values, suffix = "") {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const key = name => `${name}${suffix}`;
  if (!sorted.length) return { n: 0, [key("min")]: null, [key("median")]: null, [key("max")]: null };
  const middle = Math.floor(sorted.length / 2);
  return { n: sorted.length, [key("min")]: sorted[0], [key("median")]: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, [key("max")]: sorted.at(-1) };
}

async function readJson(filename) {
  try {
    const value = JSON.parse(await fs.readFile(filename, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : { __readError: "invalid top-level JSON value (expected object)" };
  }
  catch (error) { return { __readError: error.code === "ENOENT" ? "missing" : String(error.message ?? error) }; }
}

async function readJsonl(filename) {
  let text;
  try { text = await fs.readFile(filename, "utf8"); }
  catch (error) { return { events: [], malformedLines: 0, readError: error.code === "ENOENT" ? "missing" : String(error.message ?? error) }; }
  const events = []; let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { malformedLines++; }
  }
  return { events, malformedLines, readError: null };
}

function harnessSignature(hashes) {
  if (!hashes || typeof hashes !== "object") return "missing";
  return Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)).map(([name, hash]) => `${name}:${hash}`).join("|") || "missing";
}

function leaderSummary(statuses) {
  const changes = [];
  for (let index = 1; index < statuses.length; index++) {
    const from = statuses[index - 1].sdk?.mesh?.leaderId ?? null, to = statuses[index].sdk?.mesh?.leaderId ?? null;
    if (from !== to) changes.push({ receiverMonoMs: finite(statuses[index].monoMs), from, to, role: statuses[index].sdk?.mesh?.role ?? null });
  }
  return { initialStatus: statuses[0]?.sdk ?? null, finalStatus: statuses.at(-1)?.sdk ?? null, leaderChanges: changes };
}

function resourceSummary(statuses) {
  const resources = statuses.map(event => event.resources).filter(Boolean);
  return {
    samples: resources.length,
    workerRssBytes: numericSummary(resources.map(row => row.worker?.memory?.rss), "Bytes"),
    workerCpuPercent: numericSummary(resources.map(row => row.worker?.cpuPercent), "Percent"),
    ownedBrokerRssBytes: numericSummary(resources.map(row => row.ownedBroker?.rssBytes), "Bytes"),
    ownedBrokerCpuPercentLifetime: numericSummary(resources.map(row => row.ownedBroker?.cpuPercentLifetime), "Percent"),
    limitation: "Descriptive per-process samples only. Broker CPU is a ps lifetime average; F broker and some watchdog or transition costs are excluded. These samples are not total cost and are not policy comparisons.",
  };
}

function localObservationWindow(events) {
  const started = events.find(event => ["observationWindowStart", "observationWindowStarted"].includes(event.type) && Number.isFinite(event.monoMs));
  const ended = events.findLast(event => ["observationWindowEnd", "observationWindowEnded"].includes(event.type) && Number.isFinite(event.monoMs));
  return started && ended && ended.monoMs >= started.monoMs ? { startMonoMs: started.monoMs, endMonoMs: ended.monoMs } : null;
}

function terminalSilence(unique, localWindow) {
  if (!localWindow) return {
    status: "unknown",
    durationMs: null,
    lowerBoundMs: null,
    censored: true,
    reason: "No complete receiver-local observation-window boundaries are recorded; controller and worker monotonic clocks are not combined.",
  };
  const inWindow = unique.filter(event => event.monoMs >= localWindow.startMonoMs && event.monoMs <= localWindow.endMonoMs);
  if (!inWindow.length) return {
    status: "right-censored",
    durationMs: null,
    lowerBoundMs: localWindow.endMonoMs - localWindow.startMonoMs,
    censored: true,
    reason: "No observation was recorded within the explicitly bounded receiver-local window.",
  };
  return {
    status: "right-censored",
    durationMs: null,
    lowerBoundMs: localWindow.endMonoMs - inWindow.at(-1).monoMs,
    censored: true,
    reason: "The elapsed silence is a lower bound on the next-observation gap because no subsequent observation is recorded at the explicit receiver-local window end.",
  };
}

function observationStreams(events, receiver, expectedSources, windowEvidence) {
  const bySource = new Map();
  for (const source of expectedSources) if (source !== receiver) bySource.set(source, []);
  for (const event of events) {
    if (event.type !== "observation" || typeof event.sourceId !== "string" || !Number.isFinite(event.monoMs) || !Number.isSafeInteger(event.seq)) continue;
    if (!bySource.has(event.sourceId)) bySource.set(event.sourceId, []);
    bySource.get(event.sourceId).push(event);
  }
  const localWindow = localObservationWindow(events);
  return [...bySource.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([source, observations]) => {
    observations.sort((a, b) => a.monoMs - b.monoMs);
    const unique = [], seen = new Set();
    for (const event of observations) if (!seen.has(event.seq)) { seen.add(event.seq); unique.push(event); }
    const gaps = unique.slice(1).map((event, index) => event.monoMs - unique[index].monoMs);
    return {
      receiver,
      source,
      observationEvents: observations.length,
      uniqueSequences: unique.length,
      duplicateLogEvents: observations.length - unique.length,
      distinctKeys: new Set(unique.map(event => event.key)).size,
      gaps: distribution(gaps),
      window: {
        firstReceiverMonoMs: finite(unique[0]?.monoMs),
        lastReceiverMonoMs: finite(unique.at(-1)?.monoMs),
        headAndTailExcluded: true,
        truncated: windowEvidence.truncated,
        truncationReasons: windowEvidence.reasons,
        note: "Only gaps between recorded observations are measured; arbitrary start and stop tails are not converted into gaps.",
      },
      terminalSilence: terminalSilence(unique, localWindow),
    };
  });
}

function objectPresent(value) { return value && typeof value === "object" && !value.__readError; }

function evidenceValidity({ result, configuration, controllerRead, controller, workers, expectedHosts, workerFiles, runId, policy }) {
  const incomplete = [], invalid = [];
  if (!objectPresent(result)) incomplete.push(`result.json ${result.__readError ?? "invalid"}`);
  if (!objectPresent(configuration)) incomplete.push(`configuration.json ${configuration.__readError ?? "invalid"}`);
  if (controllerRead.readError) incomplete.push(`controller.jsonl ${controllerRead.readError}`);
  if (controllerRead.malformedLines) incomplete.push(`controller.jsonl has ${controllerRead.malformedLines} malformed line(s)`);
  if (!expectedHosts.length) incomplete.push("expected hosts unavailable from configuration");
  for (const host of expectedHosts) if (!workerFiles.includes(`${host}.jsonl`)) incomplete.push(`worker stream missing for ${host}`);
  for (const filename of workerFiles) if (!expectedHosts.includes(path.basename(filename, ".jsonl"))) invalid.push(`unexpected worker stream ${filename}`);

  const expectedHashes = objectPresent(result) && result.expectedSourceHashes && typeof result.expectedSourceHashes === "object" ? result.expectedSourceHashes : null;
  if (!expectedHashes || !Object.keys(expectedHashes).length) incomplete.push("expected source hashes missing from result");
  const configuredById = new Map((Array.isArray(configuration.hosts) ? configuration.hosts : []).map(host => [host.id, host]));
  const cleanupById = new Map((Array.isArray(result.cleanup) ? result.cleanup : []).map(row => [row.id, row]));
  const exitsByHost = new Map(controller.filter(event => event.type === "workerExit").map(event => [event.host, event]));
  const terminal = controller.filter(event => event.type === "passed" || event.type === "failed");
  if (!terminal.length) incomplete.push("controller terminal outcome event missing");
  if (objectPresent(result) && result.outcome === "passed" && terminal.at(-1)?.type !== "passed") invalid.push("result passed conflicts with controller terminal outcome");
  if (objectPresent(result) && result.outcome === "failed" && terminal.at(-1)?.type !== "failed") invalid.push("result failed conflicts with controller terminal outcome");
  if (objectPresent(result) && result.runId !== configuration.runId) invalid.push("result/configuration runId mismatch");
  if (objectPresent(result) && result.policy !== configuration.policy) invalid.push("result/configuration policy mismatch");

  for (const worker of workers.filter(row => expectedHosts.includes(path.basename(row.file, ".jsonl")))) {
    const host = path.basename(worker.file, ".jsonl"), cleanup = cleanupById.get(host), exit = exitsByHost.get(host);
    if (worker.readError) incomplete.push(`${host} worker stream ${worker.readError}`);
    if (worker.malformedLines) incomplete.push(`${host} worker stream has ${worker.malformedLines} malformed line(s)`);
    if (!worker.readyPresent) incomplete.push(`${host} ready event missing`);
    if (!worker.closedPresent) incomplete.push(`${host} closed event missing`);
    if (!worker.provenancePresent) incomplete.push(`${host} runtime provenance missing`);
    if (!configuredById.get(host)?.binarySha256) incomplete.push(`${host} expected mesh binary hash missing from configuration`);
    if (!cleanup) incomplete.push(`${host} result cleanup evidence missing`);
    else {
      if (!cleanup.exited || cleanup.exitCode !== 0 || cleanup.exitSignal != null || !cleanup.closedEvent) invalid.push(`${host} result cleanup was not successful`);
      const close = cleanup.closedEvent;
      if (close && (close.runId !== runId || close.sourceId !== host)) invalid.push(`${host} result cleanup closed event identity mismatch`);
      if (close && (close.outputIntegrity == null || close.fatal == null)) incomplete.push(`${host} result cleanup closed integrity fields missing`);
      else if (close && (close.outputIntegrity !== "complete" || close.fatal !== false || Number(close.outputEventsDroppedTotal ?? 0) !== 0 || Number(close.outputEventsDropped ?? 0) !== 0)) invalid.push(`${host} result cleanup closed output integrity failed`);
    }
    if (!exit) incomplete.push(`${host} controller workerExit event missing`);
    else if (exit.code !== 0 || exit.signal != null) invalid.push(`${host} worker exited unsuccessfully`);
    if (worker.logging.droppedEventsReported > 0) invalid.push(`${host} reported dropped output events`);
    if (worker.closedPresent && (worker.logging.closedIntegrity == null || worker.logging.closedFatal == null)) incomplete.push(`${host} worker closed integrity fields missing`);
    else if (worker.closedPresent && (worker.logging.closedIntegrity !== "complete" || worker.logging.closedFatal !== false)) invalid.push(`${host} closed output integrity was not successful`);
    if (worker.errors.length) invalid.push(`${host} worker error or failed command event present`);
    if (worker.identityIssues.length) invalid.push(...worker.identityIssues.map(issue => `${host} ${issue}`));
    if (worker.provenanceMismatches.length) invalid.push(...worker.provenanceMismatches.map(issue => `${host} ${issue}`));
  }
  const status = invalid.length ? "invalid" : incomplete.length ? "incomplete" : "verified";
  return {
    status,
    verified: status === "verified",
    comparisonEvidencePrerequisiteSatisfied: status === "verified",
    incompleteReasons: [...new Set(incomplete)],
    invalidReasons: [...new Set(invalid)],
    note: "Evidence validity is independent of the reported functional outcome. Verification is an evidence prerequisite only; study design, matched conditions, and method fairness require separate assessment before comparison.",
  };
}

function knownHarnessIssues(missingProvenance, annotation) {
  const issues = new Set((Array.isArray(annotation?.knownHarnessIssues) ? annotation.knownHarnessIssues : []).filter(value => typeof value === "string"));
  if (missingProvenance) issues.add("missing runtime provenance");
  return [...issues];
}

async function summarizeRun(directory, annotations) {
  const result = await readJson(path.join(directory, "result.json"));
  const configuration = await readJson(path.join(directory, "configuration.json"));
  const controllerRead = await readJsonl(path.join(directory, "controller.jsonl"));
  const controller = controllerRead.events;
  const policy = !result.__readError ? result.policy : configuration.policy ?? null;
  const runId = !result.__readError ? result.runId : configuration.runId ?? path.basename(directory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const workerFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl") && entry.name !== "controller.jsonl").map(entry => entry.name).sort();
  const configuredHosts = Array.isArray(configuration.hosts) ? configuration.hosts : Array.isArray(result.configuration?.hosts) ? result.configuration.hosts : [];
  const expectedHosts = configuredHosts.map(host => host.id).filter(value => typeof value === "string");
  const expectedFiles = expectedHosts.map(host => `${host}.jsonl`);
  const allWorkerFiles = [...new Set([...workerFiles, ...expectedFiles])].sort();
  const workers = [];
  for (const filename of allWorkerFiles) {
    const receiverFromFile = path.basename(filename, ".jsonl"), read = await readJsonl(path.join(directory, filename)), events = read.events;
    const ready = events.find(event => event.type === "ready"), receiver = ready?.sourceId ?? events.find(event => typeof event.sourceId === "string")?.sourceId ?? receiverFromFile;
    const statuses = events.filter(event => event.type === "status").sort((a, b) => (a.monoMs ?? 0) - (b.monoMs ?? 0));
    const writes = events.filter(event => event.type === "write");
    const cumulativeDropped = events.reduce((maximum, event) => Math.max(maximum, Number(event.outputEventsDroppedTotal ?? 0)), 0);
    const incrementalDropped = events.reduce((sum, event) => sum + Number(event.outputEventsDropped ?? 0), 0);
    const dropped = Math.max(cumulativeDropped, incrementalDropped);
    const errorEvents = events.filter(event => event.type === "error" || event.type === "command" && event.ok === false);
    const closed = events.findLast(event => event.type === "closed"), closedPresent = !!closed, writesStartedPresent = controller.some(event => event.type === "writesStarted"), writesStoppedPresent = controller.some(event => event.type === "writesStopped");
    const truncationReasons = [...(!writesStartedPresent ? ["controller writesStarted missing"] : []), ...(!writesStoppedPresent ? ["controller writesStopped missing"] : []), ...(!closedPresent ? ["worker closed event missing"] : [])];
    const expectedHost = configuredHosts.find(host => host.id === receiverFromFile);
    const expectedHashes = objectPresent(result) && result.expectedSourceHashes && typeof result.expectedSourceHashes === "object" ? result.expectedSourceHashes : null;
    const provenanceFiles = ready?.runtime?.provenance?.files;
    const provenanceMismatches = [];
    if (expectedHashes && provenanceFiles) for (const [name, hash] of Object.entries(expectedHashes)) {
      if (provenanceFiles[name]?.sha256 !== hash) provenanceMismatches.push(`provenance hash mismatch for ${name}`);
    }
    if (expectedHost?.binarySha256 && ready?.runtime?.provenance?.meshBinary?.sha256 !== expectedHost.binarySha256) provenanceMismatches.push("mesh binary provenance hash mismatch");
    const identityIssues = [];
    if (ready && ready.sourceId !== receiverFromFile) identityIssues.push(`ready sourceId ${ready.sourceId ?? "missing"} does not match filename`);
    if (ready && ready.runId !== runId) identityIssues.push("ready runId mismatch");
    if (ready && ready.policy !== policy) identityIssues.push("ready policy mismatch");
    if (closed && closed.sourceId !== receiverFromFile) identityIssues.push("closed sourceId mismatch");
    if (closed && closed.runId !== runId) identityIssues.push("closed runId mismatch");
    workers.push({
      receiver,
      file: filename,
      readError: read.readError,
      malformedLines: read.malformedLines,
      readyPresent: !!ready,
      provenancePresent: !!ready?.runtime?.provenance?.files,
      provenanceMismatches,
      identityIssues,
      closedPresent,
      writes: { accepted: writes.filter(event => event.accepted === true).length, rejected: writes.filter(event => event.accepted === false).length },
      logging: { droppedEventsReported: dropped, fatal: dropped > 0 || events.some(event => event.fatal === true), incomplete: !!read.readError || read.malformedLines > 0 || !closedPresent, closedIntegrity: closed?.outputIntegrity ?? null, closedFatal: closed?.fatal ?? null },
      errors: errorEvents.map(event => ({ type: event.type, operation: event.operation ?? event.op ?? null, error: event.error ?? null, receiverMonoMs: finite(event.monoMs) })),
      ...leaderSummary(statuses),
      observationStreams: observationStreams(events, receiver, expectedHosts, { truncated: truncationReasons.length > 0, reasons: truncationReasons }),
      resources: resourceSummary(statuses),
    });
  }
  const brokerKilled = controller.find(event => event.type === "brokerKilled"), reconnected = brokerKilled && controller.find(event => event.type === "reconnected" && event.monoMs >= brokerKilled.monoMs);
  const controllerPassed = controller.some(event => event.type === "passed"), controllerFailed = controller.some(event => event.type === "failed");
  const outcome = !result.__readError ? result.outcome ?? "incomplete" : controllerFailed ? "failed" : "incomplete";
  const error = !result.__readError ? result.error ?? null : controller.find(event => event.type === "failed")?.error ?? null;
  const missingProvenance = workers.some(worker => !worker.provenancePresent);
  const annotation = annotations?.runs?.[runId] ?? null;
  const validity = evidenceValidity({ result, configuration, controllerRead, controller, workers, expectedHosts, workerFiles, runId, policy });
  return {
    runId,
    directory: path.basename(directory),
    policy,
    outcome,
    functionalOutcome: {
      status: outcome,
      source: !result.__readError ? "result.json" : controllerFailed ? "controller failed event (result missing)" : "unavailable",
      controllerPassed,
      controllerFailed,
      note: "A controller passed event is provisional and is never promoted when result.json or cleanup evidence is missing.",
    },
    evidenceValidity: validity,
    error,
    checks: !result.__readError && Array.isArray(result.checks) ? result.checks : [],
    startedAt: !result.__readError ? result.startedAt ?? null : null,
    finishedAt: !result.__readError ? result.finishedAt ?? null : null,
    harnessHashes: !result.__readError ? result.harnessHashes ?? null : null,
    harnessSignature: harnessSignature(!result.__readError ? result.harnessHashes : null),
    annotation,
    knownHarnessIssues: knownHarnessIssues(missingProvenance, annotation),
    inputCompleteness: { result: result.__readError ?? "present", configuration: configuration.__readError ?? "present", controller: controllerRead.readError ?? "present", controllerMalformedLines: controllerRead.malformedLines, expectedWorkerStreams: expectedFiles, foundWorkerStreams: workerFiles, missingWorkerStreams: expectedFiles.filter(filename => !workerFiles.includes(filename)) },
    controllerRecovery: {
      brokerKilled: brokerKilled ? { controllerMonoMs: finite(brokerKilled.monoMs), wallTime: brokerKilled.wallTime ?? null, host: brokerKilled.host ?? null, brokerPid: brokerKilled.brokerPid ?? null } : null,
      reconnected: reconnected ? { controllerMonoMs: finite(reconnected.monoMs), wallTime: reconnected.wallTime ?? null } : null,
      killedToRequiredStabilizationCompleteMs: brokerKilled && reconnected && Number.isFinite(brokerKilled.monoMs) && Number.isFinite(reconnected.monoMs) ? reconnected.monoMs - brokerKilled.monoMs : null,
      interpretation: "Controller-clock duration through its fresh-data, reconnection, and required 60-second stability gate; it is not failover latency.",
    },
    workers,
    eventTotals: {
      writesAccepted: workers.reduce((sum, worker) => sum + worker.writes.accepted, 0),
      writesRejected: workers.reduce((sum, worker) => sum + worker.writes.rejected, 0),
      observations: workers.reduce((sum, worker) => sum + worker.observationStreams.reduce((count, stream) => count + stream.observationEvents, 0), 0),
      errors: workers.reduce((sum, worker) => sum + worker.errors.length, 0),
      reportedDroppedEvents: workers.reduce((sum, worker) => sum + worker.logging.droppedEventsReported, 0),
    },
  };
}

export async function summarizeMeshStudy(inputDirectory, annotations = null) {
  const input = path.resolve(inputDirectory), entries = await fs.readdir(input, { withFileTypes: true });
  const rootIsRun = entries.some(entry => entry.isFile() && ["result.json", "controller.jsonl", "configuration.json"].includes(entry.name));
  const directories = rootIsRun ? [input] : entries.filter(entry => entry.isDirectory()).map(entry => path.join(input, entry.name)).sort();
  const runs = [];
  for (const directory of directories) {
    const contents = await fs.readdir(directory);
    if (contents.some(name => name === "result.json" || name === "controller.jsonl" || name.endsWith(".jsonl"))) runs.push(await summarizeRun(directory, annotations));
  }
  const groups = new Map();
  for (const run of runs) {
    if (!groups.has(run.harnessSignature)) groups.set(run.harnessSignature, []);
    groups.get(run.harnessSignature).push(run.runId);
  }
  return {
    schema: "kinopio-physical-mesh-pilot-summary/v1",
    generatedAt: new Date().toISOString(),
    input,
    annotations: annotations ? { schema: annotations.schema ?? null, source: annotations.source ?? null } : null,
    runIds: runs.map(run => run.runId),
    harnessGroups: [...groups.entries()].map(([signature, runIds]) => ({ signature, runIds })),
    methodology: {
      observationGaps: "Adjacent API observation events are pooled across rotating keys separately for each receiver/source pair and measured only with that receiver's monotonic clock. No synthetic head or tail gap is added.",
      terminalSilence: "Terminal silence is unknown and censored unless both observation-window boundaries are explicit events on the same receiver monotonic clock. Even with boundaries, the interval from the last observation to window end is a right-censored lower bound because the next observation is not seen.",
      writes: "Accepted and rejected counts come only from individual write events, never repeated status or final counters.",
      clocks: "No worker clocks are compared and no one-way network latency is derived.",
      evidenceValidity: "Reported functional outcome is separate from instrumentation validity. Verification requires complete result, configuration, controller and expected worker streams; matching provenance; zero malformed, dropped or error events; and successful closed and process-exit evidence. It is only an evidence prerequisite, not a finding that policies were compared under fair or matched methods.",
      inference: "These pilot summaries are descriptive. They do not estimate statistical superiority between policies.",
      resources: "Resource ranges are descriptive per process and exclude known costs; no cross-policy means or total-cost claim is produced.",
    },
    runs,
  };
}

async function main() {
  if (process.argv.length !== 6 || process.argv[2] !== "--input" || process.argv[4] !== "--output") throw Error("usage: node summarize-mesh-study.mjs --input runs-dir --output summary.json");
  const input = path.resolve(process.argv[3]), annotationFile = path.join(path.dirname(input), "annotations.json");
  let annotations = null;
  try { annotations = JSON.parse(await fs.readFile(annotationFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const output = path.resolve(process.argv[5]), summary = await summarizeMeshStudy(input, annotations);
  await fs.writeFile(output, JSON.stringify(summary, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ output, runs: summary.runIds.length }) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
