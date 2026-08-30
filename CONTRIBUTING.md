# Contributing

Use this repository for project-wide architecture, compatibility, workspace tooling, and cross-repository integration concerns. File implementation-specific issues and pull requests in the repository that owns that implementation.

Before changing `repositories.json`, run:

```bash
python3 scripts/workspace.py validate --remote
```

For protocol-visible changes, update `docs/compatibility.md` and link all affected implementation pull requests.
