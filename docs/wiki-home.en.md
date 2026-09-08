# KinopioHub

Project versions, except Web, are unified at **3.0.0**, not yet released. Web is excluded from this version update and still depends on the 2.x SDK. Third-party dependencies keep their own versions.

[简体中文](wiki-home.md) · [GitHub](https://github.com/skyboooox/KinopioHub)

Share a current value across languages and devices through a familiar variable reference.

```js
const battery = hub.scope('devices').var('battery');
battery.watch(value => console.log(value));
await battery.set(80);
```

KinopioHub is a personally maintained cloud-variable project. SDKs keep values in memory and synchronize them with online devices through NATS Core. Node.js, Python and C++ can discover, elect and start a LAN node automatically; browsers and ESP32 connect as clients.

## Choose your platform

| Project | Use | Current status |
| --- | --- | --- |
| [JavaScript](javascript.md) | Node.js and browsers | v3 source rewrite |
| [Python](python.md) | asyncio applications | v3 source rewrite |
| [C++](cpp.md) | Native C++20 applications | v3 source rewrite |
| [ESP32 Arduino](arduino.md) | Embedded clients | v3 source rewrite |
| [ROS 2](ros.md) | YAML-selected topics and reverse controls | v3 source rewrite |
| [Web](web.md) | Subject debugging console | Still uses v2; migration pending |
| [Server](server.md) | Optional NATS wildcard policy | Customized upstream fork |

These v3 rewrites are unpublished. Use a local checkout containing the rewritten source; installing an existing public package does not obtain it. v3 is incompatible with the old API and wire protocol. Python live channels do not yet have equivalent JS, C++ or ESP32 APIs.

## Manual chapters and reading order

Start with your language's quick start and run two instances, then read variable semantics and connection modes. Use the API/configuration chapters while developing and troubleshooting when something fails.

1. [Variables and synchronization](variables.md): naming, JSON, reading/writing/watching, concurrent winners, deletion and offline lifetime.
2. [Connections, mesh and SDK status](networking.md): direct clients, automatic nodes, leaf upstreams, report fields and online observations.
3. Language manuals:

| SDK | Getting started | Reference |
| --- | --- | --- |
| JavaScript | [Quick start](javascript.md) | [API and configuration](javascript-api.md) |
| Python | [Quick start](python.md) | [API and configuration](python-api.md) |
| C++ | [Quick start](cpp.md) | [API and configuration](cpp-api.md) |
| ESP32 | [Quick start](arduino.md) | [API and configuration](arduino-api.md) |
| ROS 2 | [Quick start](ros.md) | [API and configuration](ros-config.md) |

4. [Troubleshooting and migration](troubleshooting.md): connections, TLS, capacity, callbacks and old versions.
5. [Server](server.md) and [Development](development.md): broker configuration, source builds, interoperability/device checks and Wiki maintenance.

Each chapter has a local table of contents and a matching translation. API fragments assume the Hub, imports and runtime described in that chapter; complete entry-point examples are in each language's quick start.

## Three things to know

- **Only current values are shared.** A running SDK can read and write while offline and merge after reconnecting. State disappears when all copies exit.
- **A write is not execution confirmation.** `set()` updates local memory; `flush()` confirms NATS transport. A device should report completion separately.
- **Automatic nodes target small LANs.** Partitions may run independently and converge to one node after communication recovers. Cross-network communication requires an actual connected NATS topology.

Read [How it works](architecture.md) for details and [Development](development.md) for repository maintenance and test commands.

## Feedback

Small, focused issues and improvements are welcome. Report SDK problems in that repository; use [KinopioHub Issues](https://github.com/skyboooox/KinopioHub/issues) for cross-language or documentation problems. Include versions, a minimal example and the actual result.
