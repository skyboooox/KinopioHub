#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import KinopioHub from "../../KinopioHub.JS/src/node.mjs";
import { BROKER_VERSION, startManagedBroker } from "../../KinopioHub.JS/src/mesh-broker.mjs";
import { serialWorker } from "./arduino-worker.mjs";
import { createPinnedBroker, startLink } from "./edge-web-link.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(here, "../..");
const sdkRoot = path.join(workspace, "KinopioHub.JS");
const NAMES = { parameter: "parameter", sample: "sample", result: "result" };

function usage(error) {
  if (error) console.error(error);
  console.error("Usage: node KinopioHub/integration/edge-web-pilot.mjs --mode auto|fixed --output scratch/<file>.jsonl [--timeout-ms 60000] [--cut-ms 3000] [--input 7] [--multiplier 3] [--offset 2] [--local-smoke]");
  process.exit(error ? 2 : 0);
}

function argumentsOf(argv) {
  const result = { mode: "auto", timeoutMs: 60000, cutMs: null, input: 7, multiplier: 3, offset: 2, localSmoke: false };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === "--help") usage();
    if (key === "--local-smoke") { result.localSmoke = true; continue; }
    const value = argv[++index];
    if (value === undefined) usage(`Missing value for ${key}`);
    if (key === "--mode") result.mode = value;
    else if (key === "--output") result.output = value;
    else if (key === "--timeout-ms") result.timeoutMs = Number(value);
    else if (key === "--cut-ms") result.cutMs = Number(value);
    else if (key === "--input") result.input = Number(value);
    else if (key === "--multiplier") result.multiplier = Number(value);
    else if (key === "--offset") result.offset = Number(value);
    else usage(`Unknown option: ${key}`);
  }
  if (!["auto", "fixed"].includes(result.mode)) usage("--mode must be auto or fixed");
  if (!result.output) usage("--output is required");
  if (!Number.isSafeInteger(result.timeoutMs) || result.timeoutMs < 5000 || result.timeoutMs > 300000) usage("--timeout-ms must be an integer from 5000 to 300000");
  if (result.cutMs !== null && (!Number.isSafeInteger(result.cutMs) || result.cutMs < 500 || result.cutMs > result.timeoutMs)) usage("--cut-ms must be an integer from 500 through --timeout-ms");
  for (const key of ["input", "multiplier", "offset"]) if (!Number.isFinite(result[key])) usage(`--${key} must be finite`);
  result.output = path.resolve(process.cwd(), result.output);
  if (!result.output.split(path.sep).includes("scratch")) usage("--output must be inside a scratch directory");
  return result;
}

function authentication() {
  const token = process.env.KINOPIO_EDGE_TOKEN;
  const user = process.env.KINOPIO_EDGE_USER;
  const pass = process.env.KINOPIO_EDGE_PASSWORD;
  if (token && (user || pass)) throw Error("Use KINOPIO_EDGE_TOKEN or KINOPIO_EDGE_USER/KINOPIO_EDGE_PASSWORD");
  if (!!user !== !!pass) throw Error("KINOPIO_EDGE_USER and KINOPIO_EDGE_PASSWORD must both be set");
  return token ? { token } : user ? { user, pass } : {};
}

function pythonCommand() {
  if (!process.env.KINOPIO_PYTHON_COMMAND) return [path.join(workspace, "KinopioHub.py/.venv/bin/python"), path.join(here, "edge-web-python.py")];
  let command;
  try { command = JSON.parse(process.env.KINOPIO_PYTHON_COMMAND); } catch { throw Error("KINOPIO_PYTHON_COMMAND must be a JSON array"); }
  if (!Array.isArray(command) || !command.length || command.some(value => typeof value !== "string" || !value || value.includes("\0"))) throw Error("KINOPIO_PYTHON_COMMAND must be a nonempty JSON string array");
  return command;
}

async function until(check, label, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) { if (await check()) return; await delay(75); }
  throw Error(`${label} (${timeoutMs} ms)`);
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
}

async function closeServer(server) {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
}

function sanitizedResources(resources) {
  if (!resources || typeof resources !== "object" || Array.isArray(resources)) return null;
  return Object.fromEntries(Object.entries(resources).filter(([key, value]) => !/(?:ip|address|ssid|bssid|mac|host)/i.test(key) && (typeof value === "number" && Number.isFinite(value) || typeof value === "boolean")));
}

function advertisedHost() {
  const value = process.env.KINOPIO_ADVERTISE_HOST;
  if (value && /[:/\s]/.test(value)) throw Error("KINOPIO_ADVERTISE_HOST must be a plain hostname or IPv4 address");
  return value;
}

function pythonEndpoint(localServer) {
  if (process.env.KINOPIO_PYTHON_SERVER) {
    const parsed = new URL(process.env.KINOPIO_PYTHON_SERVER);
    if (!["nats:", "tls:", "ws:", "wss:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw Error("KINOPIO_PYTHON_SERVER must be a credential-free NATS endpoint");
    return parsed.toString();
  }
  if (!process.env.KINOPIO_PYTHON_COMMAND) return localServer;
  const host = advertisedHost();
  if (!host) throw Error("Remote KINOPIO_PYTHON_COMMAND requires KINOPIO_ADVERTISE_HOST or KINOPIO_PYTHON_SERVER");
  const parsed = new URL(localServer); parsed.hostname = host; return parsed.toString();
}

function processor(command, configuration, timeoutMs) {
  const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
  const lines = createInterface({ input: child.stdout });
  let stderrBytes = 0;
  const buffered = new Map();
  const redact = value => {
    let text = String(value).slice(0, 500);
    for (const secret of [configuration.hubOptions.token, configuration.hubOptions.password]) if (secret) text = text.split(secret).join("[redacted]");
    return text;
  };
  let fatalError, stdinError;
  child.stderr.on("data", chunk => { stderrBytes += chunk.length; });
  child.stdin.on("error", error => { stdinError = error; if (error.code !== "EPIPE") fatalError ??= Error(redact(error.message)); });
  const waiters = new Map();
  const exit = new Promise(resolve => child.once("exit", (code, signal) => resolve({ code, signal })));
  lines.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.event === "error") {
      fatalError = Error(redact(message.error ?? "Python processor failed"));
      for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(fatalError); } waiters.clear();
      return;
    }
    const waiter = waiters.get(message.event);
    if (waiter) { clearTimeout(waiter.timer); waiters.delete(message.event); message.error ? waiter.reject(Error(message.error)) : waiter.resolve(message); }
    else buffered.set(message.event, message);
  });
  let exitResult;
  exit.then(result => {
    exitResult = result;
    for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(fatalError ?? Error(`Python processor exited (${result.code ?? result.signal})`)); } waiters.clear();
  });
  const wait = event => new Promise((resolve, reject) => {
    if (buffered.has(event)) { const message = buffered.get(event); buffered.delete(event); message.error ? reject(Error(message.error)) : resolve(message); return; }
    if (fatalError) { reject(fatalError); return; }
    if (exitResult) { reject(Error(`Python processor exited (${exitResult.code ?? exitResult.signal})`)); return; }
    const timer = setTimeout(() => { waiters.delete(event); reject(Error(`Python ${event} timeout`)); }, timeoutMs);
    waiters.set(event, { resolve, reject, timer });
  });
  child.once("error", error => { for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(error); } waiters.clear(); });
  child.stdin.write(`${JSON.stringify(configuration)}\n`);
  return { wait, async close() {
    if (child.exitCode === null && child.signalCode === null) { try { child.stdin.end(); } catch (error) { stdinError = error; } }
    let result = await Promise.race([exit, delay(3000).then(() => null)]), forced = false;
    if (!result && child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); result = await Promise.race([exit, delay(1000).then(() => null)]); }
    if (!result && child.exitCode === null && child.signalCode === null) { forced = true; child.kill("SIGKILL"); result = await Promise.race([exit, delay(2000).then(() => null)]); }
    lines.close();
    for (const waiter of waiters.values()) { clearTimeout(waiter.timer); waiter.reject(Error("Python processor closed")); } waiters.clear();
    if (!result) throw Error("Python processor did not exit after SIGKILL");
    if (forced || result.code !== 0 || result.signal) throw Error(`Python processor cleanup exit was abnormal (${result.code ?? result.signal})`);
    if (stdinError && stdinError.code !== "EPIPE") throw Error(`Python processor stdin failed: ${redact(stdinError.message)}`);
    return { stderrBytes, exitCode: result.code };
  } };
}

function expectedResult(parameter, sample) {
  return { runId: parameter.runId, token: parameter.token, round: Math.max(parameter.round, sample.sequence), sequence: sample.sequence, formula: "sample*multiplier+offset", input: parameter.input, sample: sample.value, value: sample.value * parameter.multiplier + parameter.offset };
}

async function waitBrowserResult(page, expectedValue, timeoutMs) {
  await until(async () => isDeepStrictEqual(await page.evaluate(() => globalThis.pilotVariables.result.value), expectedValue), "Browser did not observe the exact result", timeoutMs);
}

function monitorCutState(page, expectedValue, uplinkConnected) {
  let active = true, failure;
  const connections = new Set(); let polls = 0;
  const task = (async () => {
    while (active) {
      try {
        const observation = await page.evaluate(() => ({ result: globalThis.pilotVariables.result.value, connection: globalThis.pilotHub.status().connection }));
        polls++; connections.add(observation.connection);
        if (!isDeepStrictEqual(observation.result, expectedValue)) { failure = Error("Browser result changed while the application uplink was cut"); break; }
        if (observation.connection !== "connected") { failure = Error("Browser connection was not connected while the application uplink was cut"); break; }
        if (await uplinkConnected()) { failure = Error("Local leaf reconnected while the application uplink was cut"); break; }
      } catch (error) { failure = error; break; }
      await delay(100);
    }
  })();
  let stopTask;
  return () => stopTask ??= (async () => { active = false; await task; if (failure) throw failure; return { polls, connections: [...connections].sort() }; })();
}

const GATE_COUNTERS = ["acceptedConnections", "upstreamConnections", "rejectedConnections", "rejectedTargets", "malformedRequests", "handshakeTimeouts", "connectionErrors", "cuts", "restores", "errors", "limitClosures", "upstreamChunks", "upstreamBytes", "downstreamChunks", "downstreamBytes", "activeConnections"];
function assertGateStats(stats) {
  for (const field of GATE_COUNTERS) assert.ok(Number.isSafeInteger(stats[field]) && stats[field] >= 0, `Invalid gate counter: ${field}`);
  assert.equal(typeof stats.enabled, "boolean"); assert.equal(typeof stats.closed, "boolean");
  return stats;
}

function safeGateStats(stats) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return null;
  return Object.fromEntries(Object.entries(stats).filter(([, value]) => typeof value === "boolean" || Number.isSafeInteger(value) && value >= 0));
}

function safeError(error, auth, endpoint) {
  let message = String(error?.message ?? error);
  for (const secret of [auth.token, auth.pass]) if (secret) message = message.split(secret).join("[redacted]");
  if (endpoint) message = message.split(endpoint).join("[endpoint]");
  message = message.replace(/\b(?:nats|tls|wss?):\/\/[^\s)]+/gi, "[endpoint]");
  return { name: String(error?.name ?? "Error").slice(0, 80), ...(typeof error?.code === "string" ? { code: error.code.slice(0, 80) } : {}), message: message.slice(0, 500) };
}

async function boundedDiagnostic(read, timeoutMs = 1000) {
  return Promise.race([
    Promise.resolve().then(read).then(value => ({ value, timedOut: false, failed: false }), () => ({ value: null, timedOut: false, failed: true })),
    delay(timeoutMs).then(() => ({ value: null, timedOut: true, failed: false })),
  ]);
}

const args = argumentsOf(process.argv.slice(2));
const started = performance.now();
let lastElapsed = -1;
await fs.mkdir(path.dirname(args.output), { recursive: true });
const artifact = await fs.open(args.output, "wx", 0o600);
const observe = async (event, details = {}) => {
  const elapsedMs = Math.max(lastElapsed, Math.round((performance.now() - started) * 1000) / 1000); lastElapsed = elapsedMs;
  await artifact.write(`${JSON.stringify({ observedAt: new Date().toISOString(), elapsedMs, event, ...details })}\n`);
};
let phase = { name: "initialization", started: performance.now(), perOperationTimeoutMs: args.timeoutMs, details: {} };
const beginPhase = async (name, perOperationTimeoutMs = args.timeoutMs, details = {}) => {
  phase = { name, started: performance.now(), perOperationTimeoutMs, details };
  await observe("phase-start", { phase: name, perOperationTimeoutMs, ...details });
};
const phaseEvidence = () => ({ name: phase.name, perOperationTimeoutMs: phase.perOperationTimeoutMs, ...phase.details, elapsedMs: Math.round(performance.now() - phase.started) });
const completePhase = async () => observe("phase-complete", { phase: phase.name, perOperationTimeoutMs: phase.perOperationTimeoutMs, ...phase.details, durationMs: Math.round(performance.now() - phase.started) });

const runId = randomUUID().replaceAll("-", "").slice(0, 12);
const stateToken = randomUUID();
const namespace = `ewp-${runId}`;
const group = `ewp-${runId}`;
let auth = {};
const parameterValue = { runId, token: stateToken, round: 1, input: args.input, multiplier: args.multiplier, offset: args.offset };
const sampleValue = { runId, token: stateToken, sequence: 1, source: process.env.KINOPIO_SERIAL ? "esp32" : "javascript", value: args.input + 4 };
const expected = expectedResult(parameterValue, sampleValue);

let upstream, link, pinned, relay, hub, web, browser, context, page, python, serial, stopCutMonitor, endpoint, leafUpstreamStatus;
let passed = false;
try {
  await beginPhase("relay-setup");
  auth = authentication();
  if (args.localSmoke) {
    upstream = await startManagedBroker({ host: "127.0.0.1", leafPort: 0 });
    endpoint = upstream.websocketUrl;
  } else {
    endpoint = process.env.KINOPIO_EDGE_WSS;
    if (!endpoint) throw Error("Set KINOPIO_EDGE_WSS to the public relay WebSocket endpoint");
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "wss:" || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) throw Error("KINOPIO_EDGE_WSS must be a credential-free wss:// endpoint without query or path");
  }
  const browserEndpoint = endpoint;
  let leafUpstream = endpoint;
  if (args.cutMs !== null) {
    link = await startLink({ upstream: endpoint });
    pinned = await createPinnedBroker({ upstream: endpoint, proxy: link.url });
  }
  await observe("run-start", { mode: args.mode, localSmoke: args.localSmoke, producer: process.env.KINOPIO_SERIAL ? "esp32" : "javascript", namespace, brokerVersion: BROKER_VERSION, endpointTransport: new URL(endpoint).protocol, cutMs: args.cutMs, pinning: pinned ? "http_connect_proxy" : null });

  let localServer;
  if (args.mode === "fixed") {
    relay = await startManagedBroker({ binary: pinned?.binary, host: "0.0.0.0", upstreams: [leafUpstream], ...auth });
    localServer = relay.url;
    hub = new KinopioHub(namespace, { servers: [localServer], mesh: false, discovery: false, ...auth, healthInterval: 250, peerTimeout: 150 });
  } else {
    hub = new KinopioHub(namespace, { mesh: { group, upstreams: [leafUpstream], ...(pinned ? { binary: pinned.binary } : {}) }, discovery: false, ...auth, healthInterval: 250, peerTimeout: 150 });
  }
  leafUpstreamStatus = async () => args.mode === "fixed" ? await relay.upstreamConnected() : hub.status().mesh.upstreamConnected;
  await hub.connected({ timeout: args.timeoutMs });
  if (args.mode === "auto") localServer = hub.status().server;
  await until(async () => await leafUpstreamStatus() === true, "Local leaf did not connect to upstream", args.timeoutMs);
  await observe("local-leaf-ready", { mode: args.mode, meshRole: hub.status().mesh.role, upstreamConnected: true });
  await completePhase(); await beginPhase("browser-connect");

  const [{ build }, { chromium }] = await Promise.all([
    import(pathToFileURL(path.join(sdkRoot, "node_modules/esbuild/lib/main.js")).href),
    import(pathToFileURL(path.join(sdkRoot, "node_modules/playwright/index.mjs")).href),
  ]);
  const bundle = await build({ stdin: { contents: 'import Hub from "./src/browser.mjs"; globalThis.KinopioHub = Hub;', resolveDir: sdkRoot }, bundle: true, platform: "browser", format: "esm", write: false });
  web = http.createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/sdk.js") { response.setHeader("Content-Type", "text/javascript"); response.end(bundle.outputFiles[0].text); }
    else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><meta charset="utf-8"><title>Kinopio edge/Web pilot</title><script type="module" src="/sdk.js"></script>'); }
  });
  await listen(web);
  browser = await chromium.launch({ headless: true }); context = await browser.newContext(); page = await context.newPage();
  await page.goto(`http://127.0.0.1:${web.address().port}`); await page.waitForFunction(() => !!globalThis.KinopioHub);
  await page.evaluate(async ({ endpoint: server, namespace: ns, auth: credentials, timeoutMs }) => {
    globalThis.pilotHub = new globalThis.KinopioHub(ns, { servers: [server], mesh: false, discovery: false, ...credentials, healthInterval: 250, peerTimeout: 150 });
    await globalThis.pilotHub.connected({ timeout: timeoutMs });
    globalThis.pilotVariables = { parameter: globalThis.pilotHub.var("parameter"), result: globalThis.pilotHub.var("result") };
  }, { endpoint: browserEndpoint, namespace, auth, timeoutMs: args.timeoutMs });
  await observe("browser-connected", { runtime: "chromium", version: browser.version(), transport: new URL(browserEndpoint).protocol });
  await completePhase(); await beginPhase("participants-connect");

  if (process.env.KINOPIO_SERIAL) {
    serial = serialWorker(process.env.KINOPIO_SERIAL, process.env.KINOPIO_SERIAL_PYTHON);
    await delay(2000);
    const server = args.mode === "auto" ? "" : (() => {
      const advertised = advertisedHost();
      if (!advertised) throw Error("Fixed ESP32 mode requires KINOPIO_ADVERTISE_HOST");
      return `nats://${advertised}:${relay.port}`;
    })();
    await serial.call("configure", { namespace, server, group, upstreams: args.mode === "auto" ? [leafUpstream] : [], token: auth.token ?? "", user: auth.user ?? "", password: auth.pass ?? "", caCertificate: "" });
    await until(async () => (await serial.call("status")).connection === "connected", "ESP32 did not connect", args.timeoutMs);
    await observe("producer-ready", { producer: "esp32", resources: sanitizedResources((await serial.call("status")).resources) });
  } else await observe("producer-ready", { producer: "javascript" });

  const pythonAuth = auth.pass ? { user: auth.user, password: auth.pass } : auth;
  python = processor(pythonCommand(), { runId, token: stateToken, rounds: args.cutMs === null ? 1 : 2, timeoutSeconds: args.timeoutMs / 1000, names: NAMES, hubOptions: { namespace, servers: [pythonEndpoint(localServer)], mesh: false, discovery: false, ...pythonAuth, health_interval: 0.25, peer_timeout: 0.15 } }, args.timeoutMs);
  const pythonReady = await python.wait("ready"); await observe("python-connected", { execution: process.env.KINOPIO_PYTHON_COMMAND ? "configured-command" : "workspace-venv", runtime: pythonReady.runtime });
  await completePhase(); await beginPhase("initial-round");

  await page.evaluate(async value => { await globalThis.pilotVariables.parameter.set(value); await globalThis.pilotHub.flush(); }, parameterValue);
  await until(() => isDeepStrictEqual(hub.var(NAMES.parameter).value, parameterValue), "Node did not observe the browser parameter", args.timeoutMs);
  await observe("parameter-observed", { value: parameterValue });

  if (serial) {
    await until(async () => isDeepStrictEqual((await serial.call("get", { name: NAMES.parameter })).value, parameterValue), "ESP32 did not observe the browser parameter", args.timeoutMs);
    assert.equal(await serial.call("set", { name: NAMES.sample, value: sampleValue }), true);
    await serial.call("flush");
  } else {
    await hub.var(NAMES.sample).set(sampleValue); await hub.flush({ timeout: args.timeoutMs });
  }
  await observe("sample-published", { value: sampleValue });

  const processed = await python.wait("done:1"); assert.deepEqual(processed.result, expected);
  await waitBrowserResult(page, expected, args.timeoutMs);
  const browserResult = await page.evaluate(() => globalThis.pilotVariables.result.value);
  assert.deepEqual(browserResult, expected);
  await observe("browser-verified", { round: 1, exact: true, value: browserResult });
  await completePhase();

  if (link) {
    const uplinkConnected = async () => await leafUpstreamStatus() === true;
    await beginPhase("cut-transition");
    const cutStarted = performance.now();
    link.cut();
    await until(async () => link.stats().activeConnections === 0 && !await uplinkConnected(), "Application uplink did not enter a disconnected state", args.timeoutMs);
    await delay(150);
    const frozen = assertGateStats(link.stats());
    await observe("uplink-cut", { gate: frozen });
    await completePhase(); await beginPhase("cut-observation", args.timeoutMs, { minimumObservationMs: args.cutMs });
    stopCutMonitor = monitorCutState(page, expected, uplinkConnected);
    const observationStarted = performance.now();

    const secondSample = { ...sampleValue, sequence: 2, value: 13 };
    if (serial) {
      assert.equal(await serial.call("set", { name: NAMES.sample, value: secondSample }), true);
      await serial.call("flush");
    } else {
      await hub.var(NAMES.sample).set(secondSample); await hub.flush({ timeout: args.timeoutMs });
    }
    await observe("sample-published", { value: secondSample, uplinkCut: true });
    const secondExpected = expectedResult(parameterValue, secondSample);
    const secondProcessed = await python.wait("done:2"); assert.deepEqual(secondProcessed.result, secondExpected);
    await until(() => isDeepStrictEqual(hub.var(NAMES.result).value, secondExpected), "Local result did not update while uplink was cut", args.timeoutMs);
    await observe("local-result-verified", { round: 2, exact: true, value: secondExpected });
    const remainingCut = args.cutMs - (performance.now() - observationStarted);
    if (remainingCut > 0) await delay(remainingCut);
    const browserDuringCut = await stopCutMonitor(); stopCutMonitor = null;
    assert.ok(browserDuringCut.polls >= 2, "Browser result was not polled repeatedly during the cut");
    const endFrozen = assertGateStats(link.stats());
    for (const field of ["upstreamChunks", "upstreamBytes", "downstreamChunks", "downstreamBytes"]) {
      assert.ok(Number.isSafeInteger(frozen[field]) && Number.isSafeInteger(endFrozen[field]), `Invalid gate counter: ${field}`);
      assert.equal(endFrozen[field], frozen[field], `Gate ${field} changed after cut drain`);
    }
    assert.equal(endFrozen.activeConnections, 0); assert.equal(endFrozen.enabled, false);
    await observe("cut-state-verified", { durationMs: Math.round(performance.now() - cutStarted), observationDurationMs: Math.round(performance.now() - observationStarted), browser: browserDuringCut, gate: endFrozen });
    await completePhase(); await beginPhase("uplink-restore");

    link.restore();
    await until(async () => {
      const stats = assertGateStats(link.stats());
      return await uplinkConnected() && stats.activeConnections > 0 && stats.upstreamConnections > frozen.upstreamConnections && stats.upstreamBytes > frozen.upstreamBytes && stats.downstreamBytes > frozen.downstreamBytes;
    }, "Pinned application uplink did not carry bidirectional traffic after restore", args.timeoutMs);
    const restored = assertGateStats(link.stats());
    await observe("uplink-restored", { upstreamConnected: true, gate: restored });
    await waitBrowserResult(page, secondExpected, args.timeoutMs);
    assert.deepEqual(await page.evaluate(() => globalThis.pilotVariables.result.value), secondExpected);
    await observe("browser-verified", { round: 2, exact: true, value: secondExpected, gate: link.stats() });
    await completePhase();
  }
  passed = true;
} catch (error) {
  const leafDiagnostic = await boundedDiagnostic(() => leafUpstreamStatus ? leafUpstreamStatus() : null);
  const browserDiagnostic = await boundedDiagnostic(() => page ? page.evaluate(() => {
      const status = globalThis.pilotHub?.status(), result = globalThis.pilotVariables?.result?.value;
      const safeInteger = value => Number.isSafeInteger(value) ? value : null;
      return status ? { connection: ["starting", "connecting", "connected", "offline", "error", "closed"].includes(status.connection) ? status.connection : "unknown", health: ["ok", "warning", "error"].includes(status.health) ? status.health : "unknown", result: result && typeof result === "object" ? { round: safeInteger(result.round), sequence: safeInteger(result.sequence), value: typeof result.value === "number" && Number.isFinite(result.value) ? result.value : null } : null } : null;
    }) : null);
  const leafUpstream = [true, false, null].includes(leafDiagnostic.value) ? leafDiagnostic.value : null;
  await observe("run-failed", { error: safeError(error, auth, endpoint), phase: phaseEvidence(), gate: safeGateStats(link?.stats()), leafUpstream, browser: browserDiagnostic.value, diagnosticStatus: { leaf: { timedOut: leafDiagnostic.timedOut, failed: leafDiagnostic.failed }, browser: { timedOut: browserDiagnostic.timedOut, failed: browserDiagnostic.failed } } });
  process.exitCode = 1;
} finally {
  phase = { name: "cleanup", started: performance.now(), perOperationTimeoutMs: null, details: {} };
  await observe("phase-start", { phase: phase.name });
  let cleanupFailures = 0;
  if (stopCutMonitor) {
    try { await Promise.race([stopCutMonitor(), delay(2000).then(() => { throw Error("Cut monitor cleanup timed out"); })]); } catch { cleanupFailures++; }
    stopCutMonitor = null;
  }
  try { if (page) await page.evaluate(() => globalThis.pilotHub?.close()); } catch { cleanupFailures++; }
  if (serial) {
    try { const reply = await serial.call("disconnect"); await observe("esp-disconnected", { acknowledged: reply === true, reply }); if (reply !== true) cleanupFailures++; }
    catch (error) { cleanupFailures++; await observe("esp-disconnect-failed", { error: `${error.name}: ${error.message}` }); }
    serial.close();
  }
  if (python) {
    try { const receipt = await python.close(); await observe("python-exited", receipt); }
    catch (error) { cleanupFailures++; await observe("python-exit-failed", { error: `${error.name}: ${error.message}` }); }
  }
  for (const close of [() => context?.close(), () => browser?.close(), () => closeServer(web), () => hub?.close(), () => relay?.close(), () => pinned?.close(), () => link?.close(), () => upstream?.close()]) {
    try { await close(); } catch { cleanupFailures++; }
  }
  await observe("run-complete", { passed: passed && cleanupFailures === 0, cleanupFailures, cleanupDurationMs: Math.round(performance.now() - phase.started) });
  if (cleanupFailures) process.exitCode = 1;
  await artifact.close();
}

console.log(`${passed && !process.exitCode ? "PASS" : "FAIL"} edge/Web pilot artifact: ${args.output}`);
