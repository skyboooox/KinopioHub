#!/usr/bin/env node
// Manage independent sibling repositories using Node.js built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const entryDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const commands = new Set(["list", "bootstrap", "status", "fetch", "pull", "validate", "setup", "test"]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isString = (value) => typeof value === "string" && value.length > 0;

export class WorkspaceError extends Error {}

export function validateManifest(manifest) {
  if (!isObject(manifest) || manifest.schemaVersion !== 1) {
    throw new WorkspaceError("repositories.json must use schemaVersion 1");
  }
  if (!isObject(manifest.workspace) || manifest.workspace.layout !== "siblings") {
    throw new WorkspaceError("workspace.layout must be 'siblings'");
  }
  if (manifest.workspace.root !== "..") throw new WorkspaceError("workspace.root must be '..'");
  if (!Array.isArray(manifest.repositories) || manifest.repositories.length === 0) {
    throw new WorkspaceError("repositories must be a non-empty list");
  }
  const ids = new Set();
  const paths = new Set();
  for (const [index, repo] of manifest.repositories.entries()) {
    if (!isObject(repo)) throw new WorkspaceError(`repositories[${index}] must be an object`);
    for (const key of ["id", "name", "repository", "path", "role", "visibility", "defaultBranch"]) {
      if (!isString(repo[key])) throw new WorkspaceError(`repositories[${index}].${key} must be a non-empty string`);
    }
    if (ids.has(repo.id)) throw new WorkspaceError(`duplicate repository id: ${repo.id}`);
    if (paths.has(repo.path)) throw new WorkspaceError(`duplicate repository path: ${repo.path}`);
    ids.add(repo.id);
    paths.add(repo.path);
    if (/[\\/:\0]/.test(repo.path) || [".", ".."].includes(repo.path)) {
      throw new WorkspaceError(`repository path must be one sibling directory name: ${repo.path}`);
    }
    if (!repositoryPattern.test(repo.repository)) throw new WorkspaceError(`invalid GitHub repository: ${repo.repository}`);
    if (!["public", "private"].includes(repo.visibility)) throw new WorkspaceError(`invalid visibility for ${repo.id}`);
    if (repo.upstream != null && (!isString(repo.upstream) || !repositoryPattern.test(repo.upstream))) {
      throw new WorkspaceError(`invalid upstream repository for ${repo.id}`);
    }
    const environment = repo.environment === undefined ? {} : repo.environment;
    if (!isObject(environment) || !Object.values(environment).every((value) => typeof value === "string")) {
      throw new WorkspaceError(`environment for ${repo.id} must contain string values`);
    }
    for (const action of ["setup", "test"]) {
      const steps = repo[action] === undefined ? [] : repo[action];
      if (!Array.isArray(steps)) throw new WorkspaceError(`${action} for ${repo.id} must be a list`);
      if (!steps.every((step) => Array.isArray(step) && step.length > 0 && step.every(isString))) {
        throw new WorkspaceError(`invalid ${action} command for ${repo.id}`);
      }
    }
  }
}

export function normalizeRemoteUrl(url) {
  return url.trim().replace(/\.git$/, "").replace(/^git@github\.com:/, "https://github.com/");
}

export function createWorkspace({
  entryRoot = entryDirectory,
  env = process.env,
  spawn = spawnSync,
  log = console.log,
  error = console.error,
} = {}) {
  const manifestPath = resolve(entryRoot, "repositories.json");

  function capture(command, cwd) {
    const result = spawn(command[0], command.slice(1), { cwd, env, encoding: "utf8", shell: false });
    if (result.error) throw new WorkspaceError(`cannot run ${command[0]}: ${result.error.message}`);
    return result;
  }

  function run(command, cwd, commandEnv = env) {
    // Quoting is for display only; execution always passes arguments without a shell.
    const display = command.map((arg) => /^[\w./:@=-]+$/.test(arg) ? arg : JSON.stringify(arg)).join(" ");
    log(`$ ${display}${cwd ? ` (in ${cwd})` : ""}`);
    const result = spawn(command[0], command.slice(1), { cwd, env: commandEnv, stdio: "inherit", shell: false });
    if (result.error) {
      error(`error: cannot run ${command[0]}: ${result.error.message}`);
      return result.error.code === "ENOENT" ? 127 : 1;
    }
    return result.status ?? 1;
  }

  function loadManifest() {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (cause) {
      throw new WorkspaceError(`Cannot read ${manifestPath}: ${cause.message}`);
    }
    validateManifest(manifest);
    return manifest;
  }

  function workspaceRoot(manifest) {
    const override = env.KINOPIO_WORKSPACE_ROOT;
    if (!override) return resolve(entryRoot, manifest.workspace.root);
    return resolve(override.replace(/^~(?=$|[/\\])/, () => homedir()));
  }

  function isGitRepository(path) {
    if (!existsSync(path) || !statSync(path).isDirectory()) return false;
    const result = capture(["git", "-C", path, "rev-parse", "--show-toplevel"]);
    return result.status === 0 && realpathSync(result.stdout.trim()) === realpathSync(path);
  }

  function requireCheckout(manifest, repo) {
    const path = resolve(workspaceRoot(manifest), repo.path);
    if (!isGitRepository(path)) throw new WorkspaceError(`${repo.name} is missing; run bootstrap first`);
    return path;
  }

  function ensureRemote(path, name, repository, create) {
    const result = capture(["git", "-C", path, "remote", "get-url", name]);
    const url = `https://github.com/${repository}.git`;
    if (result.status === 0) {
      if (normalizeRemoteUrl(result.stdout) === normalizeRemoteUrl(url)) return true;
      error(`error: ${basename(path)} remote ${name} is ${normalizeRemoteUrl(result.stdout)}, expected ${normalizeRemoteUrl(url)}`);
      return false;
    }
    if (create) return run(["git", "-C", path, "remote", "add", name, url]) === 0;
    error(`error: ${basename(path)} is missing remote ${name}`);
    return false;
  }

  function requireGh() {
    if (capture(["gh", "--version"]).status !== 0) throw new WorkspaceError("gh is required for this command");
  }

  function execute({ command, target = "all", remote = false, includePrivate = false }, manifest = loadManifest()) {
    let failed = false;
    if (command === "validate") {
      log(`Validated ${manifest.repositories.length} repository definitions.`);
      if (!remote) return 0;
      requireGh();
      const names = [];
      for (const repo of manifest.repositories) {
        if (repo.visibility === "private" && !includePrivate) log(`skip: ${repo.repository} is private`);
        else names.push(repo.repository);
      }
      names.push(...manifest.repositories.filter((repo) => repo.upstream).map((repo) => repo.upstream));
      for (const name of names) {
        if (run(["gh", "repo", "view", name, "--json", "name", "--jq", ".name"]) !== 0) failed = true;
      }
      return failed ? 1 : 0;
    }
    if (command === "list") {
      log(`Workspace root: ${workspaceRoot(manifest)}`);
      log(`${"ID".padEnd(10)} ${"PATH".padEnd(20)} ${"ACCESS".padEnd(9)} ${"STATE".padEnd(9)} ROLE`);
      for (const repo of manifest.repositories) {
        const state = isGitRepository(resolve(workspaceRoot(manifest), repo.path)) ? "ready" : "missing";
        log(`${repo.id.padEnd(10)} ${repo.path.padEnd(20)} ${repo.visibility.padEnd(9)} ${state.padEnd(9)} ${repo.role}`);
      }
      return 0;
    }
    if (command === "bootstrap") {
      requireGh();
      mkdirSync(workspaceRoot(manifest), { recursive: true });
      for (const repo of manifest.repositories) {
        const path = resolve(workspaceRoot(manifest), repo.path);
        if (existsSync(path)) {
          if (!isGitRepository(path)) {
            error(`error: ${path} exists but is not a Git repository`);
            failed = true;
            continue;
          }
          log(`ready: ${repo.name}`);
        } else if (run(["gh", "repo", "clone", repo.repository, path]) !== 0) {
          failed = true;
          continue;
        }
        if (!ensureRemote(path, "origin", repo.repository, false)) failed = true;
        if (repo.upstream && !ensureRemote(path, "upstream", repo.upstream, true)) failed = true;
      }
      return failed ? 1 : 0;
    }
    let repositories = manifest.repositories;
    if (["setup", "test"].includes(command) && target !== "all") {
      repositories = repositories.filter((repo) => [repo.id, repo.name, repo.path].includes(target));
      if (repositories.length === 0) {
        throw new WorkspaceError(`unknown repository '${target}'; choose one of: ${manifest.repositories.map((repo) => repo.id).join(", ")}, all`);
      }
    }
    for (const repo of repositories) {
      if (["setup", "test"].includes(command) && !(repo[command]?.length)) {
        log(`skip: ${repo.name} has no ${command} commands`);
        continue;
      }
      let path;
      try {
        path = requireCheckout(manifest, repo);
      } catch (cause) {
        if (command !== "status" || !(cause instanceof WorkspaceError)) throw cause;
        error(`error: ${cause.message}`);
        failed = true;
        continue;
      }
      if (command === "status") {
        log(`\n[${repo.name}]`);
        if (run(["git", "status", "--short", "--branch"], path) !== 0) failed = true;
      } else if (command === "fetch") {
        for (const name of repo.upstream ? ["origin", "upstream"] : ["origin"]) {
          if (run(["git", "fetch", "--prune", name], path) !== 0) failed = true;
        }
      } else if (command === "pull") {
        const dirty = capture(["git", "status", "--porcelain"], path);
        if (dirty.status !== 0 || dirty.stdout.trim()) {
          error(`skip: ${repo.name} has uncommitted changes`);
          failed = true;
          continue;
        }
        const branch = capture(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], path);
        if (branch.status !== 0) {
          error(`skip: ${repo.name} has a detached HEAD`);
          failed = true;
          continue;
        }
        if (run(["git", "pull", "--ff-only", "origin", branch.stdout.trim()], path) !== 0) failed = true;
      } else if (["setup", "test"].includes(command)) {
        log(`\n[${repo.name}: ${command}]`);
        for (const step of repo[command]) {
          const status = run(step, path, { ...env, ...repo.environment });
          if (status !== 0) {
            error(`error: ${repo.name} ${command} failed with exit code ${status}`);
            failed = true;
            break;
          }
        }
      } else {
        throw new WorkspaceError(`unsupported command: ${command}`);
      }
    }
    return failed ? 1 : 0;
  }

  return { loadManifest, workspaceRoot, isGitRepository, requireCheckout, execute };
}

export function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const [command, ...rest] = args;
  if (!commands.has(command)) throw new WorkspaceError(`choose a command: ${[...commands].join(", ")}`);
  const options = { command };
  if (command === "validate") {
    for (const flag of rest) {
      if (flag === "--remote") options.remote = true;
      else if (flag === "--include-private") options.includePrivate = true;
      else throw new WorkspaceError(`unknown option: ${flag}`);
    }
  } else if (["setup", "test"].includes(command)) {
    if (rest.length > 1 || rest[0]?.startsWith("-")) throw new WorkspaceError(`${command} accepts one repository id or all`);
    options.target = rest[0] ?? "all";
  } else if (rest.length) {
    throw new WorkspaceError(`${command} does not accept arguments`);
  }
  return options;
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log(`Usage: node scripts/workspace.mjs <command> [options]

  list                 List managed repositories and local checkout state
  bootstrap            Clone missing siblings using gh and verify remotes
  status               Show Git status for the managed repositories
  fetch                Fetch origin and any configured upstream
  pull                 Fast-forward clean repositories on attached branches
  validate             Validate repositories.json
    --remote           Also check GitHub repositories using gh
    --include-private  Include private repositories in remote validation
  setup [id|all]       Run manifest setup commands (default: all)
  test [id|all]        Run manifest test commands (default: all)

Set KINOPIO_WORKSPACE_ROOT to override the portal's parent directory.`);
      return 0;
    }
    return createWorkspace().execute(options);
  } catch (cause) {
    console.error(`error: ${cause.message}`);
    return 2;
  }
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
