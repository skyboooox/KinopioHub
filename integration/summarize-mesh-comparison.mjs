#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const POLICIES = ["F-R", "S", "Q"];
const PHASES = ["measurementStart", "baselineEnd", "postfaultStart", "measurementEnd"];
const sha256 = value => createHash("sha256").update(value).digest("hex");
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = value => Number.isFinite(value) ? value : null;
const unique = values => [...new Set(values)];

function partialEqual(actual, frozen) {
  if (Array.isArray(frozen)) return Array.isArray(actual) && actual.length === frozen.length && frozen.every((value, index) => partialEqual(actual[index], value));
  if (isObject(frozen)) return isObject(actual) && Object.entries(frozen).every(([key, value]) => partialEqual(actual[key], value));
  return Object.is(actual, frozen);
}

async function readJson(filename) {
  try {
    const text = await fs.readFile(filename, "utf8"), value = JSON.parse(text);
    return isObject(value) ? { value, text, error: null } : { value: null, text, error: "invalid top-level JSON value (expected object)" };
  } catch (error) {
    return { value: null, text: null, error: error.code === "ENOENT" ? "missing" : String(error.message ?? error) };
  }
}

async function readJsonl(filename) {
  let text;
  try { text = await fs.readFile(filename, "utf8"); }
  catch (error) { return { events: [], malformedLines: 0, error: error.code === "ENOENT" ? "missing" : String(error.message ?? error) }; }
  const events = []; let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const value = JSON.parse(line); if (isObject(value)) events.push(value); else malformedLines++; }
    catch { malformedLines++; }
  }
  return { events, malformedLines, error: null };
}

async function verifyFreeze(planFile) {
  const directory = path.dirname(path.resolve(planFile)), filename = path.join(directory, "freeze.json"), read = await readJson(filename);
  if (read.error === "missing") return { status: "not-provided", verified: false, file: filename, issues: ["freeze.json is not present"] };
  if (!read.value || !Array.isArray(read.value.files)) return { status: "invalid", verified: false, file: filename, issues: [`freeze.json ${read.error ?? "does not contain a files array"}`] };
  const issues = [];
  for (const entry of read.value.files) {
    if (!isObject(entry) || typeof entry.path !== "string" || typeof entry.sha256 !== "string") { issues.push("freeze contains an invalid file entry"); continue; }
    const source = entry.snapshot ? path.join(directory, entry.snapshot) : entry.path;
    try { if (sha256(await fs.readFile(source)) !== entry.sha256) issues.push(`freeze hash mismatch for ${entry.path}`); }
    catch (error) { issues.push(`freeze file unavailable for ${entry.path}: ${error.code ?? error.message}`); }
  }
  return { status: issues.length ? "invalid" : "verified", verified: issues.length === 0, file: filename, schema: read.value.schema ?? null, filesChecked: read.value.files.length, issues };
}

function droppedCount(events) {
  const cumulative = events.reduce((max, event) => Math.max(max, Number(event.outputEventsDroppedTotal) || 0), 0);
  const incremental = events.reduce((sum, event) => sum + (Number(event.outputEventsDropped) || 0), 0);
  return Math.max(cumulative, incremental);
}

function expectedRunSlots(plan, plannedRuns) {
  if (Array.isArray(plannedRuns) && plannedRuns.length) return plannedRuns.map(row => ({ runId: typeof row.runId === "string" ? row.runId : null, block: row.block, policy: row.policy, configurationSha256: row.sha256 ?? null, configurationFile: row.configuration ?? null }));
  const slots = [];
  for (const block of Array.isArray(plan?.blocks) ? plan.blocks : []) for (const policy of Array.isArray(block.arms) ? block.arms : []) slots.push({ runId: null, block: block.block, policy, configurationSha256: null });
  return slots;
}

function validatePhaseAndCommands(events, host, runId) {
  const incomplete = [], invalid = [];
  const markers = events.filter(event => event.type === "phaseMarker");
  const sequence = markers.map(event => event.phase);
  if (markers.length !== 4 || PHASES.some((phase, index) => sequence[index] !== phase)) incomplete.push(`${host} does not contain exactly four ordered phase markers`);
  const byId = new Map();
  for (const event of events.filter(event => event.type === "command")) {
    if (event.id === null || event.id === undefined || byId.has(event.id)) invalid.push(`${host} command id is missing or duplicated`);
    else byId.set(event.id, event);
    if (event.ok !== true) invalid.push(`${host} has a failed command event`);
    if (!["start", "stop", "mark", "snapshot", "killBroker", "close"].includes(event.op)) invalid.push(`${host} has an unknown command operation`);
  }
  for (const marker of markers) {
    const command = byId.get(marker.id);
    if (!command || command.op !== "mark" || command.ok !== true || command.result?.phase !== marker.phase || command.result?.monoMs !== marker.monoMs) invalid.push(`${host} ${marker.phase} marker has no matching command acknowledgement`);
    if (marker.runId !== runId || marker.sourceId !== host || !Number.isFinite(marker.monoMs)) invalid.push(`${host} ${marker.phase} marker identity is invalid`);
  }
  const start = events.filter(event => event.type === "observationWindowStarted"), end = events.filter(event => event.type === "observationWindowEnded");
  if (start.length !== 1 || end.length !== 1) incomplete.push(`${host} observation-window boundaries are missing or duplicated`);
  else {
    const first = markers[0], last = markers[3];
    if (start[0].id !== first?.id || start[0].monoMs !== first?.monoMs || end[0].id !== last?.id || end[0].monoMs !== last?.monoMs) invalid.push(`${host} observation-window events do not match phase markers`);
  }
  return { markers, incomplete, invalid };
}

/** Compute the frozen receiver-local interruption metric without crossing clocks. */
export function computeReceiverStreams(events, receiver, sourceIds) {
  const phase = Object.fromEntries(PHASES.map(name => [name, events.find(event => event.type === "phaseMarker" && event.phase === name)?.monoMs]));
  const bounded = PHASES.every(name => Number.isFinite(phase[name])) && phase.measurementStart <= phase.baselineEnd && phase.baselineEnd <= phase.postfaultStart && phase.postfaultStart <= phase.measurementEnd;
  return sourceIds.filter(source => source !== receiver).map(source => {
    const raw = events.filter(event => event.type === "observation" && event.receiver === receiver && event.sourceId === source && Number.isFinite(event.monoMs) && Number.isSafeInteger(event.key) && Number.isSafeInteger(event.seq));
    raw.sort((a, b) => a.monoMs - b.monoMs);
    const seen = new Set(), uniqueEvents = [];
    for (const event of raw) { const identity = `${event.sourceId}/${event.key}/${event.seq}`; if (!seen.has(identity)) { seen.add(identity); uniqueEvents.push(event); } }
    const observations = bounded ? uniqueEvents.filter(event => event.monoMs >= phase.measurementStart && event.monoMs <= phase.measurementEnd) : [];
    const components = [];
    if (bounded && observations.length) {
      components.push({ kind: "window-start-to-first", durationMs: observations[0].monoMs - phase.measurementStart, censored: true });
      for (let index = 1; index < observations.length; index++) components.push({
        kind: "completed-inter-observation", durationMs: observations[index].monoMs - observations[index - 1].monoMs, censored: false,
        from: { monoMs: observations[index - 1].monoMs, key: observations[index - 1].key, seq: observations[index - 1].seq },
        to: { monoMs: observations[index].monoMs, key: observations[index].key, seq: observations[index].seq },
        crossesBaselineEnd: observations[index - 1].monoMs <= phase.baselineEnd && observations[index].monoMs >= phase.baselineEnd,
        crossesPostfaultStart: observations[index - 1].monoMs <= phase.postfaultStart && observations[index].monoMs >= phase.postfaultStart,
      });
      components.push({ kind: "last-to-window-end", durationMs: phase.measurementEnd - observations.at(-1).monoMs, censored: true });
    } else if (bounded) components.push({ kind: "whole-window-no-observations", durationMs: phase.measurementEnd - phase.measurementStart, censored: true });
    const maxMs = components.length ? Math.max(...components.map(item => item.durationMs)) : null;
    const determining = components.filter(item => item.durationMs === maxMs);
    return {
      receiver, source, window: bounded ? { startMonoMs: phase.measurementStart, endMonoMs: phase.measurementEnd, durationMs: phase.measurementEnd - phase.measurementStart } : null,
      rawObservationEvents: raw.length, observations: observations.length, duplicateEventsRemoved: raw.length - uniqueEvents.length,
      components, maximumObservedSilenceMs: maxMs, maximumCompletedGapMs: components.filter(item => !item.censored).reduce((max, item) => Math.max(max, item.durationMs), null),
      boundaryDeterminesOrTiesMaximum: determining.some(item => item.censored), noObservations: bounded && observations.length === 0,
      faultStraddlingCompletedGaps: components.filter(item => !item.censored && item.crossesPostfaultStart),
    };
  });
}

function verifyFinalState(workerRecords, hosts, runId) {
  const failures = [], incomplete = [];
  const accepted = new Map();
  for (let key = 0; key < 64; key++) {
    const owner = hosts[key % hosts.length], worker = workerRecords.find(row => row.host === owner);
    const write = worker?.events.filter(event => event.type === "write" && event.accepted === true && event.key === key).at(-1);
    if (write?.runId === runId && write.sourceId === owner && Number.isSafeInteger(write.seq)) accepted.set(key, write);
  }
  const snapshots = new Map(workerRecords.map(worker => [worker.host, worker.events.filter(event => event.type === "snapshot").at(-1)]));
  for (const host of hosts) if (!snapshots.get(host)?.values || snapshots.get(host).values.length !== 64) incomplete.push(`${host} final 64-key snapshot is missing`);
  if (incomplete.length) return { passed: false, failures, incomplete, keysChecked: 0 };
  for (let key = 0; key < 64; key++) {
    const owner = hosts[key % hosts.length], write = accepted.get(key);
    if (!write || write.sourceId !== owner) { failures.push(`key ${key} has no last accepted owner write`); continue; }
    for (const host of hosts) {
      const row = snapshots.get(host).values.find(value => value.key === key), value = row?.value;
      if (!row || row.meta?.exists !== true || value?.run !== runId || value?.source !== owner || value?.seq !== write.seq || value?.key !== key || value?.data !== "x".repeat(64) || JSON.stringify(row.meta?.version) !== JSON.stringify(write.version)) failures.push(`${host} key ${key} does not match the last accepted owner write and version`);
    }
  }
  return { passed: failures.length === 0, failures, incomplete, keysChecked: 64 };
}

function provenanceChecks(result, config, workerRecords, supervisor) {
  const incomplete = [], invalid = [], expectedFiles = result?.runtime?.expectedFiles;
  if (!isObject(result?.harnessHashes) || !isObject(expectedFiles)) incomplete.push("result runtime/source hashes are missing");
  for (const worker of workerRecords) {
    const ready = worker.events.find(event => event.type === "ready"), expectedHost = config.hosts.find(host => host.id === worker.host);
    if (!ready?.runtime?.provenance) { incomplete.push(`${worker.host} ready runtime provenance is missing`); continue; }
    if (ready.runId !== config.runId || ready.sourceId !== worker.host || ready.policy !== (config.policy === "F-R" ? "F" : config.policy)) invalid.push(`${worker.host} ready identity does not match configuration`);
    if (ready.runtime.sdkPath !== path.join(config.policy === "F-R" ? expectedHost.sdkBase : expectedHost.sdkPolicy?.[config.policy], "src/node.mjs")) invalid.push(`${worker.host} SDK path does not match configuration`);
    if (expectedHost.node && ready.runtime.execPath !== expectedHost.node) invalid.push(`${worker.host} Node executable path does not match configuration`);
    if (result.runtime?.node && ready.runtime.node !== result.runtime.node) invalid.push(`${worker.host} Node runtime version differs from result runtime`);
    if (expectedHost.binarySha256 && ready.runtime.provenance.meshBinary?.sha256 !== expectedHost.binarySha256) invalid.push(`${worker.host} mesh binary hash mismatch`);
    if (isObject(expectedFiles)) for (const [name, hash] of Object.entries(expectedFiles)) if (ready.runtime.provenance.files?.[name]?.sha256 !== hash) invalid.push(`${worker.host} source hash mismatch for ${name}`);
  }
  if (config.policy === "F-R") {
    const ready = supervisor?.events.find(event => event.type === "ready");
    if (!ready?.provenance) incomplete.push("F-R supervisor provenance is missing");
    else {
      if (ready.runId !== config.runId || ready.sourceId !== "fixed-supervisor") invalid.push("F-R supervisor ready identity mismatch");
      if (ready.provenance.files?.supervisor?.sha256 !== result?.harnessHashes?.["mesh-fixed-supervisor.mjs"]) invalid.push("F-R supervisor source hash mismatch");
      const fixedHost = config.hosts.find(host => host.id === config.fixedHost);
      if (ready.provenance.files?.binary?.sha256 !== fixedHost?.binarySha256) invalid.push("F-R supervisor binary hash mismatch");
      if (ready.provenance.files?.meshBroker?.sha256 !== result?.runtime?.expectedFiles?.meshBroker) invalid.push("F-R supervisor mesh-broker source hash mismatch");
    }
  }
  return { incomplete, invalid };
}

async function summarizeRun(directory, slot, expectedConfigHash) {
  const resultRead = await readJson(path.join(directory, "result.json")), configRead = await readJson(path.join(directory, "configuration.json")), controllerRead = await readJsonl(path.join(directory, "controller.jsonl"));
  const result = resultRead.value, config = configRead.value;
  const fallbackId = slot?.runId ?? path.basename(directory), runId = config?.runId ?? result?.runId ?? fallbackId;
  const policy = config?.policy ?? result?.policy ?? slot?.policy ?? null, block = config?.block ?? slot?.block ?? null;
  const instrumentationIssues = [], incompleteIssues = [], cleanupIssues = [], functionalFailures = [];
  if (resultRead.error) incompleteIssues.push(`result.json ${resultRead.error}`);
  if (configRead.error) incompleteIssues.push(`configuration.json ${configRead.error}`);
  if (controllerRead.error) incompleteIssues.push(`controller.jsonl ${controllerRead.error}`);
  if (controllerRead.malformedLines) instrumentationIssues.push(`controller.jsonl has ${controllerRead.malformedLines} malformed line(s)`);
  if (!config) return { runId, block, policy, directory: path.basename(directory), present: true, evidenceValidity: { status: "incomplete", verified: false, incompleteIssues, instrumentationIssues, cleanupIssues }, functionalOutcome: { status: "indeterminate", failures: [] }, metric: { numericEligible: false, reason: "configuration unavailable", maximumObservedSilenceMs: null, streams: [] } };
  const hosts = Array.isArray(config.hosts) ? config.hosts.map(host => host.id).filter(id => typeof id === "string") : [];
  if (hosts.length !== 3 || new Set(hosts).size !== 3) incompleteIssues.push("configuration does not define exactly three unique host IDs");
  if (runId !== config.runId || result && (result.runId !== config.runId || result.policy !== config.policy)) instrumentationIssues.push("result/configuration run or policy identity mismatch");
  if (result?.configuration && !partialEqual(config, result.configuration)) instrumentationIssues.push("result embedded configuration differs from configuration.json");
  if (slot && (slot.runId && slot.runId !== config.runId || slot.block !== config.block || slot.policy !== config.policy)) instrumentationIssues.push("configuration identity differs from the frozen planned run");
  if (slot?.frozenConfigurationError) incompleteIssues.push(`frozen original configuration ${slot.frozenConfigurationError}`);
  if (expectedConfigHash && slot?.frozenConfigurationText && sha256(slot.frozenConfigurationText) !== expectedConfigHash) instrumentationIssues.push("frozen original configuration hash differs from the schedule manifest");
  if (slot?.frozenConfiguration && !partialEqual(config, slot.frozenConfiguration)) instrumentationIssues.push("run configuration differs semantically from the frozen original configuration");
  if (config.planSha256 && config.planSha256 !== slot?.planSha256) instrumentationIssues.push("configuration plan hash mismatch");
  if (config.amendmentSha256 && config.amendmentSha256 !== slot?.amendmentSha256) instrumentationIssues.push("configuration amendment hash mismatch");
  if (result?.schema !== "kinopio-controlled-mesh-comparison/v1") instrumentationIssues.push("result schema is missing or unexpected");
  if (result?.instrumentation?.error) instrumentationIssues.push(`result reports instrumentation error: ${result.instrumentation.error}`);
  if (!isObject(result?.harnessHashes)) incompleteIssues.push("result harness hashes are missing");
  else for (const [name, expectedHash] of Object.entries(result.harnessHashes)) {
    try { if (sha256(await fs.readFile(path.join(directory, "harness", name))) !== expectedHash) instrumentationIssues.push(`archived harness hash mismatch for ${name}`); }
    catch (error) { incompleteIssues.push(`archived harness ${name} ${error.code === "ENOENT" ? "missing" : error.message}`); }
  }
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const workerRecords = [];
  for (const host of hosts) {
    const read = await readJsonl(path.join(directory, `${host}.jsonl`));
    if (read.error) incompleteIssues.push(`${host}.jsonl ${read.error}`);
    if (read.malformedLines) instrumentationIssues.push(`${host}.jsonl has ${read.malformedLines} malformed line(s)`);
    const events = read.events, drops = droppedCount(events), closed = events.findLast(event => event.type === "closed");
    if (drops) instrumentationIssues.push(`${host} reported ${drops} dropped output event(s)`);
    if (!closed) cleanupIssues.push(`${host} closed event is missing`);
    else if (closed.outputIntegrity !== "complete" || closed.fatal === true || Number(closed.outputEventsDroppedTotal) !== 0) cleanupIssues.push(`${host} closed event reports incomplete or fatal cleanup`);
    const phase = validatePhaseAndCommands(events, host, runId); incompleteIssues.push(...phase.incomplete); instrumentationIssues.push(...phase.invalid);
    for (const event of events) {
      if (event.type === "observation" && (event.runId !== runId || event.receiver !== host || !hosts.includes(event.sourceId) || event.sourceId === host || !Number.isSafeInteger(event.key) || event.key % hosts.length !== hosts.indexOf(event.sourceId) || !Number.isSafeInteger(event.seq) || event.seq < 1)) instrumentationIssues.push(`${host} has an observation with invalid run/receiver/source/key/sequence identity`);
      if (event.type === "write" && (event.runId !== runId || event.sourceId !== host || !Number.isSafeInteger(event.key) || event.key % hosts.length !== hosts.indexOf(host) || !Number.isSafeInteger(event.seq) || event.seq < 1)) instrumentationIssues.push(`${host} has a write with invalid run/source/key/sequence identity`);
    }
    for (const event of events.filter(event => event.type === "error")) (event.operation === "close" ? cleanupIssues : instrumentationIssues).push(`${host} emitted ${event.operation ?? "unknown"} error`);
    workerRecords.push({ host, events, phase });
  }
  if (result?.phases) for (const [index, host] of hosts.entries()) for (const phase of PHASES) {
    const recorded = result.phases?.[phase]?.[index], marker = workerRecords[index].phase.markers.find(event => event.phase === phase);
    if (!recorded || recorded.phase !== phase || recorded.commandId !== marker?.id || recorded.monoMs !== marker?.monoMs) instrumentationIssues.push(`${host} ${phase} result marker identity mismatch`);
  }
  else incompleteIssues.push("result phase marker identities are missing");
  const expectedNames = new Set(hosts.map(host => `${host}.jsonl`).concat(["controller.jsonl", ...(policy === "F-R" ? ["fixed-supervisor.jsonl"] : [])]));
  for (const entry of entries.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))) if (!expectedNames.has(entry.name)) instrumentationIssues.push(`unexpected JSONL evidence file ${entry.name}`);
  for (const host of hosts) {
    const exits = controllerRead.events.filter(event => event.type === "workerExit" && event.host === host);
    const recorded = result?.instrumentation?.workers?.find(row => row.id === host);
    if (exits.length !== 1 || exits[0].code !== 0 || exits[0].signal !== null || !recorded?.exited || recorded.exitCode !== 0 || recorded.exitSignal !== null) cleanupIssues.push(`${host} successful worker exit evidence is incomplete`);
  }
  let supervisor = null, supervisorRestart = null;
  if (policy === "F-R") {
    const read = await readJsonl(path.join(directory, "fixed-supervisor.jsonl")); supervisor = { events: read.events };
    if (read.error) incompleteIssues.push(`fixed-supervisor.jsonl ${read.error}`);
    if (read.malformedLines) instrumentationIssues.push(`fixed-supervisor.jsonl has ${read.malformedLines} malformed line(s)`);
    if (droppedCount(read.events)) instrumentationIssues.push("fixed supervisor reported dropped output events");
    const ready = read.events.find(event => event.type === "ready"), exited = read.events.find(event => event.type === "brokerExited"), scheduled = exited && read.events.find(event => event.type === "restartScheduled" && event.monoMs >= exited.monoMs), started = exited && read.events.find(event => event.type === "brokerStarted" && event.generation > exited.generation);
    if (!ready || !exited || !started) incompleteIssues.push("F-R broker restart lifecycle is incomplete");
    else {
      if (ready.port !== started.port || ready.wsPort !== started.wsPort || ready.server !== started.server) instrumentationIssues.push("F-R restart did not preserve the same endpoint");
      if (!scheduled || scheduled.delayMs !== 1000 || scheduled.sourceId !== "fixed-supervisor" || scheduled.runId !== runId || exited.generation !== ready.generation || started.generation !== exited.generation + 1 || started.reason !== "restart") instrumentationIssues.push("F-R one-second restart lifecycle identity is invalid");
      supervisorRestart = { brokerExitedMonoMs: finite(exited.monoMs), brokerStartedMonoMs: finite(started.monoMs), elapsedMs: Number.isFinite(exited.monoMs) && Number.isFinite(started.monoMs) ? started.monoMs - exited.monoMs : null, descriptiveOnly: true };
    }
    const closed = read.events.findLast(event => event.type === "closed"), exits = controllerRead.events.filter(event => event.type === "supervisorExit");
    const recorded = result?.instrumentation?.supervisors?.[0];
    if (!closed || closed.runId !== runId || closed.sourceId !== "fixed-supervisor" || closed.outputIntegrity !== "complete" || closed.fatal === true || exits.length !== 1 || exits[0].code !== 0 || exits[0].signal !== null || !recorded?.exited || recorded.exitCode !== 0) cleanupIssues.push("F-R supervisor close/exit evidence is incomplete");
  }
  const faultHost = result?.fault?.host, faultCommandId = result?.fault?.acknowledgement?.result?.commandId;
  if (faultHost && faultCommandId !== undefined) {
    const targetEvents = policy === "F-R" ? supervisor?.events ?? [] : workerRecords.find(worker => worker.host === faultHost)?.events ?? [];
    const command = targetEvents.find(event => event.type === "command" && event.id === faultCommandId);
    if (!command || command.op !== "killBroker" || command.ok !== true || command.result?.brokerPid !== result.fault.acknowledgement.result.brokerPid) instrumentationIssues.push("fault command acknowledgement identity mismatch");
  } else if (!result?.fault?.error) incompleteIssues.push("fault command acknowledgement identity is missing");
  const provenance = provenanceChecks(result, config, workerRecords, supervisor); incompleteIssues.push(...provenance.incomplete); instrumentationIssues.push(...provenance.invalid);
  const finalState = verifyFinalState(workerRecords, hosts, runId); incompleteIssues.push(...finalState.incomplete); functionalFailures.push(...finalState.failures);
  const streams = workerRecords.flatMap(worker => computeReceiverStreams(worker.events, worker.host, hosts));
  if (streams.length !== 6) incompleteIssues.push("the six directed desktop streams are unavailable");
  if (streams.some(stream => !stream.window)) incompleteIssues.push("one or more receiver-local measurement windows are incomplete");
  if (streams.some(stream => stream.noObservations)) functionalFailures.push("one or more directed desktop streams has no observations in the measurement window");
  const thresholds = result?.postfaultThresholds;
  if (!isObject(thresholds) || hosts.some(host => !Number.isSafeInteger(thresholds[host]))) incompleteIssues.push("per-source postfault thresholds are missing");
  else for (const worker of workerRecords) {
    const postfaultStart = worker.phase.markers.find(event => event.phase === "postfaultStart")?.monoMs;
    for (const source of hosts.filter(host => host !== worker.host)) if (!worker.events.some(event => event.type === "observation" && event.receiver === worker.host && event.sourceId === source && event.monoMs >= postfaultStart && event.seq > thresholds[source])) functionalFailures.push(`${worker.host} did not record a postfault sequence above ${source}'s threshold`);
  }
  const postfault = result?.postfaultEvidence;
  if (!isObject(postfault)) incompleteIssues.push("postfault functional evidence is missing");
  else if (postfault.completed !== true || postfault.directedPairsEverSimultaneouslyFresh !== true || postfault.directedPairsFreshAtWindowEnd !== true || postfault.connectedEndpointStableAtLeastOnce !== true) functionalFailures.push("postfault desktop functional recovery did not complete");
  if (config.serial && (!result?.espPostfault || result.espPostfault.status?.connection !== "connected" || result.espPostfault.read?.value?.run !== runId || !(result.espPostfault.read?.value?.seq > result.espPostfault.threshold))) functionalFailures.push("ESP32 postfault current-value recovery did not complete");
  if (Array.isArray(result?.functionalFailures)) functionalFailures.push(...result.functionalFailures.map(row => `${row.stage ?? "run"}: ${row.message ?? "functional failure"}`));
  const evidenceStatus = instrumentationIssues.length || cleanupIssues.length ? "invalid" : incompleteIssues.length ? "incomplete" : "verified";
  const maxima = streams.map(stream => stream.maximumObservedSilenceMs).filter(Number.isFinite);
  const maximumObservedSilenceMs = maxima.length ? Math.max(...maxima) : null;
  const boundaryCensoredMaximum = streams.some(stream => stream.maximumObservedSilenceMs === maximumObservedSilenceMs && stream.boundaryDeterminesOrTiesMaximum);
  const functionalEvidenceIncomplete = !result || finalState.incomplete.length > 0 || !isObject(thresholds) || !isObject(postfault) || streams.length !== 6 || streams.some(stream => !stream.window);
  const functionalStatus = functionalFailures.length ? "failed" : functionalEvidenceIncomplete ? "indeterminate" : "passed";
  const numericEligible = evidenceStatus === "verified" && functionalStatus === "passed" && Number.isFinite(maximumObservedSilenceMs) && !boundaryCensoredMaximum && !streams.some(stream => stream.noObservations);
  return {
    runId, block, policy, directory: path.basename(directory), present: true,
    evidenceValidity: { status: evidenceStatus, verified: evidenceStatus === "verified", incompleteIssues: unique(incompleteIssues), instrumentationIssues: unique(instrumentationIssues), cleanupIssues: unique(cleanupIssues) },
    functionalOutcome: { status: functionalStatus, failures: unique(functionalFailures), finalState, postfaultDiagnostics: { connectedEndpointStableAtWindowEnd: postfault?.connectedEndpointStableAtWindowEnd ?? null } },
    metric: { numericEligible, indeterminateReasons: [...(evidenceStatus !== "verified" ? [`evidence is ${evidenceStatus}`] : []), ...(functionalStatus !== "passed" ? [`functional outcome is ${functionalStatus}`] : []), ...(boundaryCensoredMaximum ? ["a censored boundary component determines or ties the run maximum"] : [])], maximumObservedSilenceMs, boundaryCensoredMaximum, streams, interpretation: "Largest observed receiver-local silence across six directed desktop streams; boundary components are censored lower bounds and this is not failover latency." },
    fixedSupervisorRestart: supervisorRestart,
  };
}

function missingRun(slot) {
  return { runId: slot.runId, block: slot.block, policy: slot.policy, directory: null, present: false, evidenceValidity: { status: "incomplete", verified: false, incompleteIssues: ["planned run directory is missing"], instrumentationIssues: [], cleanupIssues: [] }, functionalOutcome: { status: "indeterminate", failures: [] }, metric: { numericEligible: false, indeterminateReasons: ["planned run is missing"], maximumObservedSilenceMs: null, streams: [] } };
}

/** Evaluate a candidate/comparator contrast using the frozen per-block screen. */
export function evaluateContrast(runs, candidate, comparator, descriptiveOnly = false) {
  const differences = [1, 2, 3].map(block => {
    const candidateRun = runs.find(run => run.block === block && run.policy === candidate), comparatorRun = runs.find(run => run.block === block && run.policy === comparator);
    const candidateMaxMs = candidateRun?.metric?.maximumObservedSilenceMs ?? null, comparatorMaxMs = comparatorRun?.metric?.maximumObservedSilenceMs ?? null;
    const absoluteImprovementMs = Number.isFinite(candidateMaxMs) && Number.isFinite(comparatorMaxMs) ? comparatorMaxMs - candidateMaxMs : null;
    const relativeImprovement = Number.isFinite(absoluteImprovementMs) && comparatorMaxMs > 0 ? absoluteImprovementMs / comparatorMaxMs : null;
    return { block, candidateRunId: candidateRun?.runId ?? null, comparatorRunId: comparatorRun?.runId ?? null, candidateMaxMs, comparatorMaxMs, absoluteImprovementMs, relativeImprovement, thresholdMet: absoluteImprovementMs >= 500 && relativeImprovement >= 0.20 };
  });
  const allEligible = differences.every(row => {
    const c = runs.find(run => run.runId === row.candidateRunId), p = runs.find(run => run.runId === row.comparatorRunId);
    return c?.metric?.numericEligible && p?.metric?.numericEligible;
  });
  const candidateFailureVersusComparatorPass = [1, 2, 3].some(block => runs.find(run => run.block === block && run.policy === candidate)?.functionalOutcome?.status === "failed" && runs.find(run => run.block === block && run.policy === comparator)?.functionalOutcome?.status === "passed");
  const thresholdBlocks = differences.filter(row => row.thresholdMet).map(row => row.block);
  return { candidate, comparator, descriptiveOnly, differences, thresholdBlocks, verdict: descriptiveOnly ? "descriptive-only" : !allEligible || candidateFailureVersusComparatorPass ? "indeterminate" : thresholdBlocks.length >= 2 ? "passes-development-screen" : "does-not-pass-development-screen", allThreeBlocksEligible: Boolean(allEligible), candidateFailureVersusComparatorPass, inference: "Exploratory development screen only; no statistical significance or equivalence claim." };
}

export async function summarizeMeshComparison(inputDirectory, planFile, amendmentFile) {
  const input = path.resolve(inputDirectory), planRead = await readJson(path.resolve(planFile)), amendmentRead = await readJson(path.resolve(amendmentFile));
  if (!planRead.value || !amendmentRead.value) throw Error(`plan inputs are unreadable: ${planRead.error ?? amendmentRead.error}`);
  let manifest = Array.isArray(planRead.value.plannedRuns) ? planRead.value.plannedRuns : null;
  if (!manifest) { const schedule = await readJson(path.join(path.dirname(path.resolve(planFile)), "schedule.json")); manifest = schedule.value?.plannedRuns ?? null; }
  const planHash = sha256(planRead.text), amendmentHash = sha256(amendmentRead.text), sourceFreeze = await verifyFreeze(planFile);
  const slots = expectedRunSlots(planRead.value, manifest), entries = await fs.readdir(input, { withFileTypes: true }).catch(() => []), directories = entries.filter(entry => entry.isDirectory()).map(entry => path.join(input, entry.name));
  for (const slot of slots) {
    slot.planSha256 = planHash; slot.amendmentSha256 = amendmentHash;
    if (slot.configurationFile) {
      const frozen = await readJson(path.resolve(slot.configurationFile));
      slot.frozenConfiguration = frozen.value; slot.frozenConfigurationText = frozen.text; slot.frozenConfigurationError = frozen.error;
    }
  }
  const byName = new Map(directories.map(directory => [path.basename(directory), directory])), used = new Set(), runs = [];
  for (const slot of slots) {
    let directory = slot.runId ? byName.get(slot.runId) : null;
    if (!directory) for (const candidate of directories) if (!used.has(candidate)) { const cfg = await readJson(path.join(candidate, "configuration.json")); if (cfg.value?.block === slot.block && cfg.value?.policy === slot.policy) { directory = candidate; break; } }
    if (!directory) { if (slot.runId) runs.push(missingRun(slot)); continue; }
    used.add(directory); runs.push(await summarizeRun(directory, slot, slot.configurationSha256));
  }
  for (const directory of directories.filter(item => !used.has(item))) runs.push(await summarizeRun(directory, null, null));
  if (sourceFreeze.status === "invalid") for (const run of runs) {
    run.metric.numericEligible = false;
    run.metric.indeterminateReasons = unique([...(run.metric.indeterminateReasons ?? []), "precollection source freeze verification failed"]);
  }
  return {
    schema: "kinopio-broker-crash-comparison-summary/v1", generatedAt: new Date().toISOString(), input,
    protocol: { plan: path.resolve(planFile), planSha256: planHash, amendment: path.resolve(amendmentFile), amendmentSha256: amendmentHash, amendmentsGovern: true, originalPlanHashMatchesAmendment: amendmentRead.value.originalPlanSha256 ? amendmentRead.value.originalPlanSha256 === planHash : null, frozenRunIdsAvailable: slots.some(slot => slot.runId), expectedRuns: slots.length, sourceFreeze },
    runIds: runs.map(run => run.runId).filter(Boolean), runs,
    contrasts: { qVsS: evaluateContrast(runs, "Q", "S"), sVsFixedRestart: evaluateContrast(runs, "S", "F-R"), qVsFixedRestart: evaluateContrast(runs, "Q", "F-R", true) },
    methodology: { clocks: "All interruption components use one receiver's monotonic clock; clocks are never compared across hosts.", interruption: "Window-start to first observation, every consecutive deduplicated API observation gap across rotating keys, and last observation to window-end are retained. Boundary components are censored lower bounds; observations are never reset at the fault.", costs: "Resource fields remain partial raw evidence only. No total-cost comparison is produced.", esp32: "ESP32 evidence contributes only to functional current-value recovery, never interruption latency." },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const names = ["--input", "--plan", "--amendment", "--output"];
  if (argv.length !== 8 || names.some((name, index) => argv[index * 2] !== name)) throw Error("Usage: summarize-mesh-comparison.mjs --input RUNS_DIR --plan PLAN --amendment AMENDMENT --output JSON");
  const output = path.resolve(argv[7]), summary = await summarizeMeshComparison(argv[1], argv[3], argv[5]);
  await fs.writeFile(output, `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output, runs: summary.runs.length })}\n`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
