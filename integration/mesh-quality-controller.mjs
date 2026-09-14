import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { executeArgv, runCommands } from "./mesh-quality-network.mjs";

const IDS = ["a", "b", "c"], PROTOCOLS = ["udp", "http", "tcp"];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseTcInspection(entry) {
  const argv = entry?.argv ?? [], command = argv.includes("qdisc") ? "qdisc" : argv.includes("filter") ? "filter" : null;
  if (!command) return { ok: true, command: null, rows: [] };
  try {
    const parsed = JSON.parse(entry.stdout);
    if (!Array.isArray(parsed)) throw Error("tc JSON root must be an array");
    const dev = argv[argv.indexOf("dev") + 1];
    return { ok: true, command, rows: parsed.map(row => ({ dev, kind: row.kind ?? null, handle: row.handle ?? null, parent: row.parent ?? null, packets: row.packets, drops: row.drops, backlog: row.backlog, qlen: row.qlen, raw: row })) };
  } catch (error) { return { ok: false, command, rows: [], error: String(error?.message ?? error) }; }
}

export function summarizeTcEvidence(inspections, plan, { drain = false } = {}) {
  const tc = inspections.filter(entry => entry.parser?.command), parserFailures = tc.filter(entry => !entry.parser.ok).map(entry => ({ argv: entry.argv, error: entry.parser.error }));
  const leaves = tc.flatMap(entry => entry.parser.ok && entry.parser.command === "qdisc" ? entry.parser.rows : []).filter(row => row.kind === "netem" && /^1:[123]$/.test(row.parent ?? ""));
  const keyed = new Map();
  for (const row of leaves) {
    const receiver = IDS.find(id => plan.config.names.switchVeth[id] === row.dev), source = IDS[Number(row.parent.slice(2)) - 1];
    if (receiver && source) keyed.set(`${receiver}:${source}`, row);
  }
  const required = IDS.flatMap(receiver => IDS.map(source => `${receiver}:${source}`)), cross = IDS.flatMap(receiver => IDS.filter(source => source !== receiver).map(source => `${receiver}:${source}`));
  const missingLeaves = required.filter(key => !keyed.has(key)), invalidStats = [...keyed].filter(([, row]) => ![row.packets, row.drops, row.backlog, row.qlen].every(Number.isFinite)).map(([key]) => key);
  const filterDevices = new Set(tc.filter(entry => entry.parser.ok && entry.parser.command === "filter" && entry.parser.rows.length > 0).flatMap(entry => entry.parser.rows.map(row => row.dev))), expectedDevices = new Set(IDS.map(id => plan.config.names.switchVeth[id]));
  const leafRows = [...keyed].map(([key, row]) => ({ key, packets: row.packets, drops: row.drops, backlog: row.backlog, qlen: row.qlen, dev: row.dev, handle: row.handle, parent: row.parent }));
  const drops = leafRows.reduce((sum, row) => sum + row.drops, 0), activeOccupancy = { backlogBytes: leafRows.reduce((sum, row) => sum + row.backlog, 0), qlen: leafRows.reduce((sum, row) => sum + row.qlen, 0), leaves: leafRows };
  const base = { parserOk: parserFailures.length === 0, parserFailures, completeStats: !missingLeaves.length && !invalidStats.length, filtersPresent: [...expectedDevices].every(dev => filterDevices.has(dev)), missingLeaves, invalidStats, leafRows, classified: cross.every(key => (keyed.get(key)?.packets ?? 0) > 0), drops, activeOccupancy };
  return drain ? { ...base, drained: base.parserOk && !missingLeaves.length && !invalidStats.length && leafRows.every(row => row.backlog === 0 && row.qlen === 0) } : base;
}

export function evaluateSnapshotQuorum(snapshotSet, workers, runId, reversalBoundaryMonoMs = null, payloadBytes = 64) {
  const snapshots = snapshotSet?.snapshots ?? [], issues = [];
  const expectedKeys = new Set(Array.from({ length: 64 }, (_, key) => key));
  if (snapshotSet?.label !== "post-reversal") issues.push("snapshot label is not post-reversal");
  if (Number.isFinite(reversalBoundaryMonoMs) && (!Number.isFinite(snapshotSet?.capturedMonoMs) || snapshotSet.capturedMonoMs < reversalBoundaryMonoMs)) issues.push("snapshot set predates the reversal boundary");
  if (snapshots.length !== 3 || new Set(snapshots.map(item => item.nodeId)).size !== 3) issues.push("three distinct receiver snapshots are required");
  const accepted = new Map();
  for (const [workerId, row] of workers ?? []) for (const event of row.events ?? []) if (event.type === "write" && event.accepted) accepted.set(`${workerId}:${event.key}`, event);
  const signatures = [];
  for (const item of snapshots) {
    const rows = item.snapshot?.values;
    if (Number.isFinite(reversalBoundaryMonoMs) && (!Number.isFinite(item.controllerReceiptMonoMs) || item.controllerReceiptMonoMs < reversalBoundaryMonoMs)) issues.push(`${item.nodeId} snapshot receipt predates the reversal boundary`);
    if (!Array.isArray(rows) || rows.length !== 64 || new Set(rows.map(row => row.key)).size !== 64 || rows.some(row => !expectedKeys.has(row.key))) { issues.push(`${item.nodeId} does not contain exactly keys 0..63`); continue; }
    signatures.push(JSON.stringify(rows.map(row => ({ key: row.key, value: row.value, version: row.meta?.version }))));
    for (const row of rows) {
      const owner = IDS[row.key % IDS.length], last = accepted.get(`${owner}:${row.key}`), value = row.value;
      const exactFields = value && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(["data", "key", "run", "seq", "source"]);
      if (!last || row.meta?.exists !== true || !exactFields || value.run !== runId || value.source !== owner || value.key !== row.key || value.seq !== last.seq || value.data !== "x".repeat(payloadBytes) || JSON.stringify(row.meta?.version) !== JSON.stringify(last.version)) issues.push(`${item.nodeId} key ${row.key} does not match owner ${owner}'s last accepted value/version/full payload`);
    }
  }
  if (signatures.length === 3 && new Set(signatures).size !== 1) issues.push("post-reversal replicas disagree");
  return { ok: issues.length === 0, label: snapshotSet?.label ?? null, capturedMonoMs: snapshotSet?.capturedMonoMs ?? null, issues };
}

export class NetnsQualityController {
  constructor(options = {}) { this.spawn = options.spawnImpl ?? spawn; this.executeArgv = options.executeArgv ?? executeArgv; this.commandOptions = options.commandOptions; this.children = []; this.workers = new Map(); this.servers = new Map(); this.receipts = []; this.probeResults = []; this.inspections = []; this.instanceNodes = new Map(); this.phase = null; this.phaseEvaluations = []; this.sequence = 0; this.writeChain = Promise.resolve(); }
  record(event) {
    const received = { ...event, controllerReceiptMonoMs: event.controllerReceiptMonoMs ?? performance.now() };
    this.writeChain = this.writeChain.then(async () => { try { await this.emit?.(received); } catch (error) { this.recordingError ??= String(error?.message ?? error); } }); return received;
  }
  attach(kind, id, argv) {
    const child = this.spawn(argv[0], argv.slice(1), { stdio: [kind === "worker" ? "pipe" : "ignore", "pipe", "pipe"] });
    const row = { kind, id, child, argv, events: [], pending: new Map(), exited: false, ready: false, stderr: "" }; this.children.push(row);
    child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { row.stderr = (row.stderr + chunk).slice(-65536); });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity }); row.lines = lines;
    lines.on("line", line => {
      let event; try { event = JSON.parse(line); } catch { event = { type: "malformedJsonl", fatal: true, line: line.slice(0, 500) }; }
      event = this.record({ ...event, receiver: event.receiver ?? id, controllerPhase: this.phase, processKind: kind, nodeId: id }); row.events.push(event);
      if (event.type === "ready" || event.type === "probeReady") { row.ready = true; if (event.type === "ready" && event.runtime?.sdk?.instanceId) this.instanceNodes.set(event.runtime.sdk.instanceId, id); }
      if (event.type === "probeReceipt") this.receipts.push(event);
      if (event.type === "qualityEvaluation") { this.instanceNodes.set(event.instanceId, id); this.phaseEvaluations.push(this.normalizeEvaluation(event, id)); }
      if (event.type === "snapshot") row.snapshot = event;
      if (event.type === "status") row.status = event;
      if (event.type === "command" && row.pending.has(event.id)) { const pending = row.pending.get(event.id); row.pending.delete(event.id); clearTimeout(pending.timer); event.ok ? pending.resolve({ ...event.result, commandId: event.id }) : pending.reject(Error(event.error?.message ?? "worker command failed")); }
    });
    row.ended = new Promise(resolve => child.once("close", (code, signal) => { row.exited = true; row.code = code; row.signal = signal; for (const pending of row.pending.values()) { clearTimeout(pending.timer); pending.reject(Error(`${kind} ${id} exited`)); } row.pending.clear(); resolve(); }));
    return row;
  }
  attachRaw(kind, id, argv) {
    const child = this.spawn(argv[0], argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] }), row = { kind, id, child, argv, events: [], pending: new Map(), exited: false, ready: true, stderr: "" };
    this.children.push(row); child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => { row.stderr = (row.stderr + chunk).slice(-65536); });
    row.lines = { close() {} }; row.ended = new Promise(resolve => child.once("close", (code, signal) => { row.exited = true; row.code = code; row.signal = signal; resolve(); })); return row;
  }
  async until(predicate, timeoutMs, label) { const end = performance.now() + timeoutMs; while (performance.now() < end) { if (predicate()) return; const dead = this.children.find(row => row.exited); if (dead) throw Error(`${dead.kind} ${dead.id} exited during ${label}: ${dead.stderr}`); await wait(100); } throw Error(`${label} timed out`); }
  send(row, op, payload = {}, timeoutMs = 15000) { const id = ++this.sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { row.pending.delete(id); reject(Error(`${row.id} ${op} timed out`)); }, timeoutMs); row.pending.set(id, { resolve, reject, timer }); row.child.stdin.write(`${JSON.stringify({ id, op, ...payload })}\n`); }); }
  async start({ config, plan, output, emit }) {
    this.config = config; this.plan = plan; this.output = output; this.emit = emit; this.addresses = Object.fromEntries(plan.config.nodes.map(node => [node.id, node.address]));
    if (config.runtime.tcpdump) this.capture = this.attachRaw("capture", "switch", ["ip", "netns", "exec", plan.config.names.switch, config.runtime.tcpdump, "-U", "-n", "-i", plan.config.names.bridge, "-w", path.join(output, "traffic.pcap")]);
    for (const node of plan.config.nodes) {
      const argv = ["ip", "netns", "exec", plan.config.names.namespaces[node.id], config.runtime.node, config.runtime.probes, "server", "--id", node.id, "--address", node.address];
      this.servers.set(node.id, this.attach("probe", node.id, argv));
    }
    await this.until(() => [...this.servers.values()].every(row => row.ready), 15000, "probe server startup");
    for (const node of plan.config.nodes) {
      const workerConfig = { sdkPath: path.join(config.runtime.sdkDir, "src", "node.mjs"), studyWorkerPath: config.runtime.studyWorker, diagnosticMaxBytes: config.diagnosticMaxBytes ?? 32 * 1024 * 1024, runId: config.runId, sourceId: node.id, sourceIds: IDS, policy: config.policy ?? "Q", namespace: config.runId, group: config.runId, meshBinary: config.runtime.natsBinary, servers: [], keys: 64, payloadBytes: 64, rateHz: 5 };
      const filename = path.join(output, `worker-${node.id}.json`); await fs.writeFile(filename, JSON.stringify(workerConfig, null, 2), { flag: "wx" });
      const argv = ["ip", "netns", "exec", plan.config.names.namespaces[node.id], config.runtime.node, config.runtime.qualityWorker, "--config", filename];
      this.workers.set(node.id, this.attach("worker", node.id, argv));
    }
    await this.until(() => [...this.workers.values()].every(row => row.ready), 240000, "SDK worker startup");
  }
  normalizeEvaluation(event, evaluatingNode = this.instanceNodes.get(event.instanceId)) {
    const memberHosts = new Map((event.members ?? []).map(member => [member.id, this.instanceNodes.get(member.id) ?? Object.entries(this.addresses).find(([, address]) => address === member.address)?.[0]]));
    if (evaluatingNode) memberHosts.set(event.instanceId, evaluatingNode);
    const scores = Object.fromEntries(Object.entries(event.result?.scores ?? {}).map(([instance, score]) => [memberHosts.get(instance) ?? instance, score]));
    let missing = 0, worstLoss = 0;
    for (const voter of event.members ?? []) for (const candidate of event.members ?? []) if (voter.id !== candidate.id) { const sample = voter.observations?.[candidate.id]; if (!sample) missing++; else worstLoss = Math.max(worstLoss, sample.loss ?? 0); }
    return { phase: this.phase, instanceId: event.instanceId, scores, coverage: event.members?.length === 3 && missing === 0 ? "3/3" : "incomplete", loss: worstLoss, timeouts: missing, raw: event };
  }
  async runProbe(protocol, source, target) {
    const ns = this.plan.config.names.namespaces[source], argv = ["ip", "netns", "exec", ns, this.config.runtime.node, this.config.runtime.probes, "client", "--protocol", protocol, "--source", source, "--target", target, "--sourceAddress", this.addresses[source], "--targetAddress", this.addresses[target], "--timeoutMs", "1000"];
    const result = await runCommands([argv], this.commandOptions), lines = result[0].stdout.trim().split("\n").filter(Boolean), event = JSON.parse(lines.at(-1));
    if (event.type !== "probeResult") throw Error(`${protocol} ${source}->${target} did not return a probe result`); event.phase = this.phase; event.receiver = target; this.probeResults.push(event); this.record(event); return event;
  }
  async inspectNetwork(phase, point) {
    const entries = [];
    for (const argv of this.plan.inspect) {
      const requestMonoMs = performance.now(); let result, commandError = null;
      try { result = await this.executeArgv(argv, this.commandOptions); }
      catch (error) { commandError = String(error?.message ?? error); result = { argv, stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? null }; }
      const completeMonoMs = performance.now(), parser = parseTcInspection(result);
      const entry = { type: "networkInspection", schema: "kinopio-mesh-quality-tc-raw/v1", phase, point, requestMonoMs, completeMonoMs, argv: [...argv], stdout: result.stdout, stderr: result.stderr, code: result.code, commandError, parser };
      this.inspections.push(entry); this.record(entry); entries.push(entry);
      if (commandError) throw Object.assign(Error(commandError), { inspection: entry });
      if (!parser.ok) throw Object.assign(Error(`tc inspection parse failed: ${parser.error}`), { inspection: entry });
    }
    return entries;
  }
  async inspectNamespaceSafety() {
    const rows = await Promise.all(IDS.map(async id => {
      const ns = this.plan.config.names.namespaces[id], [addresses, routes] = await runCommands([["ip", "netns", "exec", ns, "ip", "-j", "addr", "show"], ["ip", "netns", "exec", ns, "ip", "-j", "route", "show"]], this.commandOptions);
      return { id, addresses: JSON.parse(addresses.stdout), routes: JSON.parse(routes.stdout) };
    }));
    this.namespaceSafety = rows;
  }
  async collectApparatusPhase(phase) {
    const receiptStart = this.receipts.length;
    if (phase === "initial") {
      this.phase = "setup"; await Promise.all([...this.workers.values()].map(row => this.send(row, "start")));
      await wait(1500);
      const seedEnd = performance.now() + 30000; let seeded = false;
      while (performance.now() < seedEnd && !seeded) {
        for (const row of this.workers.values()) row.snapshot = null;
        await Promise.all([...this.workers.values()].map(row => this.send(row, "snapshot")));
        seeded = [...this.workers.values()].every(row => row.snapshot?.values?.every(value => value.value?.run === this.config.runId && value.meta?.version));
        if (!seeded) await wait(500);
      }
      if (!seeded) throw Error("64-key seed and version coverage timed out");
    }
    this.phase = phase; this.phaseEvaluations = [];
    const before = await this.inspectNetwork(phase, "before");
    const probes = [];
    for (const protocol of PROTOCOLS) for (const source of IDS) for (const target of IDS) if (source !== target) probes.push(await this.runProbe(protocol, source, target));
    await this.until(() => this.hasTenQualifyingPerView(phase), 60000, `${phase} per-view qualifying evaluation collection`);
    if (phase === "initial") {
      await Promise.all([...this.workers.values()].map(row => this.send(row, "stop")));
      const quietEnd = performance.now() + 30000; let converged = false;
      while (performance.now() < quietEnd && !converged) {
        for (const row of this.workers.values()) row.snapshot = null;
        await Promise.all([...this.workers.values()].map(row => this.send(row, "snapshot")));
        const snapshots = [...this.workers.values()].map(row => row.snapshot), signatures = snapshots.map(snapshot => JSON.stringify(snapshot?.values?.map(value => ({ value: value.value, version: value.meta?.version }))));
        converged = snapshots.every(snapshot => snapshot?.values?.length === 64 && snapshot.values.every(value => value.value?.run === this.config.runId && value.meta?.version)) && new Set(signatures).size === 1;
        if (!converged) await wait(500);
      }
      if (!converged) throw Error("quiescent 64-key value/version convergence timed out");
      await this.inspectNamespaceSafety();
    }
    if (phase === "reversed") this.postReversalSnapshots = await this.captureSnapshotSet("post-reversal");
    const after = await this.inspectNetwork(phase, "after"), receipts = this.receipts.slice(receiptStart);
    return { phase, evaluations: [...this.phaseEvaluations], probes, receipts, packetPaths: { probes: probes.length, receipts: receipts.length }, before, after };
  }
  async captureSnapshotSet(label) {
    for (const row of this.workers.values()) row.snapshot = null;
    const replies = await Promise.all([...this.workers].map(async ([nodeId, row]) => ({ nodeId, row, reply: await this.send(row, "snapshot") })));
    const snapshots = replies.map(({ nodeId, row, reply }) => ({ nodeId, commandId: reply.commandId, controllerReceiptMonoMs: row.snapshot?.controllerReceiptMonoMs ?? null, snapshot: row.snapshot }));
    for (const item of snapshots) if (!item.snapshot || item.snapshot.id !== item.commandId) throw Error(`${label} snapshot acknowledgement mismatch for ${item.nodeId}`);
    const set = { label, capturedMonoMs: performance.now(), snapshots }; this.record({ type: "snapshotSet", label, capturedMonoMs: set.capturedMonoMs, receivers: snapshots.map(item => ({ nodeId: item.nodeId, commandId: item.commandId, controllerReceiptMonoMs: item.controllerReceiptMonoMs })) }); return set;
  }
  noteReversalBoundary(monoMs) { if (!Number.isFinite(monoMs)) throw Error("reversal boundary must be a finite monotonic timestamp"); this.reversalBoundaryMonoMs = monoMs; this.record({ type: "reversalBoundary", monoMs }); }
  hasTenQualifyingPerView(phase) {
    const expected = phase === "initial" ? "a" : "b", states = new Map();
    for (const row of this.phaseEvaluations) {
      const target = row.scores[expected], others = Object.entries(row.scores).filter(([id]) => id !== expected).map(([, score]) => score), qualifies = Number.isFinite(target) && others.length === 2 && others.every(score => score - target >= .085) && row.coverage === "3/3" && row.loss < .01 && row.timeouts === 0;
      const state = states.get(row.instanceId) ?? 0; states.set(row.instanceId, qualifies ? state + 1 : 0);
    }
    return states.size === 3 && [...states.values()].every(value => value >= 10);
  }
  packetPathSummary() {
    const results = this.probeResults;
    const keys = new Set(results.map(row => `${row.protocol}:${row.source}:${row.target}`));
    const receipts = new Set(this.receipts.map(row => `${row.protocol}:${row.source}:${row.receiver}:${row.token}`));
    const all = PROTOCOLS.every(protocol => IDS.every(source => IDS.every(target => source === target || keys.has(`${protocol}:${source}:${target}`))));
    const receiptMatch = results.every(row => receipts.has(`${row.protocol}:${row.source}:${row.target}:${row.token}`));
    const udpRows = results.filter(row => row.protocol === "udp"), udpReplicas = udpRows.every(row => IDS.every(receiver => receipts.has(`udp:${row.source}:${receiver}:${row.token}`)));
    return { allSixDirections: all && receiptMatch, udp: all && udpRows.length === 12 && udpReplicas, http: all && results.filter(row => row.protocol === "http").length === 12, tcp: all && results.filter(row => row.protocol === "tcp").length === 12, multicastReplicas: udpReplicas, rawCapture: this.capture ? path.join(this.output, "traffic.pcap") : null, rttSummary: this.rttSummary(results), unaffectedPairsClean: this.validateRttMatrix(results), timingInterpretation: "same-process request/response RTT; it is not a one-way delay measurement" };
  }
  rttSummary(results) {
    const groups = new Map(); for (const row of results) { const key = `${row.phase}:${row.protocol}:${row.source}->${row.target}`, values = groups.get(key) ?? []; values.push(row.rttMs); groups.set(key, values); }
    return Object.fromEntries([...groups].map(([key, values]) => { const sorted = [...values].sort((a, b) => a - b); return [key, { count: sorted.length, minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)], maxMs: sorted.at(-1) }]; }));
  }
  validateRttMatrix(results) {
    for (const phase of ["initial", "reversed"]) {
      const rows = results.filter(row => row.phase === phase || !row.phase); if (!rows.length) continue;
      for (const row of rows) { const pair = [row.source, row.target].sort().join(""); const delayed = phase === "initial" ? pair === "bc" : pair === "ac"; if (delayed ? row.rttMs < 90 : row.rttMs > 60) return false; }
    }
    return true;
  }
  switchCounterSummary(initial, reversed) { return summarizeTcEvidence(reversed.after, this.plan); }
  drainCounterSummary(entries) { return summarizeTcEvidence(entries, this.plan, { drain: true }); }
  staticEvidence() {
    const evaluations = this.children.flatMap(row => row.events).filter(event => event.type === "qualityEvaluation"), members = evaluations.at(-1)?.members ?? [];
    const hostIds = [...new Set(members.map(member => member.hostId))];
    const namespaceInterfaces = this.namespaceSafety?.every(row => {
      const names = row.addresses.map(item => item.ifname).sort(), expected = ["lo", this.plan.config.names.hostVeth[row.id]].sort(), address = this.addresses[row.id];
      const experiment = row.addresses.find(item => item.ifname === this.plan.config.names.hostVeth[row.id]);
      return JSON.stringify(names) === JSON.stringify(expected) && experiment?.addr_info?.filter(item => item.family === "inet").length === 1 && experiment.addr_info.some(item => item.local === address && item.prefixlen === this.plan.config.cidrBits);
    }) === true;
    const expectedRoute = `${this.plan.config.subnetPrefix}0/${this.plan.config.cidrBits}`;
    const noExternalRoutes = this.namespaceSafety?.every(row => row.routes.length === 1 && row.routes[0].dst === expectedRoute && row.routes[0].dev === this.plan.config.names.hostVeth[row.id] && !row.routes[0].gateway) === true;
    const statuses = [...this.workers].map(([id, row]) => ({ id, sdk: row.status?.sdk })), leaderIds = new Set(statuses.map(row => row.sdk?.mesh?.leaderId).filter(Boolean));
    const leaderId = leaderIds.size === 1 ? [...leaderIds][0] : null, leaderMember = members.find(member => member.id === leaderId), owner = this.instanceNodes.get(leaderId) ?? Object.entries(this.addresses).find(([, address]) => address === leaderMember?.address)?.[0];
    const normalized = statuses.map(row => { try { const url = new URL(row.sdk.server), host = url.hostname === "127.0.0.1" && row.id === owner ? this.addresses[owner] : url.hostname; return row.sdk.connection === "connected" ? `${host}:${url.port}` : null; } catch { return null; } });
    const postReversalState = evaluateSnapshotQuorum(this.postReversalSnapshots, this.workers, this.config.runId, this.reversalBoundaryMonoMs, 64);
    const instrumentationIntegrity = this.children.every(row => row.events.every(event => !event.fatal && event.type !== "malformedJsonl" && event.outputIntegrity !== "incomplete"));
    return { hostIds, namespaceInterfaces, noExternalRoutes, uniqueAliases: new Set(Object.values(this.addresses)).size === 3, endpointNormalization: Boolean(owner) && normalized.every(Boolean) && new Set(normalized).size === 1, writerSequenceAndVersion: postReversalState.ok, postReversalState, instrumentationIntegrity };
  }
  async close() {
    await Promise.allSettled([...this.workers.values()].filter(row => !row.exited).map(row => this.send(row, "close", {}, 10000)));
    for (const row of this.servers.values()) if (!row.exited) row.child.kill("SIGTERM");
    if (this.capture && !this.capture.exited) this.capture.child.kill("SIGTERM");
    for (const row of this.children) { await Promise.race([row.ended, wait(5000)]); if (!row.exited) { row.child.kill("SIGKILL"); await Promise.race([row.ended, wait(2000)]); } row.lines.close(); }
    await this.writeChain;
    const bad = this.children.filter(row => {
      const diagnosticFinals = row.events.filter(event => event.type === "qualityDiagnosticFinal");
      const evaluations = row.events.filter(event => event.type === "qualityEvaluation"), final = diagnosticFinals[0], contiguous = evaluations.every((event, index) => event.sequence === index + 1) && final?.sequence === evaluations.length;
      const closed = row.events.filter(event => event.type === "closed");
      return !row.exited || (row.code !== 0 && row.signal !== "SIGTERM") || row.events.some(event => event.fatal || event.type === "malformedJsonl" || event.outputIntegrity === "incomplete") || (row.kind === "worker" && (row.stderr.trim() || closed.length !== 1 || closed[0].outputIntegrity !== "complete" || diagnosticFinals.length !== 1 || final.overflow || final.loggingError || final.sequence < 1 || !contiguous));
    });
    if (bad.length || this.recordingError) throw Error(`owned process cleanup or instrumentation integrity failed: ${[...bad.map(row => `${row.kind}-${row.id}`), ...(this.recordingError ? [`controller-log:${this.recordingError}`] : [])].join(",")}`);
  }
  async flush() { await this.writeChain; if (this.recordingError) throw Error(`controller event log failed: ${this.recordingError}`); }
}
