import assert from "node:assert/strict";
import test from "node:test";
import { advanceStableInterval, commonEndpointState, directedPairFreshness, normalizeEndpoint, validateComparisonConfig } from "./mesh-comparison.mjs";

const host = (id, extra = {}) => ({ id, directory: `/tmp/${id}`, node: "/usr/bin/node", worker: `/tmp/${id}/worker.mjs`, sdkBase: `/tmp/${id}/sdk-base`, sdkPolicy: { S: `/tmp/${id}/sdk-S`, Q: `/tmp/${id}/sdk-Q` }, binary: `/tmp/${id}/nats-server`, binarySha256: "a".repeat(64), advertiseAddress: `192.0.2.${id.charCodeAt(0)}`, ...extra });
const base = { policy: "Q", hosts: [host("a"), host("b"), host("c")], output: "/tmp/results", runId: "run-1" };

test("comparison config freezes policies, hosts, fault, and timing defaults", () => {
  const value = validateComparisonConfig(base);
  assert.equal(value.fault, "broker-kill"); assert.equal(value.setupTimeoutMs, 240000); assert.equal(value.postfaultMs, 180000);
  assert.equal(value.hosts[0].supervisorPath, "/tmp/a/mesh-fixed-supervisor.mjs");
  assert.throws(() => validateComparisonConfig({ ...base, policy: "F-R" }), /fixedHost/);
  assert.throws(() => validateComparisonConfig({ ...base, policy: "S" }), /expectedLeaderHost/);
  assert.throws(() => validateComparisonConfig({ ...base, fault: "host-kill" }), /fixed to broker-kill/);
  assert.throws(() => validateComparisonConfig({ ...base, runId: "bad.id" }), /safe identifier/);
  assert.equal(validateComparisonConfig({ ...base, policy: "F-R", fixedHost: "b" }).fixedHost, "b");
  const noAdvertise = { ...base, policy: "F-R", fixedHost: "b", hosts: base.hosts.map(item => item.id === "b" ? { ...item, advertiseAddress: undefined } : item) };
  assert.throws(() => validateComparisonConfig(noAdvertise), /requires advertiseAddress/);
  assert.equal(validateComparisonConfig({ ...base, policy: "S", expectedLeaderHost: "a" }).expectedLeaderHost, "a");
});

test("loopback leader endpoints normalize to the owner's physical address and port", () => {
  assert.equal(normalizeEndpoint("nats://127.0.0.1:4222", ["192.0.2.8"]), "nats://owner:4222");
  const now = 10000, leader = "instance-b";
  const rows = ["a", "b", "c"].map(id => ({ host: host(id), statusReceivedAt: now - 50, ready: { runtime: { sdk: { instanceId: id === "b" ? leader : `instance-${id}` }, interfaces: {} } }, status: { sdk: { instanceId: id === "b" ? leader : `instance-${id}`, connection: "connected", server: id === "b" ? "nats://127.0.0.1:4333" : `nats://${host("b").advertiseAddress}:4333`, mesh: { leaderId: leader, role: id === "b" ? "leader" : "follower", members: 3 } } } }));
  const state = commonEndpointState(rows, now);
  assert.equal(state.ok, true); assert.equal(state.leaderHost, "b"); assert.equal(state.endpoint, "nats://owner:4333");
  rows[0].status.sdk.server = "nats://127.0.0.1:4333";
  assert.equal(commonEndpointState(rows, now).ok, false);
  rows[0].status.sdk.server = `nats://${host("b").advertiseAddress}:4333`;
  rows[0].status.sdk.mesh.leaderId = null;
  assert.equal(commonEndpointState(rows, now).reason, "leader-not-common");
});

test("stability resets on signature changes and only succeeds after the full hold", () => {
  const first = advanceStableInterval(null, { ok: true, leaderId: "x", endpoint: "nats://a:1" }, 100, 60);
  assert.equal(first.achieved, false);
  const held = advanceStableInterval(first, { ok: true, leaderId: "x", endpoint: "nats://a:1" }, 160, 60);
  assert.equal(held.achieved, true);
  const changed = advanceStableInterval(held, { ok: true, leaderId: "y", endpoint: "nats://b:1" }, 170, 60);
  assert.equal(changed.achieved, false); assert.equal(changed.since, 170);
  assert.equal(advanceStableInterval(changed, { ok: false }, 200, 60).since, null);
});

test("directed freshness requires every non-self pair after the boundary and recently observed", () => {
  const rows = ["a", "b", "c"].map(receiver => ({ host: { id: receiver }, observations: new Map(["a", "b", "c"].filter(source => source !== receiver).map(source => [source, { seq: 9, receivedAt: 990 }])) }));
  assert.equal(directedPairFreshness(rows, ["a", "b", "c"], 900, 1000, 200, new Map([["a", 8], ["b", 8], ["c", 8]])).ok, true);
  rows[0].observations.set("b", { seq: 10, receivedAt: 800 });
  const failed = directedPairFreshness(rows, ["a", "b", "c"], 900, 1000, 200, new Map([["a", 8], ["b", 9], ["c", 8]]));
  assert.equal(failed.ok, false); assert.equal(failed.pairs.find(pair => pair.receiver === "a" && pair.sourceId === "b").afterBoundary, false);
});
