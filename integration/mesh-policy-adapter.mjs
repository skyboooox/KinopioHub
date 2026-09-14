/** Experiment-only S/Q adapter. Never import this file from a published SDK. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_HASHES = Object.freeze({
  "mesh-election.mjs": "cd87500f8fd47daedc4a2e9185ec3ecdf6a2edf16450c94c7494bce36a427202",
  "mesh-node.mjs": "253261df6c7f25798b603aa6db386b7652ad3848dd42609285af6c199f200bc8",
});
export const sha256 = value => createHash("sha256").update(value).digest("hex");
const ordering = "    const ordered = [...eligible].sort((a, b) => coverage(b) - coverage(a) || uplink(b) - uplink(a) || scores.get(a.id) - scores.get(b.id) || a.id.localeCompare(b.id));";
const improvement = "(coverage(ordered[0]) > coverage(members.find(member => member.id === incumbent)) || scores.get(incumbent) - scores.get(best) >= this.improvement)";

function validateRanks(hostRanks) {
  if (!Array.isArray(hostRanks) || !hostRanks.length || hostRanks.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) || new Set(hostRanks).size !== hostRanks.length) {
    throw new Error("hostRanks must be a nonempty, duplicate-free array of valid physical hostId strings, best first");
  }
}
function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw new Error("Unexpected election source: patch anchor must occur exactly once");
  return source.replace(from, to);
}

export function deriveElection(source, { policy, hostRanks } = {}) {
  if (sha256(source) !== SOURCE_HASHES["mesh-election.mjs"]) throw new Error("Unrecognized mesh-election.mjs source hash; review the adapter before updating its pin");
  if (!["S", "Q"].includes(policy)) throw new Error("policy must be S or Q");
  if (policy === "Q") {
    if (hostRanks !== undefined) throw new Error("Q does not accept hostRanks");
    return source;
  }
  validateRanks(hostRanks);
  // Keep Q's measurements and scores for identical probing and diagnostic work.
  // Only preference ordering and its improvement predicate change. The membership,
  // eligibility, incumbent selection, majority, term and round logic remain shared.
  const replacement = `    const physicalRanks = new Map(${JSON.stringify(hostRanks)}.map((hostId, rank) => [hostId, rank]));
    for (const member of members) if (!physicalRanks.has(member.hostId)) throw new Error("Unranked physical hostId: " + member.hostId);
    const rank = member => physicalRanks.get(member.hostId);
    const ordered = [...eligible].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));`;
  return replaceOnce(replaceOnce(source, ordering, replacement), improvement,
    "(rank(ordered[0]) < rank(members.find(member => member.id === incumbent)))");
}

/** Target must be an already-created SDK copy. Return provenance for the run manifest. */
export async function adaptPolicy({ sourceSdkDir, targetSdkDir, policy, hostRanks }) {
  const sourceRoot = await realpath(sourceSdkDir), targetRoot = await realpath(targetSdkDir);
  const inside = (root, item) => item === root || item.startsWith(root + path.sep);
  if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) throw new Error("Target SDK must be isolated from the production SDK");
  const inputs = {};
  for (const [name, expected] of Object.entries(SOURCE_HASHES)) {
    const sourcePath = await realpath(path.join(sourceRoot, "src", name));
    const targetPath = await realpath(path.join(targetRoot, "src", name));
    if (!inside(sourceRoot, sourcePath) || !inside(targetRoot, targetPath) || sourcePath === targetPath) throw new Error("SDK source files must not escape their isolated directories");
    const source = await readFile(sourcePath, "utf8"), target = await readFile(targetPath, "utf8");
    if (sha256(source) !== expected) throw new Error(`Unrecognized ${name} source hash; review the adapter before updating its pin`);
    if (source !== target) throw new Error(`Target ${name} is not a pristine production copy`);
    inputs[name] = { source, targetPath };
  }
  const output = deriveElection(inputs["mesh-election.mjs"].source, { policy, hostRanks });
  // Atomic replacement also avoids changing a production file through a hard link.
  if (policy === "S") {
    const target = inputs["mesh-election.mjs"].targetPath;
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, output, { flag: "wx", mode: (await stat(target)).mode & 0o777 });
      await rename(temporary, target);
    } finally { await rm(temporary, { force: true }); }
  }
  return {
    schema: "kinopio-mesh-policy-adapter/v1", policy,
    hostRanks: policy === "S" ? [...hostRanks] : null,
    sourceHashes: { ...SOURCE_HASHES }, electionSha256: sha256(output),
    adapterSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    minimumTermMs: 45000, improvementRounds: 3,
    note: "Default timing only: runner must not override it. S uses physical host rank only; scores remain Q diagnostics. No result or multi-host validation is implied.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    const names = { "--source-sdk": "sourceSdkDir", "--target-sdk": "targetSdkDir", "--policy": "policy", "--host-ranks": "ranksPath" };
    for (let i = 0; i < args.length; i += 2) {
      const key = names[args[i]];
      if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Usage: mesh-policy-adapter.mjs --source-sdk DIR --target-sdk DIR --policy S|Q [--host-ranks FILE.json]");
      options[key] = args[i + 1];
    }
    if (!options.sourceSdkDir || !options.targetSdkDir || !options.policy) throw new Error("--source-sdk, --target-sdk and --policy are required");
    const hostRanks = options.ranksPath ? JSON.parse(await readFile(options.ranksPath, "utf8")) : undefined;
    console.log(JSON.stringify(await adaptPolicy({ ...options, hostRanks }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
