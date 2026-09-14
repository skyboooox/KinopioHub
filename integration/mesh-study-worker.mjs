#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_QUEUE = 256;
const WORKER_PATH = fileURLToPath(import.meta.url);

function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw Error(`${label} must match [A-Za-z0-9_-]{1,80}`);
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  return value;
}

export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("config must be a JSON object");
  const sdkPath = input.sdkPath;
  if (typeof sdkPath !== "string" || !path.isAbsolute(sdkPath) || !sdkPath.endsWith(".mjs")) throw Error("sdkPath must be an absolute .mjs path");
  const sourceIds = input.sourceIds;
  if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 64) throw Error("sourceIds must contain 1 to 64 writers");
  const normalizedSources = sourceIds.map((value, index) => identifier(value, `sourceIds[${index}]`));
  if (new Set(normalizedSources).size !== normalizedSources.length) throw Error("sourceIds must be unique");
  const sourceId = identifier(input.sourceId, "sourceId");
  if (!normalizedSources.includes(sourceId)) throw Error("sourceIds must include sourceId");
  const policy = input.policy;
  if (!["F", "S", "Q"].includes(policy)) throw Error("policy must be F, S, or Q");
  const servers = input.servers === undefined ? [] : Array.isArray(input.servers) ? input.servers : [input.servers];
  if (servers.some(value => typeof value !== "string" || !/^(?:nats|tls|ws|wss):\/\//.test(value))) throw Error("servers must contain explicit NATS endpoints");
  if (policy === "F" && !servers.length) throw Error("policy F requires at least one server");
  if (policy !== "F" && input.group === undefined) throw Error("policy S/Q requires group");
  if (input.meshBinary !== undefined && (typeof input.meshBinary !== "string" || !path.isAbsolute(input.meshBinary))) throw Error("meshBinary must be an absolute path");
  return {
    sdkPath,
    runId: identifier(input.runId, "runId"),
    sourceId,
    sourceIds: normalizedSources,
    policy,
    group: policy === "F" ? null : identifier(input.group, "group"),
    namespace: identifier(input.namespace, "namespace"),
    servers,
    meshBinary: input.meshBinary,
    keys: integer(input.keys ?? 64, "keys", normalizedSources.length, 10000),
    payloadBytes: integer(input.payloadBytes ?? 64, "payloadBytes", 0, 60000),
    rateHz: integer(input.rateHz ?? 5, "rateHz", 1, 1000),
  };
}

export function ownedKeyIndexes(config) {
  const owner = config.sourceIds.indexOf(config.sourceId);
  return Array.from({ length: config.keys }, (_, index) => index).filter(index => index % config.sourceIds.length === owner);
}

function keyName(index, total) {
  return `key-${String(index).padStart(Math.max(2, String(total - 1).length), "0")}`;
}

function safeError(error) {
  return { code: error?.code ?? "WORKER_ERROR", message: String(error?.message ?? error).slice(0, 500) };
}

async function hashFile(filename) {
  const hash = createHash("sha256"), handle = await fs.open(filename, "r");
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead;
    }
  } finally { await handle.close(); }
  return { path: filename, bytes, sha256: hash.digest("hex") };
}

async function sourceProvenance(config) {
  const sourceDirectory = path.dirname(config.sdkPath), sdkRoot = path.dirname(sourceDirectory);
  const entries = {
    node: config.sdkPath,
    meshElection: path.join(sourceDirectory, "mesh-election.mjs"),
    meshNode: path.join(sourceDirectory, "mesh-node.mjs"),
    meshBroker: path.join(sourceDirectory, "mesh-broker.mjs"),
    hub: path.join(sourceDirectory, "hub.mjs"),
    packageLock: path.join(sdkRoot, "package-lock.json"),
    worker: WORKER_PATH,
  };
  const files = Object.fromEntries(await Promise.all(Object.entries(entries).map(async ([name, filename]) => [name, await hashFile(filename)])));
  return { files, meshBinary: config.meshBinary ? await hashFile(config.meshBinary) : null };
}

function eventWriter(output) {
  let blocked = false, closed = false, dropped = 0, totalDropped = 0;
  const queue = [];
  const stamp = event => JSON.stringify({ wallTime: new Date().toISOString(), wallMs: Date.now(), monoMs: performance.now(), ...event }) + "\n";
  const drain = () => {
    blocked = false;
    while (queue.length && !blocked) blocked = !output.write(queue.shift());
  };
  output.on?.("drain", drain);
  return {
    emit(event, critical = false) {
      if (closed && event.type !== "closed") return;
      const line = stamp(dropped ? { ...event, outputEventsDropped: dropped } : event); dropped = 0;
      if (!blocked && !queue.length) { blocked = !output.write(line); return; }
      if (queue.length < MAX_OUTPUT_QUEUE) queue.push(line);
      else if (critical) { queue.shift(); dropped++; totalDropped++; queue.push(line); }
      else { dropped++; totalDropped++; }
    },
    async finish(event) {
      if (closed) return; closed = true;
      if (queue.length >= MAX_OUTPUT_QUEUE) { queue.shift(); dropped++; totalDropped++; }
      const line = stamp({ ...event, outputEventsDropped: dropped, outputEventsDroppedTotal: totalDropped, outputIntegrity: totalDropped ? "incomplete" : "complete", fatal: totalDropped > 0 }); dropped = 0;
      if (!blocked && !queue.length) blocked = !output.write(line); else queue.push(line);
      if (!blocked) drain();
      if (blocked || queue.length) await Promise.race([new Promise(resolve => output.once?.("drain", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
    },
    stats() { return { outputEventsDropped: dropped, outputEventsDroppedTotal: totalDropped, outputQueueDepth: queue.length }; },
  };
}

async function processRows() {
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,command="], { maxBuffer: 4 * 1024 * 1024 });
    return stdout.split("\n").map(line => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([0-9.]+)\s+(.*)$/);
      return match && { pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, cpuPercent: Number(match[4]), command: match[5] };
    }).filter(Boolean);
  } catch { return []; }
}

async function ownedBrokerProcess(sdkPath) {
  const rows = await processRows();
  const sdkDirectory = path.dirname(sdkPath);
  const watchdogs = rows.filter(row => row.ppid === process.pid && row.command.includes("mesh-watchdog.mjs") && row.command.includes(sdkDirectory));
  if (watchdogs.length !== 1) return { watchdogPid: watchdogs[0]?.pid ?? null, broker: null, reason: watchdogs.length ? "multiple-watchdogs" : "no-watchdog" };
  const children = rows.filter(row => row.ppid === watchdogs[0].pid);
  if (children.length !== 1) return { watchdogPid: watchdogs[0].pid, broker: null, reason: children.length ? "multiple-watchdog-children" : "no-broker-child" };
  return { watchdogPid: watchdogs[0].pid, broker: children[0], reason: null };
}

function interfaces() {
  return Object.fromEntries(Object.entries(os.networkInterfaces()).map(([name, rows]) => [name, (rows ?? []).map(({ address, family, internal, mac }) => ({ address, family, internal, mac }))]));
}

export async function createStudyWorker(rawConfig, dependencies = {}) {
  const config = validateConfig(rawConfig);
  const input = dependencies.input ?? process.stdin, output = dependencies.output ?? process.stdout;
  const writer = eventWriter(output);
  const KinopioHub = dependencies.KinopioHub ?? (await import(pathToFileURL(config.sdkPath).href)).default;
  const provenance = await (dependencies.provenanceProvider ?? sourceProvenance)(config);
  const hubOptions = config.policy === "F"
    ? { servers: config.servers, mesh: false, discovery: false }
    : { mesh: { group: config.group, ...(config.meshBinary ? { binary: config.meshBinary } : {}) } };
  const hub = new KinopioHub(config.namespace, hubOptions);
  const variables = Array.from({ length: config.keys }, (_, index) => hub.var(keyName(index, config.keys)));
  const owned = ownedKeyIndexes(config);
  const sourceSet = new Set(config.sourceIds), lastObserved = new Map(), stops = [];
  const counters = { writeAttempts: 0, writesAccepted: 0, writesRejected: 0, observations: 0, duplicatesFiltered: 0, ownFiltered: 0, invalidFiltered: 0 };
  let sequence = 0, writeCursor = 0, writeTimer = null, statusTimer = null, closing = null, commandTask = Promise.resolve(), statusSampling = false;
  const outstandingWrites = new Set();
  const phases = ["measurementStart", "baselineEnd", "postfaultStart", "measurementEnd"];
  let lastPhase = null;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  let previousCpu = process.cpuUsage(), previousCpuAt = performance.now();

  for (let index = 0; index < variables.length; index++) stops.push(variables[index].watch((value, meta) => {
    if (!meta?.exists || value === undefined) return;
    if (!value || typeof value !== "object" || value.run !== config.runId || !sourceSet.has(value.source) || !Number.isSafeInteger(value.seq) || value.seq < 1 || value.key !== index || index % config.sourceIds.length !== config.sourceIds.indexOf(value.source)) { counters.invalidFiltered++; return; }
    if (value.source === config.sourceId) { counters.ownFiltered++; return; }
    const identity = `${value.source}:${index}`, previous = lastObserved.get(identity) ?? 0;
    if (value.seq <= previous) { counters.duplicatesFiltered++; return; }
    lastObserved.set(identity, value.seq); counters.observations++;
    writer.emit({ type: "observation", runId: config.runId, receiver: config.sourceId, sourceId: value.source, seq: value.seq, key: index, version: meta.version, connected: meta.connected });
  }));

  async function sampleStatus(reason = "periodic") {
    if (statusSampling || closing) return;
    statusSampling = true;
    try {
      const now = performance.now(), totalCpu = process.cpuUsage(), cpu = process.cpuUsage(previousCpu), elapsed = Math.max(1, now - previousCpuAt);
      previousCpu = totalCpu; previousCpuAt = now;
      const ownedProcess = config.policy === "F" ? null : await ownedBrokerProcess(config.sdkPath);
      writer.emit({ type: "status", reason, runId: config.runId, sourceId: config.sourceId, sdk: hub.status(), counters: { ...counters }, resources: {
        worker: { pid: process.pid, memory: process.memoryUsage(), rssBytes: process.memoryUsage().rss, cpuUserMicros: cpu.user, cpuSystemMicros: cpu.system, cpuUserMicrosCumulative: totalCpu.user, cpuSystemMicrosCumulative: totalCpu.system, cpuPercent: (cpu.user + cpu.system) / (elapsed * 10) },
        ownedBroker: ownedProcess?.broker ? { pid: ownedProcess.broker.pid, ppid: ownedProcess.broker.ppid, rssBytes: ownedProcess.broker.rssBytes, cpuPercentLifetime: ownedProcess.broker.cpuPercent, watchdogPid: ownedProcess.watchdogPid } : null,
        ownedBrokerUnavailableReason: ownedProcess?.reason ?? null,
        limitation: "ps broker CPU is a lifetime average; external F brokers, watchdog overhead, and unmatched transition processes are outside this sample",
      } });
    } catch (error) { writer.emit({ type: "error", operation: "status", error: safeError(error) }, true); }
    finally { statusSampling = false; }
  }

  function stopWrites() {
    if (!writeTimer) return false;
    clearInterval(writeTimer); writeTimer = null; return true;
  }

  async function drainWrites() {
    await Promise.allSettled([...outstandingWrites]);
  }

  function allowedPhase(phase) {
    if (!phases.includes(phase)) throw Error("phase must be measurementStart, baselineEnd, postfaultStart, or measurementEnd");
    if (lastPhase === phase) throw Error(`duplicate phase marker: ${phase}`);
    if (phase === "measurementStart") {
      if (lastPhase !== null) throw Error("measurementStart must be the first phase marker");
      return;
    }
    if (phase === "baselineEnd" && lastPhase === "measurementStart") return;
    if (phase === "postfaultStart" && lastPhase === "baselineEnd") return;
    // A run may end directly after measurementStart or baselineEnd when it is aborted or has no fault phase.
    if (phase === "measurementEnd" && ["measurementStart", "baselineEnd", "postfaultStart"].includes(lastPhase)) return;
    throw Error(`${phase} is not valid after ${lastPhase ?? "no phase marker"}`);
  }

  function mark(phase, id = null) {
    allowedPhase(phase);
    lastPhase = phase;
    const monoMs = performance.now();
    writer.emit({ type: "phaseMarker", phase, id, runId: config.runId, sourceId: config.sourceId, monoMs });
    if (phase === "measurementStart") writer.emit({ type: "observationWindowStarted", phase, id, runId: config.runId, sourceId: config.sourceId, monoMs });
    if (phase === "measurementEnd") writer.emit({ type: "observationWindowEnded", phase, id, runId: config.runId, sourceId: config.sourceId, monoMs });
    return { phase, monoMs };
  }

  function writeOne() {
    if (!owned.length || closing) return;
    const key = owned[writeCursor++ % owned.length], seq = ++sequence;
    counters.writeAttempts++;
    const value = { run: config.runId, source: config.sourceId, seq, key, data: "x".repeat(config.payloadBytes) };
    let setPromise;
    try {
      const write = variables[key].set(value);
      // Current SDK set() updates meta synchronously. Preserve that version before another write can replace it.
      const acceptedVersion = variables[key].meta.version;
      setPromise = Promise.resolve(write).then(() => {
        counters.writesAccepted++;
        writer.emit({ type: "write", accepted: true, runId: config.runId, sourceId: config.sourceId, seq, key, version: acceptedVersion ?? variables[key].meta.version });
      }, error => {
        counters.writesRejected++;
        writer.emit({ type: "write", accepted: false, runId: config.runId, sourceId: config.sourceId, seq, key, error: safeError(error) }, true);
      });
    } catch (error) {
      counters.writesRejected++;
      writer.emit({ type: "write", accepted: false, runId: config.runId, sourceId: config.sourceId, seq, key, error: safeError(error) }, true);
      return;
    }
    outstandingWrites.add(setPromise);
    void setPromise.finally(() => outstandingWrites.delete(setPromise));
  }

  function startWrites() {
    if (writeTimer || !owned.length) return false;
    writeTimer = setInterval(writeOne, 1000 / config.rateHz); return true;
  }

  async function close(reason = "command") {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      stopWrites(); clearInterval(statusTimer); lines.close(); await drainWrites(); for (const stop of stops) stop();
      try { await hub.close(); }
      catch (error) { writer.emit({ type: "error", operation: "close", error: safeError(error) }, true); }
      await writer.finish({ type: "closed", reason, runId: config.runId, sourceId: config.sourceId, counters: { ...counters } });
    }).finally(resolveDone);
    return closing;
  }

  async function command(message) {
    const id = message?.id ?? null, op = message?.op;
    try {
      if (!message || typeof message !== "object" || typeof op !== "string") throw Error("command must contain op");
      let result;
      if (op === "start") result = { started: startWrites(), ownedKeys: owned };
      else if (op === "stop") { result = { stopped: stopWrites() }; await drainWrites(); result.writesDrained = true; }
      else if (op === "mark") result = mark(message.phase, id);
      else if (op === "snapshot") {
        const values = variables.map((variable, key) => ({ key, value: variable.value, meta: variable.meta }));
        const espVariable = hub.var("esp-probe");
        const espProbe = { value: espVariable.value, meta: espVariable.meta };
        writer.emit({ type: "snapshot", id, runId: config.runId, sourceId: config.sourceId, sdk: hub.status(), counters: { ...counters }, values, espProbe });
        result = { keys: values.length };
      } else if (op === "killBroker") {
        if (config.policy === "F" || hub.status().mesh?.role !== "leader") throw Error("this worker does not currently own the elected broker");
        const ownedProcess = await ownedBrokerProcess(config.sdkPath);
        if (!ownedProcess.broker) throw Error(`owned broker identity unavailable: ${ownedProcess.reason}`);
        process.kill(ownedProcess.broker.pid, 0); process.kill(ownedProcess.broker.pid, "SIGKILL");
        result = { killed: true, brokerPid: ownedProcess.broker.pid, watchdogPid: ownedProcess.watchdogPid };
      } else if (op === "close") { writer.emit({ type: "command", id, op, ok: true, result: { closing: true } }); await close("command"); return; }
      else throw Error(`unsupported command: ${op}`);
      writer.emit({ type: "command", id, op, ok: true, result });
    } catch (error) { writer.emit({ type: "command", id, op: typeof op === "string" ? op : null, ok: false, error: safeError(error) }, true); }
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on("line", line => {
    if (line.length > 65536) { writer.emit({ type: "error", operation: "stdin", error: { code: "COMMAND_TOO_LARGE", message: "command exceeds 64 KiB" } }, true); return; }
    let message;
    try { message = JSON.parse(line); }
    catch (error) { writer.emit({ type: "command", id: null, op: null, ok: false, error: safeError(error) }, true); return; }
    commandTask = commandTask.then(() => command(message)).catch(error => writer.emit({ type: "error", operation: "command", error: safeError(error) }, true));
  });
  lines.once("close", () => { if (!closing) void close("stdin-eof"); });

  try {
    await hub.ready();
    writer.emit({ type: "ready", runId: config.runId, sourceId: config.sourceId, policy: config.policy, ownedKeys: owned, configuration: { namespace: config.namespace, group: config.group, servers: config.servers, meshBinary: config.meshBinary ?? null, keys: config.keys, payloadBytes: config.payloadBytes, rateHz: config.rateHz }, runtime: { pid: process.pid, node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch, hostname: os.hostname(), sdkPath: config.sdkPath, sdk: hub.status(), interfaces: interfaces(), provenance } }, true);
    await sampleStatus("ready"); statusTimer = setInterval(() => { void sampleStatus(); }, 1000);
  } catch (error) {
    writer.emit({ type: "error", operation: "startup", error: safeError(error) }, true); await close("startup-error"); throw error;
  }

  return { config, hub, close, command, mark, done };
}

async function main() {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--config") throw Error("usage: node mesh-study-worker.mjs --config config.json");
    const filename = path.resolve(process.argv[3]);
    const config = JSON.parse(await fs.readFile(filename, "utf8"));
    const normalized = validateConfig(config); await fs.access(normalized.sdkPath); if (normalized.meshBinary) await fs.access(normalized.meshBinary);
    const worker = await createStudyWorker(normalized);
    const terminate = () => { void worker.close("signal"); };
    process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
  } catch (error) {
    process.stdout.write(JSON.stringify({ wallTime: new Date().toISOString(), wallMs: Date.now(), monoMs: performance.now(), type: "error", operation: "bootstrap", error: safeError(error) }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
