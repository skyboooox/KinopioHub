#!/usr/bin/env node
// Controlled physical-host broker-crash runner. It records exploratory evidence; it is not a power calculation.
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { serialWorker } from "./arduino-worker.mjs";

const RUNNER_PATH = fileURLToPath(import.meta.url);
const WORKER_PATH = fileURLToPath(new URL("./mesh-study-worker.mjs", import.meta.url));
const SAFE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const DEFAULTS = Object.freeze({ setupTimeoutMs: 240000, initialStableMs: 60000, baselineMs: 60000, postfaultMs: 180000, quiescentMs: 60000, recoveryStableMs: 60000 });
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const finiteInteger = (value, name, minimum, maximum) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return value;
};

export function validateComparisonConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("configuration must be an object");
  if (!["F-R", "S", "Q"].includes(input.policy)) throw Error("policy must be F-R, S, or Q");
  if (!Array.isArray(input.hosts) || input.hosts.length !== 3) throw Error("hosts must contain exactly three hosts");
  const ids = new Set();
  const hosts = input.hosts.map((host, index) => {
    if (!host || typeof host !== "object") throw Error(`hosts[${index}] must be an object`);
    if (!SAFE_ID.test(host.id ?? "") || ids.has(host.id)) throw Error(`hosts[${index}].id must be a unique safe identifier`);
    ids.add(host.id);
    for (const field of ["directory", "node", "worker", "sdkBase", "binary", "binarySha256"]) if (typeof host[field] !== "string" || !host[field]) throw Error(`hosts[${index}].${field} is required`);
    if (host.advertiseAddress !== undefined && (typeof host.advertiseAddress !== "string" || !host.advertiseAddress)) throw Error(`hosts[${index}].advertiseAddress must be a nonempty string when supplied`);
    for (const field of ["directory", "node", "worker", "sdkBase", "binary"]) if (!path.isAbsolute(host[field])) throw Error(`hosts[${index}].${field} must be absolute`);
    if (!/^[a-f0-9]{64}$/.test(host.binarySha256)) throw Error(`hosts[${index}].binarySha256 must be a lowercase SHA-256 digest`);
    if (input.policy !== "F-R" && (typeof host.sdkPolicy?.[input.policy] !== "string" || !host.sdkPolicy[input.policy])) throw Error(`hosts[${index}].sdkPolicy.${input.policy} is required`);
    return { ...host, supervisorPath: host.supervisorPath ?? path.join(host.directory, "mesh-fixed-supervisor.mjs") };
  });
  if (input.policy === "F-R" && !ids.has(input.fixedHost)) throw Error("F-R requires fixedHost naming one configured host");
  if (input.policy === "F-R" && !hosts.find(host => host.id === input.fixedHost)?.advertiseAddress) throw Error("F-R fixedHost requires advertiseAddress");
  if (input.policy === "S" && !ids.has(input.expectedLeaderHost)) throw Error("S requires expectedLeaderHost naming one configured host");
  if (input.runId !== undefined && !SAFE_ID.test(input.runId)) throw Error("runId must be a safe identifier");
  if (typeof input.output !== "string" || !input.output) throw Error("output is required");
  if (input.fault !== undefined && input.fault !== "broker-kill") throw Error("fault is fixed to broker-kill");
  const timings = Object.fromEntries(Object.entries(DEFAULTS).map(([name, fallback]) => [name, finiteInteger(input[name] ?? fallback, name, 0, 3600000)]));
  if (timings.initialStableMs < 1 || timings.baselineMs < 1 || timings.postfaultMs < 1 || timings.quiescentMs < 1 || timings.recoveryStableMs < 1) throw Error("study timing windows must be positive");
  return { ...input, ...timings, hosts, fault: "broker-kill", runId: input.runId ?? `comparison-${input.policy}-${Date.now()}-${randomUUID().slice(0, 8)}` };
}

function endpointParts(value) {
  try {
    const parsed = new URL(value);
    const port = parsed.port || ({ "nats:": "4222", "tls:": "4222", "ws:": "80", "wss:": "443" })[parsed.protocol];
    if (!port) return null;
    return { protocol: parsed.protocol, hostname: parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase(), port: Number(port) };
  } catch { return null; }
}

export function normalizeEndpoint(value, ownerAddresses = []) {
  const endpoint = endpointParts(value);
  if (!endpoint) return null;
  const loopback = endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1" || endpoint.hostname === "::1";
  const aliases = new Set(ownerAddresses.filter(Boolean).map(address => String(address).toLowerCase()));
  const hostname = aliases.size && (loopback || aliases.has(endpoint.hostname)) ? "owner" : endpoint.hostname;
  return `${endpoint.protocol}//${hostname}:${endpoint.port}`;
}

export function commonEndpointState(rows, now = performance.now(), freshnessMs = 4000, fixedEndpoint = null) {
  if (!rows.length || rows.some(row => !row.status || now - row.statusReceivedAt >= freshnessMs || row.status.sdk?.connection !== "connected")) return { ok: false, reason: "status-not-fresh-connected" };
  if (fixedEndpoint) {
    const expected = normalizeEndpoint(fixedEndpoint);
    const endpoints = rows.map(row => normalizeEndpoint(row.status.sdk?.server));
    return { ok: endpoints.every(endpoint => endpoint === expected), leaderId: null, leaderHost: null, endpoint: expected, endpoints, reason: endpoints.every(endpoint => endpoint === expected) ? null : "fixed-endpoint-mismatch" };
  }
  const reportedLeaderIds = rows.map(row => row.status.sdk?.mesh?.leaderId);
  const leaderIds = new Set(reportedLeaderIds);
  if (reportedLeaderIds.some(value => typeof value !== "string" || !value) || leaderIds.size !== 1 || rows.filter(row => row.status.sdk?.mesh?.role === "leader").length !== 1 || rows.some(row => row.status.sdk?.mesh?.members !== rows.length)) return { ok: false, reason: "leader-not-common" };
  const leaderId = [...leaderIds][0];
  const owner = rows.find(row => row.status.sdk?.mesh?.role === "leader");
  if (!owner) return { ok: false, reason: "leader-owner-unknown", leaderId };
  const aliases = [owner.host.advertiseAddress, ...Object.values(owner.ready?.runtime?.interfaces ?? {}).flat().filter(item => !item.internal).map(item => item.address)];
  const endpoints = rows.map(row => {
    const parts = endpointParts(row.status.sdk?.server);
    if (row !== owner && ["localhost", "127.0.0.1", "::1"].includes(parts?.hostname)) return null;
    return normalizeEndpoint(row.status.sdk?.server, aliases);
  });
  const ok = endpoints.every(Boolean) && new Set(endpoints).size === 1;
  return { ok, reason: ok ? null : "endpoint-mismatch", leaderId, leaderHost: owner.host.id, endpoint: ok ? endpoints[0] : null, endpoints };
}

export function directedPairFreshness(rows, sourceIds, since, now = performance.now(), freshnessMs = 4000, thresholds = new Map()) {
  const pairs = [];
  for (const row of rows) for (const sourceId of sourceIds) if (sourceId !== row.host.id) {
    const seen = row.observations.get(sourceId);
    const threshold = thresholds.get(sourceId) ?? 0;
    pairs.push({ receiver: row.host.id, sourceId, seq: seen?.seq ?? 0, threshold, receivedAt: seen?.receivedAt ?? null, afterBoundary: (seen?.receivedAt ?? -Infinity) >= since, aboveThreshold: (seen?.seq ?? 0) > threshold, fresh: now - (seen?.receivedAt ?? -Infinity) < freshnessMs });
  }
  return { ok: pairs.every(pair => pair.afterBoundary && pair.aboveThreshold && pair.fresh), pairs };
}

export function advanceStableInterval(previous, state, now, requiredMs) {
  if (!state.ok) return { since: null, signature: null, achieved: false };
  const signature = `${state.leaderId ?? "fixed"}|${state.endpoint}`;
  const since = previous?.signature === signature && previous.since !== null ? previous.since : now;
  return { since, signature, achieved: now - since >= requiredMs };
}

function launch(host, remoteCommand, { input } = {}) {
  const sshArgs = ["-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", host.ssh, remoteCommand];
  let child;
  if (host.ssh) {
    if (host.passwordEnv) {
      const secret = process.env[host.passwordEnv];
      if (!secret) throw Error(`Missing ${host.passwordEnv}`);
      child = spawn("sshpass", ["-d", "3", "ssh", ...sshArgs], { stdio: ["pipe", "pipe", "pipe", "pipe"] });
      child.stdio[3].end(`${secret}\n`);
    } else child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
  } else child = spawn("/bin/sh", ["-c", remoteCommand], { stdio: ["pipe", "pipe", "pipe"] });
  if (input !== undefined) child.stdin.end(input);
  return child;
}

async function installConfig(host, filename, value) {
  const child = launch(host, `umask 077; cat > ${quote(filename)}`, { input: JSON.stringify(value) });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => code === 0 ? resolve() : reject(Error(`Write config ${host.id}: ${stderr.slice(-1000)}`))); });
}

function trackedStream(filename) {
  const stream = createWriteStream(filename, { flags: "wx" });
  let error = null;
  stream.on("error", value => { error = value; });
  return { stream, get error() { return error; }, async finish() { if (!stream.closed) await new Promise(resolve => stream.end(resolve)); if (error) throw error; } };
}

async function runComparison(rawConfig) {
  const config = validateComparisonConfig(rawConfig);
  const output = path.resolve(config.output, config.runId);
  await fs.mkdir(output, { recursive: false });
  const controllerLog = trackedStream(path.join(output, "controller.jsonl"));
  const rows = [], helpers = [];
  let serial = null, commandSequence = 0, closing = false, instrumentationError = null, fixedServer = null;
  const functionalFailures = [];
  const log = (type, data = {}) => {
    const event = { type, wallTime: new Date().toISOString(), wallMs: Date.now(), monoMs: performance.now(), ...data };
    if (!controllerLog.stream.write(`${JSON.stringify(event)}\n`)) void 0;
    process.stdout.write(`${JSON.stringify({ type, ...data })}\n`);
    return event;
  };
  const result = { schema: "kinopio-controlled-mesh-comparison/v1", runId: config.runId, policy: config.policy, workerPolicy: config.policy === "F-R" ? "F" : config.policy, kind: "controlled-broker-crash-exploratory-run", startedAt: new Date().toISOString(), configuration: config, fault: { kind: "broker-only-kill" }, checks: [], functionalFailures, limitations: ["A broker-process crash leaves SDK processes and host operating systems alive", "Background host load is recorded but uncontrolled", "Resource samples are partial per-process evidence, not total cost", "No continuous-delivery claim follows from isolated successful observations"] };
  const recordFailure = (stage, error) => { const entry = { stage, message: String(error?.message ?? error), at: new Date().toISOString() }; functionalFailures.push(entry); log("functionalFailure", entry); };
  const instrumentationFailure = message => { instrumentationError ??= message; throw Error(message); };

  function attachProcess(host, child, filename, kind) {
    const dataLog = trackedStream(path.join(output, filename));
    const errorLog = trackedStream(path.join(output, `${filename}.stderr`));
    const row = { host, child, kind, dataLog, errorLog, pending: new Map(), status: null, statusReceivedAt: 0, ready: null, snapshot: null, observations: new Map(), writes: new Map(), malformedLines: 0, errorEvents: 0, droppedEvents: 0, exited: false, closedEvent: null };
    child.stderr.pipe(errorLog.stream);
    row.ended = new Promise(resolve => child.once("close", resolve));
    child.once("exit", (code, signal) => {
      row.exited = true; row.exitCode = code; row.exitSignal = signal; log(`${kind}Exit`, { host: host.id, code, signal });
      for (const pending of row.pending.values()) { clearTimeout(pending.timer); pending.reject(Error(`${kind} exited`)); } row.pending.clear();
    });
    child.once("error", error => { instrumentationError ??= `${kind} spawn error on ${host.id}: ${error.message}`; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }); row.lines = lines;
    lines.on("line", line => {
      dataLog.stream.write(`${line}\n`);
      let event;
      try { event = JSON.parse(line); } catch { row.malformedLines++; instrumentationError ??= `Malformed ${kind} JSON on ${host.id}`; return; }
      if (!event || typeof event !== "object" || typeof event.type !== "string") { row.malformedLines++; instrumentationError ??= `Invalid ${kind} event on ${host.id}`; return; }
      if (event.type === "ready") row.ready = event;
      if (event.type === "status") { row.status = event; row.statusReceivedAt = performance.now(); }
      if (event.type === "observation") row.observations.set(event.sourceId, { seq: Math.max(row.observations.get(event.sourceId)?.seq ?? 0, event.seq), receivedAt: performance.now() });
      if (event.type === "write" && event.accepted && event.seq > (row.writes.get(event.key)?.seq ?? 0)) row.writes.set(event.key, event);
      if (event.type === "snapshot") row.snapshot = event;
      if (event.type === "closed") row.closedEvent = event;
      if (event.type === "error") { row.errorEvents++; instrumentationError ??= `${kind} error event on ${host.id}: ${event.error?.message ?? "unknown"}`; }
      if (event.outputEventsDropped || event.outputEventsDroppedTotal) { row.droppedEvents += event.outputEventsDropped ?? event.outputEventsDroppedTotal; instrumentationError ??= `Dropped ${kind} evidence on ${host.id}`; }
      if (event.type === "command" && row.pending.has(event.id)) { const pending = row.pending.get(event.id); row.pending.delete(event.id); clearTimeout(pending.timer); event.ok ? pending.resolve({ ...event.result, commandId: event.id }) : pending.reject(Error(event.error?.message ?? `${kind} command failed`)); }
    });
    return row;
  }

  function send(row, op, payload = {}, timeoutMs = 15000) {
    const id = ++commandSequence;
    return new Promise((resolve, reject) => {
      if (row.exited || row.child.stdin.destroyed) { reject(Error(`${row.kind} ${row.host.id} is not writable`)); return; }
      const timer = setTimeout(() => { row.pending.delete(id); reject(Error(`${row.host.id} ${op} timed out`)); }, timeoutMs);
      row.pending.set(id, { resolve, reject, timer });
      row.child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`, error => { if (error) { clearTimeout(timer); row.pending.delete(id); reject(error); } });
    });
  }

  async function untilStable(label, timeoutMs, requiredMs, expectedHost, fixed) {
    const deadline = performance.now() + timeoutMs; let stable = null;
    while (performance.now() < deadline) {
      if (instrumentationError) throw Error(instrumentationError);
      const dead = rows.find(row => row.exited); if (dead) throw Error(`${dead.host.id} worker exited before ${label}`);
      const state = commonEndpointState(rows, performance.now(), 4000, fixed);
      if (expectedHost && state.ok && state.leaderHost !== expectedHost) stable = null;
      else stable = advanceStableInterval(stable, state, performance.now(), requiredMs);
      if (stable?.achieved) return { ...state, stableSince: stable.since, stableForMs: performance.now() - stable.since };
      await delay(200);
    }
    throw Error(`${label} timed out`);
  }

  async function snapshots(label) {
    const replies = await Promise.all(rows.map(row => send(row, "snapshot")));
    const values = rows.map((row, index) => {
      const snapshot = row.snapshot;
      if (snapshot?.id !== replies[index].commandId || snapshot.runId !== config.runId || snapshot.sourceId !== row.host.id || snapshot.values?.length !== 64) instrumentationFailure(`Missing or mismatched ${label} snapshot from ${row.host.id}`);
      return { id: row.host.id, snapshot };
    });
    log("snapshots", { label, summaries: values.map(item => ({ id: item.id, sdk: item.snapshot.sdk, counters: item.snapshot.counters })) });
    return values;
  }

  async function close() {
    if (closing) return; closing = true;
    if (serial) { try { await serial.call("disconnect"); } catch {} serial.close(); }
    await Promise.allSettled(rows.filter(row => !row.exited).map(row => send(row, "close", {}, 10000)));
    await Promise.allSettled(helpers.filter(row => !row.exited).map(row => send(row, "close", {}, 10000)));
    for (const row of [...rows, ...helpers]) {
      if (!row.child.stdin.destroyed) row.child.stdin.end();
      await Promise.race([row.ended, delay(6000)]); if (!row.exited) row.child.kill("SIGTERM");
      row.lines.close();
      const flushed = await Promise.allSettled([row.dataLog.finish(), row.errorLog.finish()]);
      const failed = flushed.find(entry => entry.status === "rejected");
      if (failed) instrumentationError ??= `Failed to flush ${row.kind} output for ${row.host.id}: ${failed.reason?.message ?? failed.reason}`;
    }
  }

  process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
  try {
    const setupDeadline = performance.now() + config.setupTimeoutMs;
    const setupRemaining = () => Math.max(0, setupDeadline - performance.now());
    await fs.writeFile(path.join(output, "configuration.json"), JSON.stringify({ ...config, workerPolicy: result.workerPolicy }, null, 2), { flag: "wx" });
    const harnessDir = path.join(output, "harness"); await fs.mkdir(harnessDir);
    const harnessFiles = { "mesh-comparison.mjs": RUNNER_PATH, "mesh-study-worker.mjs": WORKER_PATH };
    if (config.policy === "F-R") harnessFiles["mesh-fixed-supervisor.mjs"] = fileURLToPath(new URL("./mesh-fixed-supervisor.mjs", import.meta.url));
    result.harnessHashes = {};
    for (const [name, filename] of Object.entries(harnessFiles)) { const bytes = await fs.readFile(filename); await fs.writeFile(path.join(harnessDir, name), bytes, { flag: "wx" }); result.harnessHashes[name] = hash(bytes); }

    if (config.policy === "F-R") {
      const host = config.hosts.find(item => item.id === config.fixedHost);
      const supervisorConfig = { sdkRoot: host.sdkBase, binary: host.binary, binarySha256: host.binarySha256, runId: config.runId, sourceId: "fixed-supervisor", advertiseAddress: host.advertiseAddress, restartDelayMs: 1000 };
      const filename = path.join(host.directory, `${config.runId}-fixed-supervisor.json`); await installConfig(host, filename, supervisorConfig);
      const helper = attachProcess(host, launch(host, `exec ${quote(host.node)} ${quote(host.supervisorPath)} --config ${quote(filename)}`), "fixed-supervisor.jsonl", "supervisor"); helpers.push(helper);
      const deadline = setupDeadline;
      while (!helper.ready && performance.now() < deadline) { if (helper.exited || instrumentationError) throw Error(instrumentationError ?? "Fixed supervisor exited during startup"); await delay(100); }
      if (!helper.ready?.server || !Number.isSafeInteger(helper.ready.port) || !helper.ready.provenance) instrumentationFailure("Fixed supervisor ready event is incomplete");
      fixedServer = helper.ready.server;
      result.fixedSupervisor = { host: host.id, ready: helper.ready };
    }

    const sourceIds = config.hosts.map(host => host.id);
    for (const host of config.hosts) {
      const sdkDir = config.policy === "F-R" ? host.sdkBase : host.sdkPolicy[config.policy];
      const workerConfig = { sdkPath: path.join(sdkDir, "src/node.mjs"), runId: config.runId, sourceId: host.id, sourceIds, policy: result.workerPolicy, namespace: config.runId, group: config.runId, meshBinary: host.binary, servers: fixedServer ? [fixedServer] : [], keys: 64, payloadBytes: 64, rateHz: 5 };
      const filename = path.join(host.directory, `${config.runId}-${host.id}.json`); await installConfig(host, filename, workerConfig);
      rows.push(attachProcess(host, launch(host, `exec ${quote(host.node)} ${quote(host.worker)} --config ${quote(filename)}`), `${host.id}.jsonl`, "worker"));
    }
    log("workersStarted", { runId: config.runId, policy: config.policy, workerPolicy: result.workerPolicy });
    const readyDeadline = setupDeadline;
    while (rows.some(row => !row.ready) && performance.now() < readyDeadline) { if (instrumentationError || rows.some(row => row.exited)) throw Error(instrumentationError ?? "Worker exited during startup"); await delay(100); }
    if (rows.some(row => !row.ready)) instrumentationFailure("Worker ready events timed out");
    const referenceHost = config.hosts.find(host => !host.ssh) ?? config.hosts[0];
    const referenceSdk = config.policy === "F-R" ? referenceHost.sdkBase : referenceHost.sdkPolicy[config.policy];
    const expectedFiles = {};
    for (const [name, relative] of Object.entries({ node: "src/node.mjs", meshElection: "src/mesh-election.mjs", meshNode: "src/mesh-node.mjs", meshBroker: "src/mesh-broker.mjs", hub: "src/hub.mjs", packageLock: "package-lock.json" })) expectedFiles[name] = hash(await fs.readFile(path.join(referenceSdk, relative)));
    expectedFiles.worker = result.harnessHashes["mesh-study-worker.mjs"];
    const expectedNode = rows[0].ready.runtime?.node;
    for (const row of rows) {
      const runtime = row.ready.runtime, provenance = runtime?.provenance;
      if (row.ready.runId !== config.runId || row.ready.sourceId !== row.host.id || row.ready.policy !== result.workerPolicy || runtime?.execPath !== row.host.node || runtime?.sdkPath !== path.join(config.policy === "F-R" ? row.host.sdkBase : row.host.sdkPolicy[config.policy], "src/node.mjs") || runtime?.node !== expectedNode || provenance?.meshBinary?.sha256 !== row.host.binarySha256 || Object.entries(expectedFiles).some(([name, expected]) => provenance?.files?.[name]?.sha256 !== expected)) instrumentationFailure(`Runtime provenance mismatch on ${row.host.id}`);
    }
    if (helpers[0]) {
      const ready = helpers[0].ready;
      if (ready.runId !== config.runId || ready.sourceId !== "fixed-supervisor" || ready.provenance?.files?.supervisor?.sha256 !== result.harnessHashes["mesh-fixed-supervisor.mjs"] || ready.provenance?.files?.binary?.sha256 !== helpers[0].host.binarySha256 || ready.provenance?.files?.meshBroker?.sha256 !== expectedFiles.meshBroker) instrumentationFailure("Fixed supervisor runtime provenance mismatch");
    }
    result.runtime = { node: expectedNode, expectedFiles, workers: rows.map(row => ({ id: row.host.id, runtime: row.ready.runtime, configuration: row.ready.configuration })) };
    await Promise.all(rows.map(row => send(row, "start")));
    const setup = await untilStable("initial stable common endpoint", setupRemaining(), config.initialStableMs, config.policy === "S" ? config.expectedLeaderHost : null, fixedServer);
    result.setup = setup; result.checks.push("fresh-common-endpoint-continuous-setup"); log("setupStable", setup);
    const setupSeed = await snapshots("setup-seed");
    if (!setupSeed.every(item => item.snapshot.values.every(value => value.value?.run === config.runId))) throw Error("Setup did not seed all 64 keys on every desktop SDK");
    if (setupRemaining() <= 0) throw Error("Setup timed out while verifying the 64-key seed");
    result.checks.push("setup-64-key-seed");
    if (config.serial) {
      serial = serialWorker(config.serial, config.python ?? "python3"); log("espWifi", { wifi: await serial.call("wifi") });
      await serial.call("configure", { namespace: config.runId, group: config.runId, server: fixedServer ?? "" });
      let espStatus, deadline = Math.min(setupDeadline, performance.now() + 60000);
      while (performance.now() < deadline) { espStatus = await serial.call("status"); if (espStatus.connection === "connected") break; await delay(500); }
      if (espStatus?.connection !== "connected") throw Error("ESP32 connection timed out");
      let read; deadline = Math.min(setupDeadline, performance.now() + 30000);
      while (performance.now() < deadline) { read = await serial.call("get", { name: "key-00" }); if (read.value?.run === config.runId) break; await delay(300); }
      if (read?.value?.run !== config.runId) throw Error("ESP32 did not obtain seeded desktop state");
      const probe = { run: config.runId, source: "esp32", probe: true };
      if (!await serial.call("set", { name: "esp-probe", value: probe })) throw Error("ESP32 write rejected");
      await serial.call("flush"); await delay(2000); const espSnapshots = await snapshots("esp-bidirectional");
      if (!espSnapshots.every(item => item.snapshot.espProbe?.value?.run === config.runId)) throw Error("ESP32 probe did not reach all desktop SDKs");
      if (setupRemaining() <= 0) throw Error("Setup timed out while verifying ESP32 bidirectional exchange");
      result.checks.push("esp32-bidirectional-seed");
    }

    const measurementStart = await Promise.all(rows.map(row => send(row, "mark", { phase: "measurementStart" })));
    result.phases = { measurementStart }; log("phaseMarked", { phase: "measurementStart", markers: measurementStart });
    await delay(config.baselineMs);
    const baseline = await snapshots("baseline-end");
    if (!baseline.every(item => item.snapshot.values.every(value => value.value?.run === config.runId))) recordFailure("baseline", Error("Not all 64 keys reached all desktop SDKs")); else result.checks.push("baseline-64-key-exchange");
    const baselineEnd = await Promise.all(rows.map(row => send(row, "mark", { phase: "baselineEnd" }))); result.phases.baselineEnd = baselineEnd;

    const faultRequest = log("faultRequest", { policy: config.policy });
    let faultAck;
    try {
      const target = config.policy === "F-R" ? helpers[0] : rows.find(row => row.status?.sdk?.mesh?.role === "leader");
      if (!target) throw Error("No broker owner available for fault injection");
      faultAck = await send(target, "killBroker"); result.fault = { ...result.fault, host: target.host.id, request: faultRequest, acknowledgement: log("faultAcknowledgement", { host: target.host.id, result: faultAck }) };
    } catch (error) { recordFailure("fault-injection", error); result.fault.error = error.message; }
    const immediate = await Promise.allSettled([snapshots("immediate-postfault"), ...helpers.map(helper => send(helper, "status"))]);
    result.immediatePostfault = immediate.map(entry => entry.status === "fulfilled" ? entry.value : { error: entry.reason.message });
    for (const entry of immediate) if (entry.status === "rejected") recordFailure("immediate-postfault-snapshot", entry.reason);
    const immediateSnapshots = immediate[0].status === "fulfilled" ? immediate[0].value : [];
    const postfaultThresholds = new Map(immediateSnapshots.map(item => [item.id, item.snapshot.counters.writeAttempts]));
    result.postfaultThresholds = Object.fromEntries(postfaultThresholds);
    const postfaultStart = await Promise.all(rows.map(row => send(row, "mark", { phase: "postfaultStart" }))); result.phases.postfaultStart = postfaultStart;
    log("phaseMarked", { phase: "postfaultStart", markers: postfaultStart });

    const postFaultBoundary = performance.now();
    const end = postFaultBoundary + config.postfaultMs; let connectionStable = null, connectionEverStable = false, connectionFirstStableAt = null, pairsEverFresh = false, pairFreshSamples = 0;
    while (performance.now() < end) {
      if (instrumentationError || rows.some(row => row.exited) || helpers.some(row => row.exited)) throw Error(instrumentationError ?? "Harness process exited during postfault observation");
      const state = commonEndpointState(rows, performance.now(), 4000, fixedServer);
      connectionStable = advanceStableInterval(connectionStable, state, performance.now(), config.recoveryStableMs);
      if (connectionStable.achieved && !connectionEverStable) { connectionEverStable = true; connectionFirstStableAt = performance.now(); }
      const directed = directedPairFreshness(rows, sourceIds, postFaultBoundary, performance.now(), 4000, postfaultThresholds);
      if (directed.ok) { pairsEverFresh = true; pairFreshSamples++; }
      await delay(Math.min(200, Math.max(1, end - performance.now())));
    }
    const finalDirected = directedPairFreshness(rows, sourceIds, postFaultBoundary, performance.now(), 4000, postfaultThresholds);
    result.postfaultEvidence = { fullWindowMs: config.postfaultMs, completed: true, connectedEndpointStableAtLeastOnce: connectionEverStable, connectedEndpointStableAtWindowEnd: Boolean(connectionStable?.achieved), firstStableAt: connectionFirstStableAt, stableSince: connectionStable?.since ?? null, signature: connectionStable?.signature ?? null, directedPairsEverSimultaneouslyFresh: pairsEverFresh, directedPairsFreshAtWindowEnd: finalDirected.ok, directedPairFreshSamples: pairFreshSamples, finalDirectedPairs: finalDirected.pairs };
    if (!connectionEverStable) recordFailure("postfault", Error("Connected common endpoint did not remain stable for the required interval"));
    if (!pairsEverFresh) recordFailure("postfault", Error("All directed desktop pairs were never simultaneously fresh after the fault"));
    if (!finalDirected.ok) recordFailure("postfault", Error("All directed desktop pairs were not fresh above their postfault thresholds at the window end"));
    const finalPostfault = await snapshots("postfault-end");
    if (serial) {
      const baselineMac = postfaultThresholds.get(sourceIds[0]) ?? Number.MAX_SAFE_INTEGER;
      const status = await serial.call("status"), read = await serial.call("get", { name: "key-00" });
      result.espPostfault = { status, read, threshold: baselineMac };
      if (status.connection !== "connected" || read.value?.run !== config.runId || read.value.seq <= baselineMac) recordFailure("esp-postfault", Error("ESP32 did not observe a postfault key-00 sequence")); else result.checks.push("esp32-postfault-sequence");
    }
    const measurementEnd = await Promise.all(rows.map(row => send(row, "mark", { phase: "measurementEnd" }))); result.phases.measurementEnd = measurementEnd;
    await Promise.all(rows.map(row => send(row, "stop"))); log("writesStopped", { drained: true }); await delay(config.quiescentMs);
    const final = await snapshots("quiescent-final");
    const signatures = final.map(item => JSON.stringify(item.snapshot.values.map(value => ({ key: value.key, value: value.value, version: value.meta.version, exists: value.meta.exists }))));
    result.finalAgreement = new Set(signatures).size === 1;
    result.finalOwnerEvidence = [];
    for (const [key, valueRow] of final[0].snapshot.values.entries()) {
      const owner = rows[key % rows.length], accepted = owner.writes.get(key);
      const value = valueRow.value;
      result.finalOwnerEvidence.push({ key, owner: owner.host.id, finalSeq: value?.seq ?? null, acceptedSeq: accepted?.seq ?? null, valueMatches: Boolean(accepted && value?.run === config.runId && value?.source === owner.host.id && value?.seq === accepted.seq && value?.key === key && value?.data === "x".repeat(64)), versionMatches: Boolean(accepted && JSON.stringify(valueRow.meta.version) === JSON.stringify(accepted.version)) });
    }
    if (!result.finalAgreement) recordFailure("final", Error("Quiescent values and versions do not agree"));
    if (!result.finalOwnerEvidence.every(item => item.valueMatches && item.versionMatches)) recordFailure("final", Error("Final state does not match each owner's last accepted write and version"));
    else result.checks.push("final-owner-write-value-version-match");
    result.finalCounters = final.map(item => ({ id: item.id, ...item.snapshot.counters }));
  } catch (error) {
    const message = String(error?.message ?? error);
    if (instrumentationError) result.fatalError = message; else { result.controllerError = message; recordFailure("controller", error); }
    log(instrumentationError ? "fatal" : "runFailed", { error: message }); process.exitCode = 1;
  } finally {
    await close();
    result.finishedAt = new Date().toISOString();
    result.instrumentation = { error: instrumentationError, workers: rows.map(row => ({ id: row.host.id, ready: Boolean(row.ready), malformedLines: row.malformedLines, errorEvents: row.errorEvents, droppedEvents: row.droppedEvents, exited: row.exited, exitCode: row.exitCode, exitSignal: row.exitSignal, closedEvent: row.closedEvent })), supervisors: helpers.map(row => ({ id: row.host.id, ready: Boolean(row.ready), malformedLines: row.malformedLines, errorEvents: row.errorEvents, droppedEvents: row.droppedEvents, exited: row.exited, exitCode: row.exitCode, exitSignal: row.exitSignal, closedEvent: row.closedEvent })) };
    const complete = !result.fatalError && !instrumentationError && rows.length === 3 && helpers.length === (config.policy === "F-R" ? 1 : 0) && [...rows, ...helpers].every(row => row.exited && row.exitCode === 0 && row.closedEvent?.runId === config.runId && row.closedEvent?.outputIntegrity === "complete" && row.closedEvent?.fatal === false && row.malformedLines === 0 && row.droppedEvents === 0 && row.errorEvents === 0);
    result.evidenceValidity = complete ? "complete" : "invalid-or-incomplete";
    result.outcome = complete && functionalFailures.length === 0 ? "passed" : "failed";
    if (result.outcome === "failed") process.exitCode = 1;
    await fs.writeFile(path.join(output, "result.json"), JSON.stringify(result, null, 2));
    await controllerLog.finish();
    process.stdout.write(`${JSON.stringify({ result: path.join(output, "result.json"), outcome: result.outcome, evidenceValidity: result.evidenceValidity })}\n`);
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== "--config") throw Error("Usage: mesh-comparison.mjs --config FILE");
  const config = JSON.parse(await fs.readFile(path.resolve(argv[1]), "utf8"));
  return runComparison(config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
