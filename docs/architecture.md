# Architecture and repository boundaries

KinopioHub uses a polyrepo workspace. The repositories are developed together but keep independent Git histories, releases, package registries, and build systems.

The implementation lineage is asymmetric: `KinopioHub.JS` came first and is the historical reference for the language variants. A shared written specification may supersede implementation-defined behavior over time, but until then cross-language differences should be compared against the JavaScript behavior and documented explicitly.

## Boundaries

- `KinopioHub` owns project-wide navigation, architecture documents, compatibility policy, workspace automation, and cross-repository integration tests.
- `KinopioHub.JS` is the original implementation and the historical reference for common client behavior.
- Python, C++, Arduino, and ROS implementations were derived from the JavaScript implementation and should preserve equivalent behavior where their platforms allow it.
- SDK and application repositories own their implementation, unit tests, packaging, and release automation. `KinopioHub.web` is an accompanying application rather than another normative protocol implementation.
- `Kinopio-server` is a downstream fork of `nats-io/nats-server` with modified wildcard subscription logic. Its `origin` points to `skyboooox/Kinopio-server`; its `upstream` points to `nats-io/nats-server`.
- The outer `KinopioHub.dev` directory is a local container, not a Git repository and not a release artifact.

## Dependency direction

```text
      KinopioHub.JS
       │      │
       │      └──────────────► KinopioHub.web
       │
       ├──► KinopioHub.py
       ├──► KinopioHub.cpp
       ├──► KinopioHub.ino
       └──► KinopioHub.ROS

nats-io/nats-server
              │ downstream fork
              ▼
       Kinopio-server
       (wildcard subscription changes)
```

The portal does not vendor implementation source. Cross-repository tests check compatible released versions or explicitly selected commits.

Because the server fork changes subscription behavior, integration results must identify whether they ran against upstream NATS Server or `Kinopio-server`. Behavior that depends on the fork must not be presented as standard NATS behavior.

## Cross-repository changes

A change that affects more than one implementation should have:

1. A compatibility or protocol issue in this repository.
2. Separate implementation branches and pull requests in affected repositories.
3. A compatibility row that records the first compatible releases.
4. An integration test before the change is declared complete.

This preserves release independence while keeping protocol changes coordinated.
