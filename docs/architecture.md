# Architecture and repository boundaries

KinopioHub uses a polyrepo workspace. The repositories are developed together but keep independent Git histories, releases, package registries, and build systems.

## Boundaries

- `KinopioHub` owns project-wide navigation, architecture documents, compatibility policy, workspace automation, and cross-repository integration tests.
- SDK and application repositories own their implementation, unit tests, packaging, and release automation.
- `Kinopio-server` is a downstream fork of `nats-io/nats-server`. Its `origin` points to `skyboooox/Kinopio-server`; its `upstream` points to `nats-io/nats-server`.
- The outer `KinopioHub.dev` directory is a local container, not a Git repository and not a release artifact.

## Dependency direction

```text
shared protocol and compatibility policy
          │
          ├── JavaScript SDK ── Web console
          ├── Python SDK
          ├── C++ SDK
          ├── Arduino SDK
          └── ROS bridge

NATS Server upstream ── Kinopio-server downstream fork
```

The portal does not vendor implementation source. Cross-repository tests check compatible released versions or explicitly selected commits.

## Cross-repository changes

A change that affects more than one implementation should have:

1. A compatibility or protocol issue in this repository.
2. Separate implementation branches and pull requests in affected repositories.
3. A compatibility row that records the first compatible releases.
4. An integration test before the change is declared complete.

This preserves release independence while keeping protocol changes coordinated.
