#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const SUPERVISOR_PATH = fileURLToPath(import.meta.url);
const MAX_OUTPUT_QUEUE = 256;
const MAX_CONSECUTIVE_RESTART_FAILURES = 5;

function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) throw Error(`${label} must match [A-Za-z0-9_-]{1,80}`);
  return value;
}

function safeError(error) {
  return { code: error?.code ?? "SUPERVISOR_ERROR", message: String(error?.message ?? error).slice(0, 500) };
}

export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw Error("config must be a JSON object");
  for (const name of ["sdkRoot", "binary"]) {
    if (typeof input[name] !== "string" || !path.isAbsolute(input[name])) throw Error(`${name} must be an absolute path`);
  }
  if (typeof input.binarySha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.binarySha256)) throw Error("binarySha256 must be a lowercase SHA-256 digest");
  if (typeof input.advertiseAddress !== "string" || !input.advertiseAddress || /[\s/\0]/.test(input.advertiseAddress)) throw Error("advertiseAddress must be a hostname or address without a scheme or port");
  if (input.restartDelayMs !== 1000) throw Error("restartDelayMs must be exactly 1000");
  return {
    sdkRoot: path.resolve(input.sdkRoot), binary: path.resolve(input.binary), binarySha256: input.binarySha256,
    runId: identifier(input.runId, "runId"), sourceId: identifier(input.sourceId, "sourceId"),
    advertiseAddress: input.advertiseAddress, restartDelayMs: 1000,
  };
}

export async function hashFile(filename) {
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

export async function collectProvenance(config) {
  const files = {
    supervisor: SUPERVISOR_PATH,
    binary: config.binary,
    meshBroker: path.join(config.sdkRoot, "src", "mesh-broker.mjs"),
    watchdog: path.join(config.sdkRoot, "src", "mesh-watchdog.mjs"),
  };
  const result = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([name, filename]) => [name, await hashFile(filename)])));
  if (result.binary.sha256 !== config.binarySha256) {
    const error = Error(`binary SHA-256 mismatch: expected ${config.binarySha256}, received ${result.binary.sha256}`);
    error.code = "BINARY_HASH_MISMATCH"; throw error;
  }
  return { files: result };
}

function createEventWriter(output, onFailure) {
  let blocked = false, closed = false, pendingDropped = 0, totalDropped = 0, streamError = null;
  const queue = [];
  const stamp = event => JSON.stringify({ wallTime: new Date().toISOString(), wallMs: Date.now(), monoMs: performance.now(), ...event }) + "\n";
  const fail = error => { if (streamError) return; streamError = safeError(error); onFailure?.(error); };
  const drain = () => {
    blocked = false;
    while (queue.length && !blocked && !streamError) blocked = !output.write(queue.shift());
  };
  output.on?.("drain", drain); output.on?.("error", fail);
  return {
    emit(event, critical = false) {
      if (closed || streamError) return false;
      const line = stamp(pendingDropped ? { ...event, outputEventsDropped: pendingDropped } : event); pendingDropped = 0;
      if (!blocked && !queue.length) { blocked = !output.write(line); return true; }
      if (queue.length < MAX_OUTPUT_QUEUE) queue.push(line);
      else if (critical) { queue.shift(); pendingDropped++; totalDropped++; queue.push(line); }
      else { pendingDropped++; totalDropped++; }
      return true;
    },
    async finish(event) {
      if (closed) return { outputIntegrity: totalDropped || streamError ? "incomplete" : "complete", outputEventsDroppedTotal: totalDropped, fatal: Boolean(event?.fatal || totalDropped || streamError) };
      closed = true;
      if (queue.length >= MAX_OUTPUT_QUEUE) { queue.shift(); pendingDropped++; totalDropped++; }
      const summary = { outputIntegrity: totalDropped || streamError ? "incomplete" : "complete", outputEventsDroppedTotal: totalDropped, fatal: Boolean(event?.fatal || totalDropped || streamError) };
      const line = stamp({ ...event, ...summary, ...(streamError ? { outputError: streamError } : {}), outputEventsDropped: pendingDropped });
      pendingDropped = 0;
      if (!streamError) {
        if (!blocked && !queue.length) blocked = !output.write(line); else queue.push(line);
        if (!blocked) drain();
        if (blocked || queue.length) await Promise.race([new Promise(resolve => output.once?.("drain", resolve)), new Promise(resolve => setTimeout(resolve, 1000))]);
      }
      return summary;
    },
    stats() { return { outputQueueDepth: queue.length, outputEventsDropped: pendingDropped, outputEventsDroppedTotal: totalDropped, outputError: streamError }; },
  };
}

async function processRows() {
  if (process.platform === "win32") throw Error("strict process ownership inspection is unavailable on Windows");
  const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,command="], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split("\n").map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    return match && { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] };
  }).filter(Boolean);
}

export async function verifyOwnedBroker(record, rowsProvider = processRows) {
  if (!record || !Number.isSafeInteger(record.brokerPid) || !Number.isSafeInteger(record.watchdogPid)) throw Error("no recorded broker generation is active");
  const rows = await rowsProvider();
  const watchdog = rows.find(row => row.pid === record.watchdogPid);
  if (!watchdog || watchdog.ppid !== process.pid) throw Error("recorded watchdog is not a live direct child of this supervisor");
  const children = rows.filter(row => row.ppid === record.watchdogPid);
  if (children.length !== 1 || children[0].pid !== record.brokerPid) throw Error("recorded watchdog does not own exactly the recorded NATS child");
  const broker = children[0];
  if (broker.command !== record.binary && !broker.command.startsWith(`${record.binary} `)) throw Error("recorded child command does not identify the configured NATS binary");
  return { watchdog, broker };
}

function advertisedServer(address, port) {
  return `nats://${address.includes(":") ? `[${address}]` : address}:${port}`;
}

export async function createFixedBrokerSupervisor(rawConfig, dependencies = {}) {
  const config = validateConfig(rawConfig);
  const input = dependencies.input ?? process.stdin, output = dependencies.output ?? process.stdout;
  const scheduleTimeout = dependencies.setTimeout ?? setTimeout, cancelTimeout = dependencies.clearTimeout ?? clearTimeout;
  let closeTask = null, lifecycleTask = Promise.resolve(), restartTimer = null, startAbort = null, current = null;
  let allocation = null, generation = 0, restartFailures = 0, statusTimer = null, fatalError = null, lines;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const writer = createEventWriter(output, error => { fatalError ??= error; void close("output-error"); });
  const provenance = await (dependencies.provenanceProvider ?? collectProvenance)(config);
  const startManagedBroker = dependencies.startManagedBroker ?? (await import(pathToFileURL(path.join(config.sdkRoot, "src", "mesh-broker.mjs")).href)).startManagedBroker;

  const brokerState = () => current ? {
    generation: current.generation, server: advertisedServer(config.advertiseAddress, current.port), port: current.port, wsPort: current.wsPort,
    pid: current.brokerPid, watchdogPid: current.watchdogPid,
  } : null;

  function emitStatus(reason = "periodic") {
    const state = { type: "status", reason, runId: config.runId, sourceId: config.sourceId, broker: brokerState(), restartPending: Boolean(restartTimer), restartFailures, output: writer.stats() };
    writer.emit(state, reason !== "periodic"); return state;
  }

  function scheduleRestart(cause) {
    if (closeTask || restartTimer) return;
    const scheduledAtMonoMs = performance.now();
    writer.emit({ type: "restartScheduled", runId: config.runId, sourceId: config.sourceId, delayMs: config.restartDelayMs, scheduledAtMonoMs, cause }, true);
    restartTimer = scheduleTimeout(() => {
      restartTimer = null;
      lifecycleTask = lifecycleTask.then(() => launch("restart", false));
    }, config.restartDelayMs);
  }

  async function generationEnded(record, details) {
    if (record.ended || current !== record) return;
    record.ended = true; current = null;
    writer.emit({ type: "brokerExited", runId: config.runId, sourceId: config.sourceId, generation: record.generation, pid: record.brokerPid, watchdogPid: record.watchdogPid, ...details }, true);
    try { await record.handle.close(); }
    catch (error) { writer.emit({ type: "error", operation: "broker-cleanup", generation: record.generation, error: safeError(error) }, true); }
    scheduleRestart("watchdog-exit");
  }

  async function launch(reason, initial) {
    if (closeTask) return;
    startAbort = new AbortController();
    const nextGeneration = generation + 1;
    try {
      const handle = await startManagedBroker({ host: "0.0.0.0", binary: config.binary, ...(allocation ? { port: allocation.port, wsPort: allocation.wsPort } : {}), signal: startAbort.signal });
      if (closeTask) { await handle.close(); return; }
      if (![handle.port, handle.wsPort, handle.pid, handle.child?.pid].every(Number.isSafeInteger)) throw Error("managed broker returned incomplete process or endpoint identity");
      if (!allocation) allocation = { port: handle.port, wsPort: handle.wsPort };
      else if (handle.port !== allocation.port || handle.wsPort !== allocation.wsPort) {
        await handle.close(); throw Error("managed broker restart changed the frozen endpoint");
      }
      generation = nextGeneration; restartFailures = 0;
      const record = { generation, handle, port: handle.port, wsPort: handle.wsPort, brokerPid: handle.pid, watchdogPid: handle.child.pid, binary: config.binary, ended: false };
      current = record;
      const ended = (kind, value) => { void generationEnded(record, kind === "exit" ? { exitCode: value[0] ?? null, exitSignal: value[1] ?? null } : { error: safeError(value[0]) }); };
      handle.child.once("exit", (...value) => ended("exit", value));
      handle.child.once("error", (...value) => ended("error", value));
      writer.emit({ type: "brokerStarted", reason, runId: config.runId, sourceId: config.sourceId, ...brokerState() }, true);
      if (handle.child.exitCode !== null || handle.child.signalCode) void generationEnded(record, { exitCode: handle.child.exitCode, exitSignal: handle.child.signalCode });
      if (initial) writer.emit({ type: "ready", runId: config.runId, sourceId: config.sourceId, ...brokerState(), provenance }, true);
    } catch (error) {
      if (closeTask || startAbort?.signal.aborted) return;
      writer.emit({ type: "error", operation: initial ? "startup" : "restart", attempt: initial ? 1 : restartFailures + 1, error: safeError(error) }, true);
      if (initial) { fatalError = error; void close("startup-error"); return; }
      restartFailures++;
      if (restartFailures >= MAX_CONSECUTIVE_RESTART_FAILURES) { fatalError = error; void close("restart-exhausted"); return; }
      scheduleRestart("restart-failed");
    } finally { startAbort = null; }
  }

  async function killBroker() {
    const record = current;
    const owned = await verifyOwnedBroker(record, dependencies.processRowsProvider);
    const killedAtMonoMs = performance.now();
    const killProcess = dependencies.killProcess ?? process.kill;
    killProcess(owned.broker.pid, 0);
    killProcess(owned.broker.pid, "SIGKILL");
    writer.emit({ type: "brokerKillRequested", runId: config.runId, sourceId: config.sourceId, generation: record.generation, pid: owned.broker.pid, watchdogPid: owned.watchdog.pid, monoMs: killedAtMonoMs }, true);
    return { killed: true, pid: owned.broker.pid, brokerPid: owned.broker.pid, watchdogPid: owned.watchdog.pid, monoMs: killedAtMonoMs };
  }

  async function close(reason = "command") {
    if (closeTask) return closeTask;
    closeTask = Promise.resolve().then(async () => {
      if (restartTimer) { cancelTimeout(restartTimer); restartTimer = null; }
      startAbort?.abort();
      clearInterval(statusTimer); lines?.close();
      await lifecycleTask.catch(() => {});
      const record = current; current = null;
      if (record) {
        record.ended = true;
        try { await Promise.race([record.handle.close(), new Promise((_, reject) => setTimeout(() => reject(Error("broker cleanup timed out")), 5000))]); }
        catch (error) { fatalError ??= error; writer.emit({ type: "error", operation: "close", error: safeError(error) }, true); }
      }
      const summary = await writer.finish({ type: "closed", reason, runId: config.runId, sourceId: config.sourceId, fatal: Boolean(fatalError), ...(fatalError ? { error: safeError(fatalError) } : {}) });
      const result = { reason, ...summary, fatal: Boolean(fatalError || summary.fatal) };
      resolveDone(result); return result;
    });
    return closeTask;
  }

  async function command(message) {
    const id = message?.id ?? null, op = message?.op;
    try {
      if (!message || typeof message !== "object" || typeof op !== "string") throw Error("command must contain op");
      let result;
      if (op === "status") result = emitStatus("command");
      else if (op === "killBroker") result = await killBroker();
      else if (op === "close") { writer.emit({ type: "command", id, op, ok: true, result: { closing: true } }, true); await close("command"); return; }
      else throw Error(`unsupported command: ${op}`);
      writer.emit({ type: "command", id, op, ok: true, result }, true);
    } catch (error) { writer.emit({ type: "command", id, op: typeof op === "string" ? op : null, ok: false, error: safeError(error) }, true); }
  }

  let commandTask = Promise.resolve();
  lines = createInterface({ input, crlfDelay: Infinity });
  input.once?.("end", () => { if (!closeTask) void close("stdin-eof"); });
  input.once?.("finish", () => { if (!closeTask) void close("stdin-eof"); });
  lines.on("line", line => {
    if (line.length > 65536) { writer.emit({ type: "command", id: null, op: null, ok: false, error: { code: "COMMAND_TOO_LARGE", message: "command exceeds 64 KiB" } }, true); return; }
    let message;
    try { message = JSON.parse(line); } catch (error) { writer.emit({ type: "command", id: null, op: null, ok: false, error: safeError(error) }, true); return; }
    if (message?.op === "close") { void command(message); return; }
    commandTask = commandTask.then(() => command(message)).catch(error => writer.emit({ type: "error", operation: "command", error: safeError(error) }, true));
  });
  lines.once("close", () => { if (!closeTask) void close("stdin-eof"); });

  lifecycleTask = launch("boot", true);
  await lifecycleTask;
  if (!closeTask) { emitStatus("ready"); statusTimer = setInterval(() => emitStatus(), 1000); }
  return { config, provenance, command, close, done, status: brokerState };
}

async function main() {
  let supervisor;
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--config") throw Error("usage: node mesh-fixed-supervisor.mjs --config config.json");
    const config = JSON.parse(await fs.readFile(path.resolve(process.argv[3]), "utf8"));
    supervisor = await createFixedBrokerSupervisor(config);
    const terminate = () => { void supervisor.close("signal"); };
    process.once("SIGTERM", terminate); process.once("SIGINT", terminate);
    const result = await supervisor.done;
    if (result.fatal) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(JSON.stringify({ wallTime: new Date().toISOString(), wallMs: Date.now(), monoMs: performance.now(), type: "error", operation: "bootstrap", error: safeError(error) }) + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
