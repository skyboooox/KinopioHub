#!/usr/bin/env python3
"""Manage the sibling repositories in a KinopioHub development workspace."""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

ENTRY_ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ENTRY_ROOT / "repositories.json"
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class WorkspaceError(RuntimeError):
    """A user-facing workspace configuration or state error."""


def load_manifest() -> dict[str, Any]:
    try:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise WorkspaceError(f"Cannot read {MANIFEST_PATH}: {exc}") from exc
    validate_manifest(manifest)
    return manifest


def validate_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schemaVersion") != 1:
        raise WorkspaceError("repositories.json must use schemaVersion 1")
    workspace = manifest.get("workspace")
    if not isinstance(workspace, dict) or workspace.get("layout") != "siblings":
        raise WorkspaceError("workspace.layout must be 'siblings'")
    if workspace.get("root") != "..":
        raise WorkspaceError("workspace.root must be '..'")

    repositories = manifest.get("repositories")
    if not isinstance(repositories, list) or not repositories:
        raise WorkspaceError("repositories must be a non-empty list")

    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    for index, repository in enumerate(repositories):
        if not isinstance(repository, dict):
            raise WorkspaceError(f"repositories[{index}] must be an object")
        for key in ("id", "name", "repository", "path", "role", "defaultBranch"):
            if not isinstance(repository.get(key), str) or not repository[key]:
                raise WorkspaceError(f"repositories[{index}].{key} must be a non-empty string")
        identifier = repository["id"]
        path = repository["path"]
        if identifier in seen_ids:
            raise WorkspaceError(f"duplicate repository id: {identifier}")
        if path in seen_paths:
            raise WorkspaceError(f"duplicate repository path: {path}")
        seen_ids.add(identifier)
        seen_paths.add(path)
        if Path(path).is_absolute() or len(Path(path).parts) != 1 or path in (".", ".."):
            raise WorkspaceError(f"repository path must be one sibling directory name: {path}")
        if not REPOSITORY_PATTERN.fullmatch(repository["repository"]):
            raise WorkspaceError(f"invalid GitHub repository: {repository['repository']}")
        upstream = repository.get("upstream")
        if upstream is not None and (
            not isinstance(upstream, str) or not REPOSITORY_PATTERN.fullmatch(upstream)
        ):
            raise WorkspaceError(f"invalid upstream repository for {identifier}")
        environment = repository.get("environment", {})
        if not isinstance(environment, dict) or not all(
            isinstance(key, str) and isinstance(value, str)
            for key, value in environment.items()
        ):
            raise WorkspaceError(f"environment for {identifier} must contain string values")
        for action in ("setup", "test"):
            commands = repository.get(action, [])
            if not isinstance(commands, list):
                raise WorkspaceError(f"{action} for {identifier} must be a list")
            for command in commands:
                if not isinstance(command, list) or not command or not all(
                    isinstance(argument, str) and argument for argument in command
                ):
                    raise WorkspaceError(f"invalid {action} command for {identifier}")


def workspace_root(manifest: dict[str, Any]) -> Path:
    override = os.environ.get("KINOPIO_WORKSPACE_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    return (ENTRY_ROOT / manifest["workspace"]["root"]).resolve()


def repository_path(manifest: dict[str, Any], repository: dict[str, Any]) -> Path:
    return workspace_root(manifest) / repository["path"]


def run(command: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> int:
    location = f" (in {cwd})" if cwd else ""
    print(f"$ {shlex.join(command)}{location}", flush=True)
    try:
        completed = subprocess.run(command, cwd=cwd, env=env, check=False)
    except FileNotFoundError:
        print(f"error: command not found: {command[0]}", file=sys.stderr)
        return 127
    return completed.returncode


def capture(command: list[str], *, cwd: Path | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, cwd=cwd, text=True, capture_output=True, check=False)


def is_git_repository(path: Path) -> bool:
    if not path.is_dir():
        return False
    result = capture(["git", "-C", str(path), "rev-parse", "--is-inside-work-tree"])
    return result.returncode == 0 and result.stdout.strip() == "true"


def select_repositories(manifest: dict[str, Any], target: str) -> list[dict[str, Any]]:
    repositories = manifest["repositories"]
    if target == "all":
        return repositories
    matches = [
        repository
        for repository in repositories
        if target in (repository["id"], repository["name"], repository["path"])
    ]
    if not matches:
        available = ", ".join(repository["id"] for repository in repositories)
        raise WorkspaceError(f"unknown repository '{target}'; choose one of: {available}, all")
    return matches


def expected_https_url(repository_name: str) -> str:
    return f"https://github.com/{repository_name}.git"


def normalize_remote_url(url: str) -> str:
    normalized = url.strip()
    if normalized.endswith(".git"):
        normalized = normalized[:-4]
    if normalized.startswith("git@github.com:"):
        normalized = "https://github.com/" + normalized[len("git@github.com:") :]
    return normalized


def ensure_remote(path: Path, name: str, repository_name: str, *, create: bool) -> bool:
    result = capture(["git", "-C", str(path), "remote", "get-url", name])
    expected = normalize_remote_url(expected_https_url(repository_name))
    if result.returncode == 0:
        actual = normalize_remote_url(result.stdout)
        if actual != expected:
            print(f"error: {path.name} remote {name} is {actual}, expected {expected}", file=sys.stderr)
            return False
        return True
    if not create:
        print(f"error: {path.name} is missing remote {name}", file=sys.stderr)
        return False
    return run(
        ["git", "-C", str(path), "remote", "add", name, expected_https_url(repository_name)]
    ) == 0


def command_validate(manifest: dict[str, Any], *, remote: bool) -> int:
    print(f"Validated {len(manifest['repositories'])} repository definitions.")
    if not remote:
        return 0
    if shutil.which("gh") is None:
        raise WorkspaceError("gh is required for remote validation")
    failed = False
    remote_names = [repository["repository"] for repository in manifest["repositories"]]
    remote_names.extend(
        repository["upstream"]
        for repository in manifest["repositories"]
        if repository.get("upstream")
    )
    for repository_name in remote_names:
        result = run(["gh", "repo", "view", repository_name, "--json", "name", "--jq", ".name"])
        failed = failed or result != 0
    return 1 if failed else 0


def command_list(manifest: dict[str, Any]) -> int:
    print(f"Workspace root: {workspace_root(manifest)}")
    print(f"{'ID':<10} {'PATH':<20} {'STATE':<9} ROLE")
    for repository in manifest["repositories"]:
        path = repository_path(manifest, repository)
        state = "ready" if is_git_repository(path) else "missing"
        print(f"{repository['id']:<10} {repository['path']:<20} {state:<9} {repository['role']}")
    return 0


def command_bootstrap(manifest: dict[str, Any]) -> int:
    if shutil.which("gh") is None:
        raise WorkspaceError("gh is required to bootstrap the workspace")
    root = workspace_root(manifest)
    root.mkdir(parents=True, exist_ok=True)
    failed = False
    for repository in manifest["repositories"]:
        path = repository_path(manifest, repository)
        if path.exists():
            if not is_git_repository(path):
                print(f"error: {path} exists but is not a Git repository", file=sys.stderr)
                failed = True
                continue
            print(f"ready: {repository['name']}")
        else:
            result = run(["gh", "repo", "clone", repository["repository"], str(path)])
            if result != 0:
                failed = True
                continue
        failed = not ensure_remote(path, "origin", repository["repository"], create=False) or failed
        if repository.get("upstream"):
            failed = not ensure_remote(path, "upstream", repository["upstream"], create=True) or failed
    return 1 if failed else 0


def require_checkout(manifest: dict[str, Any], repository: dict[str, Any]) -> Path:
    path = repository_path(manifest, repository)
    if not is_git_repository(path):
        raise WorkspaceError(f"{repository['name']} is missing; run bootstrap first")
    return path


def command_status(manifest: dict[str, Any]) -> int:
    failed = False
    for repository in manifest["repositories"]:
        print(f"\n[{repository['name']}]")
        try:
            path = require_checkout(manifest, repository)
        except WorkspaceError as exc:
            print(f"error: {exc}", file=sys.stderr)
            failed = True
            continue
        failed = run(["git", "status", "--short", "--branch"], cwd=path) != 0 or failed
    return 1 if failed else 0


def command_fetch(manifest: dict[str, Any]) -> int:
    failed = False
    for repository in manifest["repositories"]:
        path = require_checkout(manifest, repository)
        remotes = ["origin"]
        if repository.get("upstream"):
            remotes.append("upstream")
        for remote in remotes:
            failed = run(["git", "fetch", "--prune", remote], cwd=path) != 0 or failed
    return 1 if failed else 0


def command_pull(manifest: dict[str, Any]) -> int:
    failed = False
    for repository in manifest["repositories"]:
        path = require_checkout(manifest, repository)
        dirty = capture(["git", "status", "--porcelain"], cwd=path)
        if dirty.returncode != 0 or dirty.stdout.strip():
            print(f"skip: {repository['name']} has uncommitted changes", file=sys.stderr)
            failed = True
            continue
        branch = capture(["git", "symbolic-ref", "--quiet", "--short", "HEAD"], cwd=path)
        if branch.returncode != 0:
            print(f"skip: {repository['name']} has a detached HEAD", file=sys.stderr)
            failed = True
            continue
        failed = run(["git", "pull", "--ff-only", "origin", branch.stdout.strip()], cwd=path) != 0 or failed
    return 1 if failed else 0


def command_action(manifest: dict[str, Any], action: str, target: str) -> int:
    failed = False
    for repository in select_repositories(manifest, target):
        commands = repository.get(action, [])
        if not commands:
            print(f"skip: {repository['name']} has no {action} commands")
            continue
        path = require_checkout(manifest, repository)
        environment = os.environ.copy()
        environment.update(repository.get("environment", {}))
        print(f"\n[{repository['name']}: {action}]", flush=True)
        for command in commands:
            result = run(command, cwd=path, env=environment)
            if result != 0:
                failed = True
                print(f"error: {repository['name']} {action} failed with exit code {result}", file=sys.stderr)
                break
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("list", help="list managed repositories and their local state")
    subparsers.add_parser("bootstrap", help="clone missing sibling repositories")
    subparsers.add_parser("status", help="show Git status for every repository")
    subparsers.add_parser("fetch", help="fetch and prune configured remotes")
    subparsers.add_parser("pull", help="fast-forward clean repositories from origin")
    validate = subparsers.add_parser("validate", help="validate the repository manifest")
    validate.add_argument("--remote", action="store_true", help="also verify GitHub repositories")
    for action in ("setup", "test"):
        action_parser = subparsers.add_parser(action, help=f"run {action} commands")
        action_parser.add_argument("target", nargs="?", default="all", help="repository id or all")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        manifest = load_manifest()
        if args.command == "validate":
            return command_validate(manifest, remote=args.remote)
        if args.command == "list":
            return command_list(manifest)
        if args.command == "bootstrap":
            return command_bootstrap(manifest)
        if args.command == "status":
            return command_status(manifest)
        if args.command == "fetch":
            return command_fetch(manifest)
        if args.command == "pull":
            return command_pull(manifest)
        if args.command in ("setup", "test"):
            return command_action(manifest, args.command, args.target)
        raise WorkspaceError(f"unsupported command: {args.command}")
    except WorkspaceError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
