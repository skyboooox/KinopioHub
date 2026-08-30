# KinopioHub

KinopioHub is the central entry point for the KinopioHub project family: multi-language SDKs and tools for scoped NATS messaging, plus a maintained NATS server fork.

[中文说明](README_CN.md)

## Projects

| Project | Role | Stack |
| --- | --- | --- |
| [KinopioHub.JS](https://github.com/skyboooox/KinopioHub.JS) | Browser and Node.js SDK | JavaScript |
| [KinopioHub.py](https://github.com/skyboooox/KinopioHub.py) | Python SDK and local leaf runtime | Python |
| [KinopioHub.ROS](https://github.com/skyboooox/KinopioHub.ROS) | ROS 1/2 topic and service bridge | Python / ROS |
| [KinopioHub.web](https://github.com/skyboooox/KinopioHub.web) | Browser debugger and operations console | TypeScript / Vite |
| [KinopioHub.ino](https://github.com/skyboooox/KinopioHub.ino) | ESP32 Arduino client | C++ / Arduino |
| [KinopioHub.cpp](https://github.com/skyboooox/KinopioHub.cpp) | Native C++20 SDK | C++ / CMake |
| [Kinopio-server](https://github.com/skyboooox/Kinopio-server) | Kinopio-maintained downstream fork of `nats-io/nats-server` | Go |

Each project remains an independent Git repository with its own releases and toolchain. This repository provides shared documentation, workspace automation, compatibility policy, and a home for future cross-repository integration tests.

## Workspace setup

The supported local layout uses sibling repositories:

```text
KinopioHub.dev/
├── KinopioHub/
├── KinopioHub.JS/
├── KinopioHub.py/
├── KinopioHub.ROS/
├── KinopioHub.web/
├── KinopioHub.ino/
├── KinopioHub.cpp/
└── Kinopio-server/
```

Create the workspace from an empty development directory:

```bash
gh repo clone skyboooox/KinopioHub KinopioHub
cd KinopioHub
python3 scripts/workspace.py bootstrap
```

If [`just`](https://just.systems/) is installed, the shorter commands are:

```bash
just bootstrap
just status
just fetch
just setup js
just test js
```

Open `KinopioHub.code-workspace` in VS Code to work with all repositories as separate source-control roots.

## Documentation

- [Architecture and repository boundaries](docs/architecture.md)
- [Development workflow](docs/development.md)
- [Compatibility policy](docs/compatibility.md)
- [Integration test home](integration/README.md)

## License

This portal repository is licensed under GPL-3.0-or-later. `Kinopio-server` remains separately licensed under Apache-2.0 as inherited from NATS Server; consult each repository for its authoritative license.
