#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WRAPPED = Symbol.for("kinopio.mesh-quality.evaluate-wrapped");

function safe(value) {
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [key, safe(item)]));
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)]));
  return value;
}

/** Install before importing node.mjs. The original evaluate is invoked exactly once. */
export function wrapEvaluate(MeshElection, emit, { maxBytes = 16 * 1024 * 1024, now = () => performance.now() } = {}) {
  if (typeof MeshElection?.prototype?.evaluate !== "function") throw Error("MeshElection.evaluate is required");
  if (MeshElection.prototype[WRAPPED]) throw Error("MeshElection.evaluate is already wrapped");
  const original = MeshElection.prototype.evaluate; let bytes = 0, sequence = 0, overflow = false, loggingError = null;
  const report = event => { try { emit(event); return true; } catch (error) { loggingError ??= String(error?.message ?? error).slice(0, 500); return false; } };
  function instrumented(members, evaluationNow) {
    const membersSnapshot = safe(members);
    const before = { incumbent: this.incumbent, incumbentSince: this.incumbentSince, challenger: this.challenger, rounds: this.rounds };
    const result = original.call(this, members, evaluationNow);
    const event = safe({ type: "qualityEvaluation", sequence: ++sequence, monoMs: now(), instanceId: this.id, evaluationNow, members: membersSnapshot, result, before, after: { incumbent: this.incumbent, incumbentSince: this.incumbentSince, challenger: this.challenger, rounds: this.rounds } });
    const size = Buffer.byteLength(JSON.stringify(event)) + 1;
    if (!overflow && bytes + size <= maxBytes) { bytes += size; report(event); }
    else if (!overflow) { overflow = true; report({ type: "qualityDiagnosticOverflow", monoMs: now(), maxBytes, bytes, fatal: true }); }
    return result;
  }
  Object.defineProperty(MeshElection.prototype, "evaluate", { configurable: true, writable: true, value: instrumented });
  Object.defineProperty(MeshElection.prototype, WRAPPED, { configurable: true, value: true });
  return {
    stats: () => ({ bytes, sequence, overflow, loggingError }),
    restore() { if (MeshElection.prototype.evaluate === instrumented) { Object.defineProperty(MeshElection.prototype, "evaluate", { configurable: true, writable: true, value: original }); delete MeshElection.prototype[WRAPPED]; } },
  };
}

export function validateQualityWorkerConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("config must be an object");
  for (const key of ["sdkPath", "studyWorkerPath"]) if (typeof raw[key] !== "string" || !path.isAbsolute(raw[key]) || !raw[key].endsWith(".mjs")) throw Error(`${key} must be an absolute .mjs path`);
  const diagnosticMaxBytes = raw.diagnosticMaxBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(diagnosticMaxBytes) || diagnosticMaxBytes < 65536 || diagnosticMaxBytes > 256 * 1024 * 1024) throw Error("diagnosticMaxBytes is out of bounds");
  return { ...raw, diagnosticMaxBytes };
}

export async function createQualityWorker(raw, dependencies = {}) {
  const config = validateQualityWorkerConfig(raw);
  const electionUrl = pathToFileURL(path.join(path.dirname(config.sdkPath), "mesh-election.mjs")).href;
  const electionModule = dependencies.electionModule ?? await import(electionUrl);
  const output = dependencies.output ?? process.stdout;
  let blocked = false; output.on?.("drain", () => { blocked = false; });
  const emit = dependencies.emit ?? (event => {
    if (blocked) throw Error("diagnostic stdout remains backpressured");
    blocked = !output.write(`${JSON.stringify({ wallTime: new Date().toISOString(), wallMs: Date.now(), ...event })}\n`);
    if (blocked) throw Error("diagnostic stdout became backpressured");
  });
  const instrumentation = wrapEvaluate(electionModule.MeshElection, emit, { maxBytes: config.diagnosticMaxBytes, now: dependencies.now });
  try {
    const study = dependencies.studyModule ?? await import(pathToFileURL(config.studyWorkerPath).href);
    const workerConfig = { ...config }; delete workerConfig.studyWorkerPath; delete workerConfig.diagnosticMaxBytes;
    const worker = await study.createStudyWorker(workerConfig, { ...(dependencies.studyDependencies ?? {}), output });
    void worker.done.finally(() => {
      const stats = instrumentation.stats();
      let finalWritten = true;
      try { emit({ type: "qualityDiagnosticFinal", monoMs: performance.now(), ...stats, fatal: stats.overflow || Boolean(stats.loggingError) }); } catch { finalWritten = false; }
      if (stats.overflow || stats.loggingError || !finalWritten) { try { (dependencies.markFailed ?? (() => { process.exitCode = 1; }))(); } catch {} }
      instrumentation.restore();
    });
    const originalClose = worker.close;
    worker.close = async (...args) => {
      try { return await originalClose(...args); } finally { instrumentation.restore(); }
    };
    return { ...worker, instrumentation, close: worker.close };
  } catch (error) { instrumentation.restore(); throw error; }
}

async function main() {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== "--config") throw Error("usage: node mesh-quality-worker.mjs --config config.json");
    const config = JSON.parse(await fs.readFile(path.resolve(process.argv[3]), "utf8"));
    const worker = await createQualityWorker(config);
    const close = () => { void worker.close("signal"); };
    process.once("SIGTERM", close); process.once("SIGINT", close);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ wallTime: new Date().toISOString(), wallMs: Date.now(), monoMs: performance.now(), type: "error", operation: "quality-bootstrap", error: { code: error?.code ?? "QUALITY_WORKER_ERROR", message: String(error?.message ?? error).slice(0, 500) } })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
