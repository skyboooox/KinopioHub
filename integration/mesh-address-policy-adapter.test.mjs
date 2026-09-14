import test from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adaptAddressPolicy, deriveAddressElection, sha256, SOURCE_HASHES, validateHostAddresses } from "./mesh-address-policy-adapter.mjs";

const sdk = fileURLToPath(new URL("../../KinopioHub.JS/", import.meta.url));
const testScratch = fileURLToPath(new URL("../../scratch/mesh-newjetson-20260908/adapter-tests/", import.meta.url));
const source = await readFile(path.join(sdk, "src/mesh-election.mjs"), "utf8");
const localAddresses = Object.values(os.networkInterfaces()).flat().filter(item => item?.family === "IPv4" && !item.internal).map(item => item.address);
if (!localAddresses.length) throw Error("address adapter tests require one noninternal local IPv4 address");
const hosts = [{ id: "first", addresses: [...new Set(localAddresses)] }, { id: "second", addresses: ["192.0.2.20"] }, { id: "third", addresses: ["192.0.2.30"] }];
const derived = deriveAddressElection(source, hosts);
const load = text => import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
const S = await load(derived), Q = await load(source);
const members = () => [
  { id: "self", hostId: "drifted-host-identity", address: "127.0.0.1", broker: null, vote: null, load: { cpu: 1, memory: 1 }, uplink: { reachable: false }, observations: {} },
  { id: "peer-b", hostId: "anything-b", address: "192.0.2.20", broker: null, vote: null, load: { cpu: 0, memory: 0 }, uplink: { reachable: true, rtt: 0 }, observations: {} },
  { id: "peer-c", hostId: "anything-c", address: "192.0.2.30", broker: null, vote: null, load: { cpu: 0, memory: 0 }, uplink: { reachable: true, rtt: 0 }, observations: {} },
];

test("address-ranked S selects physical rank while hostId drift and self loopback do not change it", () => {
  const view = members(), election = new S.MeshElection("self");
  assert.equal(election.evaluate(view, 0).vote, "self");
  view[0].hostId = "another-changing-host-identity";
  assert.equal(election.evaluate(view, 1000).vote, "self");
  assert.deepEqual(S.candidateScores(view), Q.candidateScores(view));
});

test("peer address chooses rank and unknown peers fail closed", () => {
  const view = members(), election = new S.MeshElection("self"); view[0].brokerFailed = true;
  assert.equal(election.evaluate(view, 0).vote, "peer-b");
  view[2].address = "198.51.100.99";
  assert.throws(() => election.evaluate(view, 1), /Unknown physical peer address/);
  view[2].address = "127.0.0.1";
  assert.throws(() => election.evaluate(view, 2), /Unknown physical peer address/);
});

test("local address resolution rejects unknown and ambiguous physical hosts", () => {
  const synthetic = address => ({ eth0: [{ family: "IPv4", internal: false, address }] });
  assert.equal(S.resolveLocalPhysicalRank(synthetic("192.0.2.20")), 1);
  assert.throws(() => S.resolveLocalPhysicalRank(synthetic("198.51.100.1")), /match 0/);
  assert.throws(() => S.resolveLocalPhysicalRank({ a: [{ family: "IPv4", internal: false, address: hosts[0].addresses[0] }], b: [{ family: "IPv4", internal: false, address: "192.0.2.20" }] }), /match 2/);
});

test("input rejects duplicate IDs, ambiguous aliases, non-IPv4 and incomplete inventories", () => {
  assert.throws(() => validateHostAddresses([]), /exactly three/);
  assert.throws(() => validateHostAddresses(hosts.slice(0, 2)), /exactly three/);
  assert.throws(() => validateHostAddresses([{ id: "x", addresses: [] }, ...hosts.slice(1)]), /nonempty/);
  assert.throws(() => validateHostAddresses([{ id: "x", addresses: ["192.0.2.1"] }, { id: "x", addresses: ["192.0.2.2"] }, hosts[2]]), /unique/);
  assert.throws(() => validateHostAddresses([{ id: "x", addresses: ["192.0.2.1"] }, { id: "y", addresses: ["192.0.2.1"] }, hosts[2]]), /ambiguous/);
  assert.throws(() => validateHostAddresses([{ id: "x", addresses: ["example.test"] }, ...hosts.slice(1)]), /IPv4/);
});

test("source guards, timers, rounds, scoring, eligibility and shared logic remain pinned", () => {
  assert.throws(() => deriveAddressElection(`${source}\n`, hosts), /source hash/);
  const election = new S.MeshElection("self"), view = members(); view[1].broker = { port: 4222 };
  assert.equal(election.minimumTermMs, 45000); assert.equal(election.improvementRounds, 3);
  for (const now of [0, 44999, 45000, 46500]) assert.equal(election.evaluate(view, now).vote, "peer-b");
  assert.equal(election.evaluate(view, 48000).vote, "self");
  view[0].brokerFailed = true; assert.equal(election.evaluate(view, 49500).vote, "peer-b");
  assert.equal(derived.includes("const scores = candidateScores(members);"), true);
  assert.equal(derived.includes("const delegates = hostMembers(members);"), true);
  assert.equal(derived.includes("const eligible = hostMembers(members.filter"), true);
  assert.equal(derived.includes("const majority = tally[0]"), true);
  assert.equal(deriveAddressElection(source, structuredClone(hosts)), derived);
});

test("isolated adaptation changes only mesh-election and records identical-host provenance", async t => {
  await mkdir(testScratch, { recursive: true });
  const root = await mkdtemp(path.join(testScratch, "mesh-address-adapter-")); t.after(() => rm(root, { recursive: true, force: true }));
  const production = path.join(root, "production"), target = path.join(root, "target");
  await mkdir(path.join(production, "src"), { recursive: true }); await mkdir(path.join(target, "src"), { recursive: true });
  for (const name of Object.keys(SOURCE_HASHES)) {
    await writeFile(path.join(production, "src", name), await readFile(path.join(sdk, "src", name)));
    await link(path.join(production, "src", name), path.join(target, "src", name));
  }
  const result = await adaptAddressPolicy({ sourceSdkDir: production, targetSdkDir: target, hostAddresses: hosts });
  assert.equal(result.policy, "S"); assert.equal(result.electionSha256, sha256(derived)); assert.deepEqual(result.hostAddresses, hosts);
  assert.equal(await readFile(path.join(production, "src/mesh-election.mjs"), "utf8"), source);
  assert.equal(sha256(await readFile(path.join(target, "src/mesh-node.mjs"))), SOURCE_HASHES["mesh-node.mjs"]);
  await assert.rejects(adaptAddressPolicy({ sourceSdkDir: production, targetSdkDir: target, hostAddresses: hosts }), /pristine/);
  await assert.rejects(adaptAddressPolicy({ sourceSdkDir: production, targetSdkDir: production, hostAddresses: hosts }), /isolated/);
});
