import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWorkspace, normalizeRemoteUrl, parseArgs, validateManifest, WorkspaceError } from "./workspace.mjs";

const repo = (id = "js", extra = {}) => ({
  id, name: `Project ${id}`, repository: `owner/${id}`, path: `project-${id}`,
  role: "SDK", visibility: "public", defaultBranch: "main", ...extra,
});
const manifest = (repositories = [repo()]) => ({
  schemaVersion: 1, workspace: { layout: "siblings", root: ".." }, repositories,
});
const success = { status: 0, stdout: "", stderr: "" };

function git(path, ...args) {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return result.stdout.trim();
}

function initRepository(path, commit = false) {
  mkdirSync(path, { recursive: true });
  git(path, "init", "--quiet", "--initial-branch=main");
  if (commit) {
    const hooks = join(path, ".git", "empty-hooks");
    mkdirSync(hooks);
    git(path, "-c", "user.name=Workspace Test", "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${hooks}`,
      "commit", "--quiet", "--allow-empty", "-m", "Initial test commit");
  }
}

function fixture(t, repositories = [repo()]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "kinopio workspace ")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initRepository(root);
  const portal = join(root, "portal");
  mkdirSync(portal);
  const data = manifest(repositories);
  writeFileSync(join(portal, "repositories.json"), JSON.stringify(data));
  const state = { root, portal, data, calls: [], output: [], intercept: () => undefined };
  state.manager = createWorkspace({
    entryRoot: portal,
    env: { ...process.env, KINOPIO_WORKSPACE_ROOT: "", FIXTURE_ENV: "inherited" },
    log: (line) => state.output.push(line),
    error: (line) => state.output.push(line),
    spawn(program, args, options) {
      state.calls.push({ program, args, options });
      const intercepted = state.intercept(program, args, options);
      if (intercepted !== undefined) return intercepted;
      if (program === "gh") {
        assert.deepEqual(args, ["--version"], "Unexpected GitHub request in local test");
        return success;
      }
      return spawnSync(program, args, { ...options, stdio: "pipe", encoding: "utf8" });
    },
  });
  return state;
}

test("manifest rejects malformed values, duplicate identities, and paths outside sibling roots", () => {
  validateManifest(manifest());
  for (const bad of [null, [], {}, { ...manifest(), repositories: [] }]) {
    assert.throws(() => validateManifest(bad), WorkspaceError);
  }
  for (const path of ["..", ".", "../escape", "/absolute", "x/y", "x\\y", "C:escape", "x\0y"]) {
    assert.throws(() => validateManifest(manifest([repo("js", { path })])), /sibling directory/);
  }
  for (const extra of [
    { environment: null }, { environment: { FLAG: true } }, { test: null },
    { setup: [[]] }, { test: [["node", 4]] }, { repository: "owner/repo/extra" },
    { visibility: "internal" }, { upstream: "invalid" },
  ]) assert.throws(() => validateManifest(manifest([repo("js", extra)])), WorkspaceError);
  assert.throws(() => validateManifest(manifest([repo(), repo()])), /duplicate repository id/);
  assert.throws(() => validateManifest(manifest([repo(), repo("py", { path: "project-js" })])), /duplicate repository path/);
});

test("ordinary directories inside an outer repository are rejected by bootstrap and project operations", (t) => {
  const f = fixture(t);
  const path = join(f.root, "project-js");
  mkdirSync(path);
  assert.equal(f.manager.isGitRepository(path), false);
  assert.equal(f.manager.isGitRepository(join(f.root, "missing")), false);
  assert.throws(() => f.manager.requireCheckout(f.data, f.data.repositories[0]), WorkspaceError);
  assert.equal(f.manager.execute({ command: "bootstrap" }), 1);
  assert.equal(f.manager.execute({ command: "status" }), 1);
  assert.equal(f.calls.some(({ args }) => args.includes("remote") || args.includes("clone")), false);
  assert.equal(git(f.root, "remote"), "");
});

test("nested repositories and linked worktrees are accepted, but their ordinary subdirectories are not", (t) => {
  const f = fixture(t);
  const path = join(f.root, "project-js");
  initRepository(path, true);
  assert.equal(f.manager.isGitRepository(path), true);
  const source = join(path, "src");
  mkdirSync(source);
  assert.equal(f.manager.isGitRepository(source), false);
  const linked = join(f.root, "linked");
  git(path, "worktree", "add", "--quiet", "--detach", linked);
  assert.equal(f.manager.isGitRepository(linked), true);
});

test("bootstrap clones through gh, adds upstream, and preserves dirty existing checkouts on repeat runs", (t) => {
  const f = fixture(t, [repo("js", { upstream: "upstream/js" })]);
  const source = join(f.root, "clone-source");
  initRepository(source, true);
  let clones = 0;
  f.intercept = (program, args) => {
    if (program !== "gh" || args[0] !== "repo") return undefined;
    assert.deepEqual(args.slice(0, 3), ["repo", "clone", "owner/js"]);
    const result = spawnSync("git", ["clone", "--quiet", source, args[3]], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    git(args[3], "remote", "set-url", "origin", "git@github.com:owner/js.git");
    clones += 1;
    return result;
  };
  assert.equal(f.manager.execute({ command: "bootstrap" }), 0);
  const path = join(f.root, "project-js");
  assert.equal(git(path, "remote", "get-url", "upstream"), "https://github.com/upstream/js.git");
  const note = join(path, "local-note.txt");
  writeFileSync(note, "keep local work");
  assert.equal(f.manager.execute({ command: "bootstrap" }), 0);
  assert.equal(clones, 1);
  assert.equal(readFileSync(note, "utf8"), "keep local work");
  assert.equal(f.manager.execute({ command: "list" }), 0);
  assert.match(f.output.join("\n"), /ready/);
});

test("bootstrap reports mismatched remotes without rewriting them", (t) => {
  const f = fixture(t);
  const path = join(f.root, "project-js");
  initRepository(path);
  git(path, "remote", "add", "origin", "https://github.com/other/project.git");
  assert.equal(f.manager.execute({ command: "bootstrap" }), 1);
  assert.equal(git(path, "remote", "get-url", "origin"), "https://github.com/other/project.git");
});

test("clone failures produce a nonzero result and do not skip remaining repositories", (t) => {
  const f = fixture(t, [repo(), repo("py")]);
  f.intercept = (program, args) => program === "gh" && args[1] === "clone"
    ? { ...success, status: 1 } : undefined;
  assert.equal(f.manager.execute({ command: "bootstrap" }), 1);
  assert.equal(f.calls.filter(({ args }) => args[1] === "clone").length, 2);
});

test("pull skips dirty and detached checkouts; clean branches use fast-forward only", (t) => {
  const f = fixture(t, [repo("dirty"), repo("detached"), repo("clean")]);
  for (const item of f.data.repositories) initRepository(join(f.root, item.path), true);
  writeFileSync(join(f.root, "project-dirty", "note.txt"), "keep");
  git(join(f.root, "project-detached"), "checkout", "--quiet", "--detach");
  f.intercept = (program, args) => program === "git" && args[0] === "pull" ? success : undefined;
  assert.equal(f.manager.execute({ command: "pull" }), 1);
  const pulls = f.calls.filter(({ args }) => args[0] === "pull");
  assert.equal(pulls.length, 1);
  assert.deepEqual(pulls[0].args, ["pull", "--ff-only", "origin", "main"]);
  assert.equal(pulls[0].options.cwd, join(f.root, "project-clean"));
});

test("fetch visits both remotes even if the first fails", (t) => {
  const f = fixture(t, [repo("js", { upstream: "upstream/js" })]);
  initRepository(join(f.root, "project-js"));
  f.intercept = (program, args) => program === "git" && args[0] === "fetch"
    ? { ...success, status: args[2] === "origin" ? 1 : 0 } : undefined;
  assert.equal(f.manager.execute({ command: "fetch" }), 1);
  assert.deepEqual(f.calls.filter(({ args }) => args[0] === "fetch").map(({ args }) => args), [
    ["fetch", "--prune", "origin"], ["fetch", "--prune", "upstream"],
  ]);
});

test("actions preserve argument boundaries and environment, and stop a failed project's remaining steps", (t) => {
  const f = fixture(t, [repo("js", {
    test: [["fixture-command", "fail", "literal $(not-a-shell)"], ["fixture-command", "skipped"]],
    environment: { FIXTURE_ENV: "overridden" },
  }), repo("py", { test: [["fixture-command", "next"]] })]);
  for (const item of f.data.repositories) initRepository(join(f.root, item.path));
  f.intercept = (program, args) => program === "fixture-command"
    ? { ...success, status: args[0] === "fail" ? 1 : 0 } : undefined;
  assert.equal(f.manager.execute({ command: "test" }), 1);
  const steps = f.calls.filter(({ program }) => program === "fixture-command");
  assert.deepEqual(steps.map(({ args }) => args), [["fail", "literal $(not-a-shell)"], ["next"]]);
  assert.equal(steps[0].options.env.FIXTURE_ENV, "overridden");
  assert.equal(steps[1].options.env.FIXTURE_ENV, "inherited");
  assert.equal(steps[0].options.shell, false);
  assert.equal(f.manager.execute({ command: "test", target: "Project py" }), 0);
  assert.equal(f.manager.execute({ command: "setup", target: "project-js" }), 0);
  assert.throws(() => f.manager.execute({ command: "test", target: "absent" }), /unknown repository/);
});

test("remote validation skips private projects unless requested and includes upstream", (t) => {
  const f = fixture(t, [repo("js", { upstream: "upstream/js" }), repo("private", { visibility: "private" })]);
  f.intercept = (program, args) => program === "gh" && args[1] === "view" ? success : undefined;
  assert.equal(f.manager.execute({ command: "validate", remote: true }), 0);
  const viewed = () => f.calls.filter(({ args }) => args[1] === "view").map(({ args }) => args[2]);
  assert.deepEqual(viewed(), ["owner/js", "upstream/js"]);
  f.calls.length = 0;
  assert.equal(f.manager.execute({ command: "validate", remote: true, includePrivate: true }), 0);
  assert.deepEqual(viewed(), ["owner/js", "owner/private", "upstream/js"]);
});

test("workspace root override and missing tools report predictable results", (t) => {
  const f = fixture(t);
  const override = createWorkspace({ entryRoot: f.portal, env: { KINOPIO_WORKSPACE_ROOT: f.root } });
  assert.equal(override.workspaceRoot(f.data), f.root);
  f.intercept = () => ({ error: Object.assign(new Error("tool unavailable"), { code: "ENOENT" }) });
  assert.throws(() => f.manager.execute({ command: "bootstrap" }), /cannot run gh/);
});

test("CLI options retain existing commands and reject unsupported arguments", () => {
  assert.deepEqual(parseArgs(["test"]), { command: "test", target: "all" });
  assert.deepEqual(parseArgs(["validate", "--remote", "--include-private"]), {
    command: "validate", remote: true, includePrivate: true,
  });
  for (const args of [[], ["unknown"], ["status", "extra"], ["test", "--bad"], ["validate", "--bad"]]) {
    assert.throws(() => parseArgs(args), WorkspaceError);
  }
  assert.equal(normalizeRemoteUrl("git@github.com:owner/repo.git\n"), "https://github.com/owner/repo");
});

test("CLI resolves the manifest relative to its script when invoked from another directory", (t) => {
  const f = fixture(t);
  const script = fileURLToPath(new URL("./workspace.mjs", import.meta.url));
  const invoke = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: f.root, encoding: "utf8" });
  const result = invoke("validate");
  assert.equal(result.status, 0, result.stderr);
  const count = JSON.parse(readFileSync(new URL("../repositories.json", import.meta.url), "utf8")).repositories.length;
  assert.equal(result.stdout.trim(), `Validated ${count} repository definitions.`);
  assert.equal(invoke("--help").status, 0);
  assert.equal(invoke("--bad").status, 2);
  const imported = spawnSync(process.execPath, ["--input-type=module", "-"], {
    cwd: f.root,
    input: `import ${JSON.stringify(new URL("./workspace.mjs", import.meta.url).href)};`,
    encoding: "utf8",
  });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, "");
});
