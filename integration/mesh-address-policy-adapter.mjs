/** Experiment-only address-ranked S adapter. Never import this file from a published SDK. */
import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat, writeFile, rename, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SOURCE_HASHES = Object.freeze({
  "mesh-election.mjs": "cd87500f8fd47daedc4a2e9185ec3ecdf6a2edf16450c94c7494bce36a427202",
  "mesh-node.mjs": "253261df6c7f25798b603aa6db386b7652ad3848dd42609285af6c199f200bc8",
});
export const sha256 = value => createHash("sha256").update(value).digest("hex");
const ORDERING = "    const ordered = [...eligible].sort((a, b) => coverage(b) - coverage(a) || uplink(b) - uplink(a) || scores.get(a.id) - scores.get(b.id) || a.id.localeCompare(b.id));";
const IMPROVEMENT = "(coverage(ordered[0]) > coverage(members.find(member => member.id === incumbent)) || scores.get(incumbent) - scores.get(best) >= this.improvement)";
const HEADER = "/** LAN elections converge after membership and measurements stabilize; votes are not a consensus quorum. */";

function replaceOnce(source, from, to) {
  if (source.split(from).length !== 2) throw Error("Unexpected election source: patch anchor must occur exactly once");
  return source.replace(from, to);
}

export function validateHostAddresses(input) {
  if (!Array.isArray(input) || input.length !== 3) throw Error("host addresses must contain exactly three hosts in best-first order");
  const ids = new Set(), addresses = new Set();
  return input.map((host, index) => {
    if (!host || typeof host !== "object" || typeof host.id !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(host.id) || ids.has(host.id)) throw Error(`host addresses[${index}].id must be a unique safe identifier`);
    if (!Array.isArray(host.addresses) || !host.addresses.length) throw Error(`host addresses[${index}].addresses must be nonempty`);
    ids.add(host.id);
    const normalized = host.addresses.map((address, addressIndex) => {
      if (typeof address !== "string" || net.isIP(address) !== 4) throw Error(`host addresses[${index}].addresses[${addressIndex}] must be an IPv4 address`);
      if (addresses.has(address)) throw Error(`address alias is ambiguous across hosts: ${address}`);
      addresses.add(address); return address;
    });
    return Object.freeze({ id: host.id, addresses: Object.freeze(normalized) });
  });
}

export function deriveAddressElection(source, rawHosts) {
  if (sha256(source) !== SOURCE_HASHES["mesh-election.mjs"]) throw Error("Unrecognized mesh-election.mjs source hash; review the address adapter before updating its pin");
  const hosts = validateHostAddresses(rawHosts).map(host => ({ id: host.id, addresses: [...host.addresses] }));
  const addressRanks = Object.fromEntries(hosts.flatMap((host, rank) => host.addresses.map(address => [address, rank])));
  const prefix = `import os from "node:os";\n\n${HEADER}\nconst physicalHosts = Object.freeze(${JSON.stringify(hosts)}.map(host => Object.freeze({ id: host.id, addresses: Object.freeze([...host.addresses]) })));\nconst physicalAddressRanks = Object.freeze(${JSON.stringify(addressRanks)});\nconst hasAddress = address => Object.prototype.hasOwnProperty.call(physicalAddressRanks, address);\nexport function resolveLocalPhysicalRank(interfaces) {\n  const local = new Set(Object.values(interfaces ?? {}).flat().filter(item => item?.family === "IPv4" && !item.internal).map(item => item.address));\n  const matches = physicalHosts.map((host, rank) => host.addresses.some(address => local.has(address)) ? rank : null).filter(rank => rank !== null);\n  if (matches.length !== 1) throw new Error("Local IPv4 interfaces match " + matches.length + " frozen physical hosts");\n  return matches[0];\n}\nconst localPhysicalRank = resolveLocalPhysicalRank(os.networkInterfaces());`;
  const ranking = `    const peerRank = member => {\n      if (typeof member.address !== "string" || !hasAddress(member.address)) throw new Error("Unknown physical peer address: " + member.address);\n      return physicalAddressRanks[member.address];\n    };\n    const rank = member => member.id === this.id ? localPhysicalRank : peerRank(member);\n    for (const member of members) rank(member);\n    const ordered = [...eligible].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));`;
  return replaceOnce(replaceOnce(replaceOnce(source, HEADER, prefix), ORDERING, ranking), IMPROVEMENT,
    "(rank(ordered[0]) < rank(members.find(member => member.id === incumbent)))");
}

/** Target must be a pristine isolated SDK copy. Only its mesh-election.mjs is replaced. */
export async function adaptAddressPolicy({ sourceSdkDir, targetSdkDir, hostAddresses }) {
  const sourceRoot = await realpath(sourceSdkDir), targetRoot = await realpath(targetSdkDir);
  const inside = (root, item) => item === root || item.startsWith(root + path.sep);
  if (inside(sourceRoot, targetRoot) || inside(targetRoot, sourceRoot)) throw Error("Target SDK must be isolated from the production SDK");
  const inputs = {};
  for (const [name, expected] of Object.entries(SOURCE_HASHES)) {
    const sourcePath = await realpath(path.join(sourceRoot, "src", name)), targetPath = await realpath(path.join(targetRoot, "src", name));
    if (!inside(sourceRoot, sourcePath) || !inside(targetRoot, targetPath) || sourcePath === targetPath) throw Error("SDK source files must not escape their isolated directories");
    const source = await readFile(sourcePath, "utf8"), target = await readFile(targetPath, "utf8");
    if (sha256(source) !== expected) throw Error(`Unrecognized ${name} source hash; review the address adapter before updating its pin`);
    if (source !== target) throw Error(`Target ${name} is not a pristine production copy`);
    inputs[name] = { source, targetPath };
  }
  const hosts = validateHostAddresses(hostAddresses), output = deriveAddressElection(inputs["mesh-election.mjs"].source, hosts);
  const target = inputs["mesh-election.mjs"].targetPath, temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, output, { flag: "wx", mode: (await stat(target)).mode & 0o777 });
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
  return {
    schema: "kinopio-mesh-address-policy-adapter/v1", policy: "S",
    hostAddresses: hosts.map(host => ({ id: host.id, addresses: [...host.addresses] })),
    addressRanks: Object.fromEntries(hosts.flatMap((host, rank) => host.addresses.map(address => [address, rank]))),
    sourceHashes: { ...SOURCE_HASHES }, electionSha256: sha256(output), adapterSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    minimumTermMs: 45000, improvementRounds: 3,
    note: "Experiment-only S ranks self by frozen local IPv4 aliases and peers by observed member.address. Q and production sources are unchanged.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    const names = { "--source-sdk": "sourceSdkDir", "--target-sdk": "targetSdkDir", "--host-addresses": "addressesPath" };
    for (let index = 0; index < args.length; index += 2) {
      const key = names[args[index]];
      if (!key || options[key] !== undefined || !args[index + 1] || args[index + 1].startsWith("--")) throw Error("Usage: mesh-address-policy-adapter.mjs --source-sdk DIR --target-sdk DIR --host-addresses FILE");
      options[key] = args[index + 1];
    }
    if (!options.sourceSdkDir || !options.targetSdkDir || !options.addressesPath) throw Error("--source-sdk, --target-sdk and --host-addresses are required");
    const hostAddresses = JSON.parse(await readFile(options.addressesPath, "utf8"));
    console.log(JSON.stringify(await adaptAddressPolicy({ ...options, hostAddresses }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
