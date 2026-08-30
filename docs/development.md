# Development workflow

## Requirements

The workspace manager requires Python 3, Git, and GitHub CLI. Individual repositories require their own toolchains such as Node.js/Bun, uv/Python, Go, CMake, PlatformIO, or ROS.

## Bootstrap

Run from the `KinopioHub` portal repository:

```bash
python3 scripts/workspace.py bootstrap
python3 scripts/workspace.py status
```

`bootstrap` is idempotent: existing Git repositories are verified and missing siblings are cloned. It also ensures that `Kinopio-server` has the official NATS repository configured as `upstream`.

Set `KINOPIO_WORKSPACE_ROOT` only when the sibling repositories live somewhere other than the portal's parent directory.

## Daily commands

```bash
python3 scripts/workspace.py list
python3 scripts/workspace.py status
python3 scripts/workspace.py fetch
python3 scripts/workspace.py pull
```

`pull` only fast-forwards clean repositories. It skips dirty worktrees and detached HEADs rather than overwriting work.

## Setup and test

Repository ids are `js`, `python`, `ros`, `web`, `arduino`, `cpp`, and `server`.

```bash
python3 scripts/workspace.py setup js
python3 scripts/workspace.py test js
python3 scripts/workspace.py test all
```

The `all` test set can be slow and requires every project toolchain. Use a repository id for normal development loops. Commands are defined declaratively in `repositories.json` and should stay aligned with each project's own development guide.

## NATS upstream synchronization

Workspace-wide `fetch` downloads both remotes for `Kinopio-server` but never merges them. Upstream synchronization remains an explicit workflow inside that fork:

```bash
git -C ../Kinopio-server fetch upstream
git -C ../Kinopio-server log --oneline --left-right origin/main...upstream/main
```

Do not automatically merge upstream from the portal tooling because downstream patches may require review and targeted regression tests.
