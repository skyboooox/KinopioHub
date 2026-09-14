#!/usr/bin/env node

import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const IDS = ["a", "b", "c"];
const PHASES = Object.freeze({ initial: { ab: 0, ac: 0, bc: 60 }, reversed: { ab: 0, ac: 60, bc: 0 } });

function ident(value, label) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) throw Error(`${label} must be a lowercase safe identifier`);
  return value;
}
function ipv4(value, label) { if (net.isIP(value) !== 4) throw Error(`${label} must be IPv4`); return value; }
function mac(value, label) { if (typeof value !== "string" || !/^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/.test(value) || value === "00:00:00:00:00:00" || (parseInt(value.slice(0, 2), 16) & 1)) throw Error(`${label} must be a unique unicast MAC`); return value; }

export function validateNetworkConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("network config must be an object");
  const owner = ident(raw.owner, "owner");
  const prefix = `mq${owner.replace(/[^a-z0-9]/g, "").slice(0, 6)}`;
  const subnetPrefix = raw.subnetPrefix;
  if (typeof subnetPrefix !== "string" || !/^10\.(?:\d{1,3}\.){2}$/.test(subnetPrefix) || subnetPrefix.split(".").slice(0, 3).some(Number).some?.(() => false)) throw Error("subnetPrefix must look like 10.x.y.");
  const octets = subnetPrefix.slice(0, -1).split(".").map(Number);
  if (octets.some(value => value < 0 || value > 255)) throw Error("subnetPrefix octets are invalid");
  const nodes = IDS.map((id, index) => {
    const input = raw.nodes?.[id] ?? {};
    return { id, address: ipv4(input.address ?? `${subnetPrefix}${index + 11}`, `nodes.${id}.address`), mac: mac(input.mac ?? `02:00:00:00:00:${String(index + 1).padStart(2, "0")}`, `nodes.${id}.mac`) };
  });
  if (new Set(nodes.map(item => item.address)).size !== 3 || new Set(nodes.map(item => item.mac)).size !== 3) throw Error("node addresses and MACs must be unique");
  const names = { switch: `${prefix}x`, bridge: `${prefix}br`, namespaces: Object.fromEntries(IDS.map(id => [id, `${prefix}${id}`])), hostVeth: Object.fromEntries(IDS.map(id => [id, `${prefix}${id}h`])), switchVeth: Object.fromEntries(IDS.map(id => [id, `${prefix}${id}x`])) };
  if (Object.values(names).flatMap(value => typeof value === "string" ? [value] : Object.values(value)).some(value => value.length > 15)) throw Error("owned interface name exceeds Linux IFNAMSIZ");
  return { owner, prefix, subnetPrefix, cidrBits: 24, delayMs: 60, nodes, names };
}

const c = (...argv) => argv;
const ipn = (ns, ...argv) => c("ip", "netns", "exec", ns, ...argv);
function delayFor(matrix, receiver, source) { if (receiver === source) return 0; const pair = [receiver, source].sort().join(""); const value = PHASES[matrix][pair]; if (!Number.isFinite(value)) throw Error(`missing delay for ${matrix} ${receiver}-${source}`); return value; }

/** Commands are argv arrays: callers never interpolate shell text. */
export function buildNetworkPlan(raw) {
  const config = validateNetworkConfig(raw), { names } = config;
  const setup = [c("ip", "netns", "add", names.switch), ...IDS.map(id => c("ip", "netns", "add", names.namespaces[id]))];
  for (const node of config.nodes) {
    const id = node.id;
    setup.push(c("ip", "link", "add", names.hostVeth[id], "type", "veth", "peer", "name", names.switchVeth[id]));
    setup.push(c("ip", "link", "set", names.hostVeth[id], "netns", names.namespaces[id]));
    setup.push(c("ip", "link", "set", names.switchVeth[id], "netns", names.switch));
  }
  setup.push(ipn(names.switch, "ip", "link", "add", names.bridge, "type", "bridge", "mcast_snooping", "0"));
  setup.push(ipn(names.switch, "ip", "link", "set", names.bridge, "up"));
  setup.push(ipn(names.switch, "ip", "link", "set", "lo", "up"));
  for (const node of config.nodes) {
    const { id, address, mac: addressMac } = node;
    setup.push(ipn(names.namespaces[id], "ip", "link", "set", "lo", "up"));
    setup.push(ipn(names.namespaces[id], "ip", "link", "set", names.hostVeth[id], "address", addressMac));
    setup.push(ipn(names.namespaces[id], "ip", "addr", "add", `${address}/${config.cidrBits}`, "dev", names.hostVeth[id]));
    setup.push(ipn(names.namespaces[id], "ip", "link", "set", names.hostVeth[id], "up"));
    setup.push(ipn(names.switch, "ip", "link", "set", names.switchVeth[id], "master", names.bridge));
    setup.push(ipn(names.switch, "ip", "link", "set", names.switchVeth[id], "up"));
    setup.push(ipn(names.switch, "tc", "qdisc", "add", "dev", names.switchVeth[id], "root", "handle", "1:", "prio", "bands", "4", "priomap", ...Array(16).fill("3")));
    for (let sourceIndex = 0; sourceIndex < config.nodes.length; sourceIndex++) {
      const source = config.nodes[sourceIndex], band = sourceIndex + 1, handle = `${10 + sourceIndex}:`;
      setup.push(ipn(names.switch, "tc", "qdisc", "add", "dev", names.switchVeth[id], "parent", `1:${band}`, "handle", handle, "netem", "delay", `${delayFor("initial", id, source.id)}ms`));
      setup.push(ipn(names.switch, "tc", "filter", "add", "dev", names.switchVeth[id], "protocol", "ip", "parent", "1:", "prio", String(band), "u32", "match", "ip", "src", `${source.address}/32`, "flowid", `1:${band}`));
    }
  }
  const matrix = phase => config.nodes.flatMap(receiver => config.nodes.map((source, sourceIndex) => ipn(names.switch, "tc", "qdisc", "change", "dev", names.switchVeth[receiver.id], "parent", `1:${sourceIndex + 1}`, "handle", `${10 + sourceIndex}:`, "netem", "delay", `${delayFor(phase, receiver.id, source.id)}ms`)));
  const inspect = config.nodes.flatMap(node => [ipn(names.namespaces[node.id], "ip", "-j", "addr", "show"), ipn(names.namespaces[node.id], "ip", "-j", "route", "show"), ipn(names.switch, "tc", "-s", "-j", "qdisc", "show", "dev", names.switchVeth[node.id]), ipn(names.switch, "tc", "-s", "-j", "filter", "show", "dev", names.switchVeth[node.id], "parent", "1:")]);
  const cleanup = [...IDS.map(id => c("ip", "netns", "del", names.namespaces[id])), c("ip", "netns", "del", names.switch)];
  return { config, setup, initial: matrix("initial"), reversed: matrix("reversed"), inspect, cleanup };
}

export function validatePairFilterCoverage(plan) {
  const filters = plan.setup.filter(argv => argv.includes("filter") && argv.includes("src"));
  const expected = new Set(plan.config.nodes.flatMap(receiver => plan.config.nodes.map(source => `${plan.config.names.switchVeth[receiver.id]}|${source.address}`)));
  for (const argv of filters) expected.delete(`${argv[argv.indexOf("dev") + 1]}|${argv[argv.indexOf("src") + 1].replace("/32", "")}`);
  return { ok: filters.length === 9 && expected.size === 0, filters: filters.length, missing: [...expected] };
}

/** Refuse host execution: the controller namespace must be an empty network sandbox. */
export function validateSandboxIsolation(links, routes) {
  if (!Array.isArray(links) || !Array.isArray(routes)) throw Error("sandbox links and routes must be iproute2 JSON arrays");
  const names = links.map(link => link?.ifname).filter(Boolean), unexpectedLinks = names.filter(name => name !== "lo");
  const unexpectedRoutes = routes.filter(route => route?.dst !== "local" && route?.dev !== "lo");
  const loopback = links.find(link => link?.ifname === "lo");
  const ok = names.length === 1 && Boolean(loopback) && unexpectedLinks.length === 0 && unexpectedRoutes.length === 0;
  return { ok, unexpectedLinks, unexpectedRoutes, reason: ok ? null : "controller namespace must contain only loopback and no external routes" };
}

export async function executeArgv(argv, { timeoutMs = 15000, spawnImpl = spawn } = {}) {
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== "string")) throw Error("command must be an argv array");
  return await new Promise((resolve, reject) => {
    const child = spawnImpl(argv[0], argv.slice(1), { stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = "", bytes = 0, settled = false, timer;
    const failure = (message, code) => Object.assign(Error(message), { code, argv, stdout, stderr });
    const fail = error => { if (settled) return; settled = true; clearTimeout(timer); reject(error); };
    const append = (which, chunk) => {
      const limit = 4 * 1024 * 1024, available = Math.max(0, limit - bytes), retained = chunk.subarray ? chunk.subarray(0, available) : String(chunk).slice(0, available); bytes += Buffer.byteLength(retained);
      if (which === "out") stdout += retained; else stderr += retained;
      if (chunk.length > available) { child.kill("SIGKILL"); fail(failure("command output exceeded 4 MiB", "OUTPUT_LIMIT")); }
    };
    child.stdout?.on("data", chunk => append("out", chunk)); child.stderr?.on("data", chunk => append("err", chunk));
    timer = setTimeout(() => { child.kill("SIGKILL"); fail(failure(`command timed out: ${argv.join(" ")}`, "COMMAND_TIMEOUT")); }, timeoutMs);
    child.once("error", error => fail(Object.assign(error, { argv, stdout, stderr })));
    child.once("close", code => { if (settled) return; clearTimeout(timer); settled = true; code === 0 ? resolve({ argv, stdout, stderr, code }) : reject(failure(`command failed (${code}): ${argv.join(" ")}: ${stderr.slice(0, 500)}`, code)); });
  });
}

export async function runCommands(commands, options) { const output = []; for (const argv of commands) output.push(await executeArgv(argv, options)); return output; }

export async function inspectOwnedNamespacePids(plan, options = {}) {
  const entries = [];
  for (const namespace of [...Object.values(plan.config.names.namespaces), plan.config.names.switch]) {
    const argv = ["ip", "netns", "pids", namespace], requestMonoMs = performance.now();
    try {
      const result = await executeArgv(argv, options), completeMonoMs = performance.now(), pids = result.stdout.trim() ? result.stdout.trim().split(/\s+/).map(Number) : [];
      entries.push({ namespace, argv, requestMonoMs, completeMonoMs, stdout: result.stdout, stderr: result.stderr, code: result.code, pids, parseError: pids.some(pid => !Number.isSafeInteger(pid) || pid < 1) ? "invalid PID output" : null });
    } catch (error) { entries.push({ namespace, argv, requestMonoMs, completeMonoMs: performance.now(), stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code ?? null, pids: [], parseError: String(error?.message ?? error) }); }
  }
  return { ok: entries.every(entry => !entry.parseError && entry.pids.length === 0), entries };
}

export async function createOwnedNetwork(plan, options = {}) {
  const namespaceResult = await executeArgv(["ip", "netns", "list"], options), linkResult = await executeArgv(["ip", "-j", "link", "show"], options);
  const existingNamespaces = new Set(namespaceResult.stdout.split("\n").map(line => line.trim().split(/\s+/)[0]).filter(Boolean));
  const existingLinks = new Set(JSON.parse(linkResult.stdout).map(link => link.ifname));
  const managedNamespaces = [...Object.values(plan.config.names.namespaces), plan.config.names.switch], managedLinks = [plan.config.names.bridge, ...Object.values(plan.config.names.hostVeth), ...Object.values(plan.config.names.switchVeth)];
  const collisions = [...managedNamespaces.filter(name => existingNamespaces.has(name)), ...managedLinks.filter(name => existingLinks.has(name))];
  if (collisions.length) throw Error(`managed network resource already exists: ${collisions.join(", ")}`);
  const journal = { schema: "kinopio-mesh-quality-network-journal/v1", owner: plan.config.owner, namespaces: [], rootLinks: [] }, output = [];
  const persist = async () => {
    if (!options.journalPath) return;
    if (!path.isAbsolute(options.journalPath)) throw Error("journalPath must be absolute");
    const temporary = `${options.journalPath}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(journal, null, 2), { flag: "wx" }); await fs.rename(temporary, options.journalPath); }
    finally { await fs.rm(temporary, { force: true }); }
  };
  await persist();
  try {
    for (const argv of plan.setup) {
      output.push(await executeArgv(argv, options));
      if (argv.slice(0, 3).join(" ") === "ip netns add") journal.namespaces.push(argv[3]);
      if (argv[0] === "ip" && argv[1] === "link" && argv[2] === "add" && argv.includes("veth")) journal.rootLinks.push(argv[3], argv[argv.indexOf("name") + 1]);
      if (argv.slice(0, 3).join(" ") === "ip link set" && argv.includes("netns")) journal.rootLinks = journal.rootLinks.filter(name => name !== argv[3]);
      await persist();
    }
    return { journal, output };
  } catch (error) { error.networkJournal = journal; throw error; }
}

export async function cleanupOwnedNetwork(raw, options = {}) {
  const plan = buildNetworkPlan(raw), journal = options.journal;
  if (!journal || journal.schema !== "kinopio-mesh-quality-network-journal/v1" || journal.owner !== plan.config.owner || !Array.isArray(journal.namespaces) || !Array.isArray(journal.rootLinks)) throw Error("an exact ownership journal is required for cleanup");
  const allowedNamespaces = new Set([...Object.values(plan.config.names.namespaces), plan.config.names.switch]), allowedLinks = new Set([...Object.values(plan.config.names.hostVeth), ...Object.values(plan.config.names.switchVeth)]);
  if (journal.namespaces.some(name => !allowedNamespaces.has(name)) || journal.rootLinks.some(name => !allowedLinks.has(name))) throw Error("ownership journal contains an unmanaged resource");
  const commands = [...new Set(journal.namespaces)].reverse().map(name => ["ip", "netns", "del", name]);
  const output = [], errors = [];
  for (const argv of commands) {
    const namespace = argv.at(-1);
    try {
      const pids = await executeArgv(["ip", "netns", "pids", namespace], options); output.push(pids);
      if (pids.stdout.trim()) { errors.push(Error(`owned namespace ${namespace} still contains processes: ${pids.stdout.trim().split(/\s+/).join(",")}`)); continue; }
      output.push(await executeArgv(argv, options));
    } catch (error) { errors.push(error); }
  }
  for (const argv of [...new Set(journal.rootLinks)].map(name => ["ip", "link", "del", name])) try { output.push(await executeArgv(argv, options)); } catch (error) { errors.push(error); }
  if (errors.length) throw Error(`owned network cleanup failed for ${errors.length} resource(s): ${errors.map(error => error.message).join("; ")}`);
  return output;
}

export async function writeOwnershipManifest(directory, plan) {
  await fs.mkdir(directory, { recursive: true });
  const filename = path.join(directory, "network-ownership.json");
  await fs.writeFile(filename, JSON.stringify({ schema: "kinopio-mesh-quality-network/v1", owner: plan.config.owner, names: plan.config.names }, null, 2), { flag: "wx" });
  return filename;
}

export const NETWORK_PHASES = PHASES;
