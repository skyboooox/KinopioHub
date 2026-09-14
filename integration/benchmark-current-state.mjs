import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import KinopioHub from "../../KinopioHub.JS/src/node.mjs";
import { startManagedBroker, BROKER_VERSION } from "../../KinopioHub.JS/src/mesh-broker.mjs";
import { connect } from "../../KinopioHub.JS/node_modules/@nats-io/transport-node/index.js";

// Run from the workspace root: node KinopioHub/integration/benchmark-current-state.mjs --output scratch/paper-benchmark/result.json
const root = fileURLToPath(new URL("../../", import.meta.url));
const sdkRoot = fileURLToPath(new URL("../../KinopioHub.JS/", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const defaults = { warmup: 200, samples: 1000, repetitions: 5, sizes: [64, 1024, 8192], timeoutMs: 5000 };
const allowedArguments = new Set(["warmup", "samples", "repetitions", "sizes", "timeout-ms", "output"]);
const args = {};
for (let index = 2; index < process.argv.length; index++) {
  const argument = process.argv[index];
  if (!argument.startsWith("--")) throw Error(`Unexpected argument: ${argument}`);
  const [key, ...rest] = argument.slice(2).split("=");
  if (!allowedArguments.has(key)) throw Error(`Unknown option: --${key}`);
  if (rest.length) {
    args[key] = rest.join("=");
  } else {
    const value = process.argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw Error(`Missing value for --${key}`);
    args[key] = value; index++;
  }
}
const number = (name, fallback) => args[name] === undefined ? fallback : Number(args[name]);
const config = {
  warmup: number("warmup", defaults.warmup), samples: number("samples", defaults.samples), repetitions: number("repetitions", defaults.repetitions),
  sizes: args.sizes === undefined ? defaults.sizes : args.sizes.split(",").map(Number), timeoutMs: number("timeout-ms", defaults.timeoutMs),
};
for (const [name, value] of Object.entries(config)) {
  const entries = Array.isArray(value) ? value : [value];
  if (!entries.length || entries.some(item => !Number.isInteger(item) || item <= 0)) throw Error(`Invalid --${name}`);
}

function command(command, commandArgs, cwd = root) {
  try { return execFileSync(command, commandArgs, { cwd, encoding: "utf8" }).trim(); } catch { return null; }
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(fraction * ordered.length) - 1)];
}
function statistics(samples) {
  const successful = samples.filter(sample => sample.latencyMs !== null).map(sample => sample.latencyMs);
  return { count: samples.length, successful: successful.length, errors: samples.length - successful.length, p50Ms: percentile(successful, 0.50), p95Ms: percentile(successful, 0.95), p99Ms: percentile(successful, 0.99), minMs: successful.length ? Math.min(...successful) : null, maxMs: successful.length ? Math.max(...successful) : null };
}
function payload(size, sequence) {
  // ASCII makes `payloadBytes` equal to the UTF-8 byte length without ambiguity.
  return { seq: sequence, data: "x".repeat(size) };
}
function serializedPayloadBytes(size, first, last) {
  const lengths = [];
  for (let sequence = first; sequence <= last; sequence++) lengths.push(new TextEncoder().encode(JSON.stringify(payload(size, sequence))).byteLength);
  return { dataUtf8Bytes: size, jsonValueUtf8Bytes: { min: Math.min(...lengths), max: Math.max(...lengths) } };
}
function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}
function errorRecord(error) {
  return { name: error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 500) };
}

async function sdkRound({ brokerUrl, size, repetition }) {
  const namespace = `paper-sdk-${randomUUID()}`;
  let writer, reader, stop;
  const samples = [], warmupErrors = [];
  let expected = null;
  try {
    const options = { mesh: false, discovery: false, servers: [brokerUrl], timeout: config.timeoutMs, probeInterval: 60000, healthInterval: 60000, peerTimeout: 25 };
    writer = new KinopioHub(namespace, options);
    reader = new KinopioHub(namespace, options);
    await withTimeout(Promise.all([writer.connected(), reader.connected()]), config.timeoutMs, "SDK connection");
    const writerVariable = writer.var("value");
    const readerVariable = reader.var("value");
    const waiting = new Map();
    stop = readerVariable.watch(value => {
      if (!value || value.seq !== expected) return; // Ignore initial and duplicate/stale observations.
      const entry = waiting.get(value.seq);
      if (entry) { waiting.delete(value.seq); entry.resolve(performance.now() - entry.started); }
    });
    async function one(sequence, keep) {
      const started = performance.now(); expected = sequence;
      const observed = new Promise((resolve, reject) => waiting.set(sequence, { started, resolve, reject }));
      try {
        await withTimeout(writerVariable.set(payload(size, sequence)), config.timeoutMs, "SDK set");
        const latencyMs = await withTimeout(observed, config.timeoutMs, "SDK watch observation");
        if (keep) samples.push({ seq: sequence, latencyMs });
      } catch (error) {
        waiting.delete(sequence);
        const entry = { seq: sequence, latencyMs: null, error: errorRecord(error) };
        if (keep) samples.push(entry); else warmupErrors.push(entry);
      }
    }
    for (let sequence = 1; sequence <= config.warmup; sequence++) await one(sequence, false);
    for (let sequence = config.warmup + 1; sequence <= config.warmup + config.samples; sequence++) await one(sequence, true);
  } finally {
    try { stop?.(); } catch {}
    await withTimeout(Promise.allSettled([writer?.close(), reader?.close()]), config.timeoutMs, "SDK cleanup");
  }
  return { implementation: "kinopiohub-js-current-state", sizeBytes: size, repetition, namespace, samples, warmupErrors, statistics: statistics(samples) };
}

async function natsRound({ brokerUrl, size, repetition }) {
  const subject = `paper.transport.${randomUUID()}`;
  let publisher, subscriber, subscription;
  const samples = [], warmupErrors = [];
  let expected = null;
  const waiting = new Map();
  try {
    [publisher, subscriber] = await withTimeout(Promise.all([
      connect({ servers: [brokerUrl], reconnect: false, timeout: config.timeoutMs }),
      connect({ servers: [brokerUrl], reconnect: false, timeout: config.timeoutMs }),
    ]), config.timeoutMs, "NATS connection");
    subscription = subscriber.subscribe(subject, { callback: (_error, message) => {
      try {
        const value = JSON.parse(new TextDecoder().decode(message.data));
        if (value.seq !== expected) return; // Filter any delayed or duplicate delivery by application sequence.
        const entry = waiting.get(value.seq);
        if (entry) { waiting.delete(value.seq); entry.resolve(performance.now() - entry.started); }
      } catch (error) {
        const entry = waiting.get(expected);
        if (entry) { waiting.delete(expected); entry.reject(error); }
      }
    } });
    await withTimeout(subscriber.flush(), config.timeoutMs, "NATS subscription setup");
    async function one(sequence, keep) {
      const started = performance.now(); expected = sequence;
      const observed = new Promise((resolve, reject) => waiting.set(sequence, { started, resolve, reject }));
      try {
        // The baseline publishes the same JSON value, but does not add SDK state, versioning, or peer synchronization.
        publisher.publish(subject, new TextEncoder().encode(JSON.stringify(payload(size, sequence))));
        const latencyMs = await withTimeout(observed, config.timeoutMs, "NATS subscription observation");
        if (keep) samples.push({ seq: sequence, latencyMs });
      } catch (error) {
        waiting.delete(sequence);
        const entry = { seq: sequence, latencyMs: null, error: errorRecord(error) };
        if (keep) samples.push(entry); else warmupErrors.push(entry);
      }
    }
    for (let sequence = 1; sequence <= config.warmup; sequence++) await one(sequence, false);
    for (let sequence = config.warmup + 1; sequence <= config.warmup + config.samples; sequence++) await one(sequence, true);
  } finally {
    try { subscription?.unsubscribe(); } catch {}
    await withTimeout(Promise.allSettled([publisher?.drain(), subscriber?.drain()]), config.timeoutMs, "NATS cleanup");
  }
  return { implementation: "nats-js-transport-only", sizeBytes: size, repetition, subject, samples, warmupErrors, statistics: statistics(samples) };
}

const report = {
  schema: "kinopiohub-current-state-local-pilot/v1", startedAt: new Date().toISOString(), passed: false,
  configuration: {
    ...config,
    sdkParameters: { mesh: false, discovery: false, probeInterval: 60000, healthInterval: 60000, peerTimeout: 25 },
    payloadEncoding: Object.fromEntries(config.sizes.map(size => [size, {
      allUpdates: serializedPayloadBytes(size, 1, config.warmup + config.samples),
      measuredUpdates: serializedPayloadBytes(size, config.warmup + 1, config.warmup + config.samples),
    }])),
  },
  methodology: {
    topology: "One ephemeral local NATS Core broker on 127.0.0.1; two Node SDK clients run in this Node process. Mesh and discovery are disabled.",
    order: "For every payload size and repetition, the current-state SDK round runs first and the raw NATS transport-only reference runs second.",
    repetitionIsolation: "Each round creates new client connections in the same Node process. SDK rounds use a fresh namespace and the variable value; raw NATS rounds use a fresh subject. All rounds share the one local broker.",
    tls: "off", payload: "payloadBytes is only the UTF-8 length of the ASCII `data` field. `configuration.payloadEncoding` records the actual serialized JSON byte ranges for `{seq, data}`. Both cases carry that same JSON value; the SDK additionally serializes its current-state record, version, and protocol fields.",
    observationMetric: "For each sequential update, latencyMs is `performance.now()` at immediately before SDK `set()` or NATS `publish()` through the reader watch/subscription callback for the matching application seq. `set()` completion and NATS flush are not used as the network observation endpoint.",
    baseline: "Raw NATS publish/subscribe is a transport-only reference and is not functionally equivalent to current-state synchronization.",
    limitations: "Loopback-only, TLS-off, same-host run; NATS is an ephemeral child process and both clients share one Node process. Results do not represent remote networks, browser runtimes, TLS, mesh/discovery, failures, or multi-host scheduling.",
  },
  environment: {
    node: process.version, platform: `${process.platform}/${process.arch}`, os: `${os.type()} ${os.release()}`, cpu: os.cpus()[0]?.model ?? null, cpuLogicalCores: os.cpus().length, memoryBytes: os.totalmem(),
    sourceScriptSha256: createHash("sha256").update(await fs.readFile(scriptPath)).digest("hex"),
    sdkCommit: command("git", ["rev-parse", "HEAD"], sdkRoot), sdkDirty: !!command("git", ["status", "--porcelain"], sdkRoot), sdkVersion: JSON.parse(await fs.readFile(path.join(sdkRoot, "package.json"), "utf8")).version,
    portalCommit: command("git", ["rev-parse", "HEAD"], fileURLToPath(new URL("../", import.meta.url))), natsServerVersion: BROKER_VERSION, natsClientVersion: "3.4.0",
  },
  rounds: [],
};
let broker;
try {
  broker = await startManagedBroker({ host: "127.0.0.1" });
  report.environment.brokerUrl = broker.url;
  for (const size of config.sizes) for (let repetition = 1; repetition <= config.repetitions; repetition++) {
    report.rounds.push(await sdkRound({ brokerUrl: broker.url, size, repetition }));
    report.rounds.push(await natsRound({ brokerUrl: broker.url, size, repetition }));
  }
  report.passed = report.rounds.every(round => round.statistics.errors === 0 && round.warmupErrors.length === 0);
} catch (error) {
  report.error = errorRecord(error);
} finally {
  try { await withTimeout(Promise.allSettled([broker?.close()]), config.timeoutMs, "Broker cleanup"); }
  catch (error) { report.cleanupError = errorRecord(error); report.passed = false; }
  report.finishedAt = new Date().toISOString();
}
const output = args.output ? path.resolve(root, args.output) : null;
if (output) { await fs.mkdir(path.dirname(output), { recursive: true }); await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`); }
process.stdout.write(`${JSON.stringify(report)}\n`);
if (!report.passed) process.exitCode = 1;
