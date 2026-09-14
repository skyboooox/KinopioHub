import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, link } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { adaptPolicy, deriveElection, sha256, SOURCE_HASHES } from "./mesh-policy-adapter.mjs";
const sdk = fileURLToPath(new URL("../../KinopioHub.JS/", import.meta.url));
const source = await readFile(path.join(sdk, "src/mesh-election.mjs"), "utf8");
const ranks = ["hostA", "hostB", "hostC"];
const derived = deriveElection(source, { policy: "S", hostRanks: ranks });
const load = text => import(`data:text/javascript;base64,${Buffer.from(text).toString("base64")}`);
const S = await load(derived), Q = await load(source);
const members = () => ["a", "b", "c"].map((id, i) => ({ id, hostId: ranks[i], broker: null, vote: null,
  load: { cpu: id === "a" ? 1 : 0, memory: id === "a" ? 1 : 0 },
  uplink: { reachable: id === "b", rtt: id === "b" ? 0 : 60000 },
  observations: { a: { rtt: 60000, loss: 1 }, b: { rtt: 0, loss: 0 }, c: { rtt: 100, loss: 0.2 } },
}));

test("S ignores quality/load/coverage/uplink; Q source and diagnostic scores unchanged", () => {
  const view = members();
  assert.equal(deriveElection(source, { policy: "Q" }), source);
  assert.equal(new Q.MeshElection("a").evaluate(view, 0).vote, "b");
  assert.equal(new S.MeshElection("a").evaluate(view, 0).vote, "a");
  for (const m of view) { m.load = { cpu: 1, memory: 1 }; m.uplink = { reachable: false }; m.observations = { c: { rtt: 0, loss: 0 } }; }
  view[2].load = { cpu: 0, memory: 0 }; view[2].uplink = { reachable: true, rtt: 0 };
  assert.equal(new S.MeshElection("a").evaluate(view, 0).vote, "a");
  assert.deepEqual(S.candidateScores(view), Q.candidateScores(view));
});
test("both arms preserve broker failure, retry eligibility and failed vote rejection", () => {
  for (const arm of [S, Q]) {
    const view = members(); view[0].broker = { port: 4222 }; view[0].brokerFailed = true;
    view[1].unavailableUntil = 200; view[1].vote = "a"; view[2].vote = "a";
    const result = new arm.MeshElection("a").evaluate(view, 100);
    assert.equal(result.vote, "c"); assert.equal(result.winner, "c"); assert.equal(result.votes.has("a"), false);
    assert.equal(new arm.MeshElection("a").evaluate(view, 200).vote, "b");
  }
});
test("45-second term and three rounds precede rank handoff; majority remains required", () => {
  const election = new S.MeshElection("a"), view = members(); view[1].broker = { port: 4222 };
  assert.equal(election.minimumTermMs, 45000); assert.equal(election.improvementRounds, 3);
  for (const now of [0, 1500, 44999, 45000, 46500]) assert.equal(election.evaluate(view, now).vote, "b");
  assert.equal(election.evaluate(view, 48000).vote, "a");
  assert.equal(election.evaluate(view, 49500).winner, "b");
  view[1].vote = "a"; assert.equal(election.evaluate(view, 51000).winner, "a");
});
test("interrupted challenge resets rounds; new incumbent resets term", () => {
  const election = new S.MeshElection("a"), view = members(); view[1].broker = { port: 4222 };
  election.evaluate(view, 0); election.evaluate(view, 45000); election.evaluate(view, 46500);
  view[0].brokerFailed = true; assert.equal(election.evaluate(view, 48000).vote, "b"); assert.equal(election.rounds, 0);
  view[0].brokerFailed = false;
  assert.equal(election.evaluate(view, 49500).vote, "b"); assert.equal(election.evaluate(view, 51000).vote, "b"); assert.equal(election.evaluate(view, 52500).vote, "a");
  view[1].broker = null; view[2].broker = { port: 4222 };
  assert.equal(election.evaluate(view, 54000).vote, "c"); assert.equal(election.incumbentSince, 54000);
});
test("higher-ranked incumbent never switches toward improved Q metrics", () => {
  const view = members(), election = new S.MeshElection("a"); view[0].broker = { port: 4222 };
  for (const now of [0, 45000, 46500, 48000, 100000]) assert.equal(election.evaluate(view, now).vote, "a");
});
test("per-host delegation and leader tie handling remain shared", () => {
  for (const arm of [S, Q]) {
    const view = members(); view[0].brokerFailed = true; view.push({ ...view[0], id: "aa", brokerFailed: false, vote: "c" });
    assert.deepEqual(arm.hostMembers(view).map(m => m.id), ["a", "b", "c"]);
    const election = new arm.MeshElection("a"), result = election.evaluate(view, 0);
    assert.equal([...result.votes.values()].reduce((a, b) => a + b, 0), 1);
    view[1].broker = { port: 4222 }; view[2].broker = { port: 4223 }; assert.equal(election.evaluate(view, 1).vote, "b");
  }
  const view = members(); view[0].brokerFailed = true; view.push({ ...view[0], id: "aa", brokerFailed: false });
  assert.equal(new S.MeshElection("a").evaluate(view, 0).vote, "aa");
});
test("source pin, complete rank inventory and input validation fail closed", () => {
  assert.throws(() => deriveElection(source + "\n", { policy: "S", hostRanks: ranks }), /source hash/);
  for (const hostRanks of [[], ["hostA", "hostA"], [""], ["constructor"], {}]) assert.throws(() => deriveElection(source, { policy: "S", hostRanks }), /hostRanks/);
  assert.throws(() => deriveElection(source, { policy: "Q", hostRanks: ranks }), /does not accept/);
  assert.throws(() => deriveElection(source, { policy: "F" }), /policy/);
  assert.throws(() => new S.MeshElection("z").evaluate([{ id: "z", hostId: "unknown" }], 0), /Unranked/);
});
test("isolated adaptation records provenance and preserves hard-linked original", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mesh-adapter-")); t.after(() => rm(root, { recursive: true, force: true }));
  const production = path.join(root, "production"), target = path.join(root, "target");
  await mkdir(path.join(production, "src"), { recursive: true }); await mkdir(path.join(target, "src"), { recursive: true });
  for (const name of Object.keys(SOURCE_HASHES)) {
    await writeFile(path.join(production, "src", name), await readFile(path.join(sdk, "src", name)));
    await link(path.join(production, "src", name), path.join(target, "src", name));
  }
  const q = await adaptPolicy({ sourceSdkDir: production, targetSdkDir: target, policy: "Q" });
  assert.equal(q.electionSha256, SOURCE_HASHES["mesh-election.mjs"]);
  const s = await adaptPolicy({ sourceSdkDir: production, targetSdkDir: target, policy: "S", hostRanks: ranks });
  assert.equal(s.electionSha256, sha256(derived)); assert.deepEqual(s.hostRanks, ranks); assert.match(s.adapterSha256, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(path.join(production, "src/mesh-election.mjs"), "utf8"), source);
  assert.equal(sha256(await readFile(path.join(target, "src/mesh-node.mjs"))), SOURCE_HASHES["mesh-node.mjs"]);
  await assert.rejects(adaptPolicy({ sourceSdkDir: production, targetSdkDir: target, policy: "S", hostRanks: ranks }), /pristine/);
  await assert.rejects(adaptPolicy({ sourceSdkDir: production, targetSdkDir: production, policy: "Q" }), /isolated/);
});
