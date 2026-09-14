import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { buildNetworkPlan, cleanupOwnedNetwork, executeArgv, validatePairFilterCoverage, validateNetworkConfig, validateSandboxIsolation } from "./mesh-quality-network.mjs";

const config = { owner: "trial1", subnetPrefix: "10.77.9.", nodes: { a: { address: "10.77.9.11", mac: "02:11:00:00:00:01" }, b: { address: "10.77.9.12", mac: "02:11:00:00:00:02" }, c: { address: "10.77.9.13", mac: "02:11:00:00:00:03" } } };

test("source filters cover all nine receiver/source paths and both delay matrices", () => {
  const plan = buildNetworkPlan(config), coverage = validatePairFilterCoverage(plan);
  assert.deepEqual(coverage, { ok: true, filters: 9, missing: [] });
  const delays = commands => commands.map(argv => [argv[argv.indexOf("dev") + 1], argv.at(-1)]);
  assert.equal(delays(plan.initial).filter(([, delay]) => delay === "60ms").length, 2);
  assert.equal(delays(plan.reversed).filter(([, delay]) => delay === "60ms").length, 2);
  assert.ok([...plan.setup, ...plan.initial, ...plan.reversed].filter(argv => argv.includes("delay")).every(argv => /^(?:0|60)ms$/.test(argv.at(-1))));
  assert.ok(plan.setup.every(argv => !argv.includes("eth0") && !argv.includes("iptables") && !argv.includes("nft")));
  assert.ok(plan.setup.filter(argv => argv.includes("filter")).every(argv => argv.includes("src") && !argv.includes("dport")));
});

test("unique addresses and unicast MACs are mandatory", () => {
  assert.equal(validateNetworkConfig(config).nodes.length, 3);
  assert.throws(() => validateNetworkConfig({ ...config, nodes: { ...config.nodes, b: { ...config.nodes.b, mac: config.nodes.a.mac } } }), /unique/);
  assert.throws(() => validateNetworkConfig({ ...config, nodes: { ...config.nodes, b: { ...config.nodes.b, mac: "01:00:00:00:00:02" } } }), /unicast/);
});

test("cleanup issues deletes only for exact owned namespaces reported as existing", async () => {
  const calls = [], plan = buildNetworkPlan(config);
  await cleanupOwnedNetwork(config, { journal: { schema: "kinopio-mesh-quality-network-journal/v1", owner: "trial1", namespaces: [plan.config.names.namespaces.a], rootLinks: [] }, spawnImpl(command, args) {
    calls.push([command, ...args]);
    const listeners = {}; return { stdout: { on() {} }, stderr: { on() {} }, once(name, fn) { listeners[name] = fn; if (name === "close") queueMicrotask(() => fn(0)); }, kill() {} };
  } });
  assert.deepEqual(calls, [["ip", "netns", "pids", plan.config.names.namespaces.a], ["ip", "netns", "del", plan.config.names.namespaces.a]]);
  await assert.rejects(cleanupOwnedNetwork(config, { journal: { schema: "kinopio-mesh-quality-network-journal/v1", owner: "wrong", namespaces: [], rootLinks: [] } }), /exact ownership journal/);
});

test("execution refuses a controller namespace with any physical or external interface", () => {
  assert.equal(validateSandboxIsolation([{ ifname: "lo" }], []).ok, true);
  const hostLike = validateSandboxIsolation([{ ifname: "lo" }, { ifname: "eth0" }], [{ dst: "default", dev: "eth0" }]);
  assert.equal(hostLike.ok, false); assert.deepEqual(hostLike.unexpectedLinks, ["eth0"]); assert.equal(hostLike.unexpectedRoutes.length, 1);
});

test("cleanup refuses to delete a namespace while a sender PID remains", async () => {
  const plan = buildNetworkPlan(config), calls = [];
  const spawnImpl = (command, args) => {
    calls.push([command, ...args]); const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.emit("data", Buffer.from("42\n")); child.emit("close", 0); }); return child;
  };
  await assert.rejects(cleanupOwnedNetwork(config, { journal: { schema: "kinopio-mesh-quality-network-journal/v1", owner: "trial1", namespaces: [plan.config.names.namespaces.a], rootLinks: [] }, spawnImpl }), /still contains processes/);
  assert.deepEqual(calls, [["ip", "netns", "pids", plan.config.names.namespaces.a]]);
});

test("timed-out commands retain bounded stdout and stderr for the raw failure record", async () => {
  const spawnImpl = () => {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => { child.stdout.emit("data", Buffer.from("partial-out")); child.stderr.emit("data", Buffer.from("partial-error")); }); return child;
  };
  await assert.rejects(executeArgv(["tc", "-j", "qdisc"], { timeoutMs: 5, spawnImpl }), error => error.code === "COMMAND_TIMEOUT" && error.stdout === "partial-out" && error.stderr === "partial-error");
});
