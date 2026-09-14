# KinopioHub

[简体中文](wiki-home.md) · [GitHub](https://github.com/skyboooox/KinopioHub) · [Get started](javascript.md) · [API](javascript-api.md)

**Share variables, send events and request responses across languages and devices.**

One familiar reference: `hub.var(name)`. Built on NATS Core, with automatic LAN nodes and SDK status reports. Personally maintained.

```js
import KinopioHub from 'kinopio-hub';

const hub = new KinopioHub('workshop');
const battery = hub.var('battery');
battery.watch(value => console.log(value));
await battery.set(80);
```

> **Data lifetime:** Values live in SDK memory. Online peers synchronize them; after the last copy exits, the values are gone.

## Choose your platform

| Platform | Use | Start | Reference |
| --- | --- | --- | --- |
| JavaScript | Node.js and browsers | [Quick start](javascript.md) | [API](javascript-api.md) |
| Python | asyncio applications | [Quick start](python.md) | [API](python-api.md) |
| C++ | Native C++20 applications | [Quick start](cpp.md) | [API](cpp-api.md) |
| ESP32 | Arduino client | [Quick start](arduino.md) | [API](arduino-api.md) |
| ROS 2 | YAML-selected topics and controls | [Quick start](ros.md) | [Configuration](ros-config.md) |
| Web | Browser console | [Guide](web.md) | [Browser SDK](javascript-api.md) |
| Server | Optional NATS wildcard policy | [Guide](server.md) | [Topology](networking.md) |

## Manual chapters and reading order

**New here?** Follow your platform's quick start and run two instances with the same namespace. Then choose the chapter for your task:

| I want to… | Read |
| --- | --- |
| Read, write or watch a current value | [Variables and synchronization](variables.md) |
| Publish events, call a handler or collect replies | [Events and requests](messaging.md) |
| Connect devices, use mesh or observe SDK status | [Networking](networking.md) |
| Diagnose a failure or migrate an old client | [Troubleshooting and migration](troubleshooting.md) |
| Understand the design | [How it works](architecture.md) |
| Build, test, contribute or publish | [Development](development.md) |

Each guide has an English and Chinese version. Quick starts contain complete entry points; API snippets assume the imports and Hub described in their chapter.

## Three things to know

| Rule | What it means for your app |
| --- | --- |
| **RAM-only state** | A running SDK keeps its current values offline and merges on reconnect. Events and requests have no offline replay. |
| **Writing is not execution confirmation** | `set()` updates local memory; `flush()` confirms transport. Read an application result to confirm an action. |
| **Mesh serves small LANs** | Node.js, Python and C++ can host an elected node. Browsers and ESP32 are clients. Partitions can briefly have multiple nodes; remote networks require connected NATS topology. |

<details>
<summary>Protocol and feature compatibility</summary>

- Current-state protocol: **4**. Business-message protocol: **1**.
- Web uses the JavaScript browser SDK.
- Python live channels have no JS, C++ or ESP32 equivalent.
- Check the [message feature table](messaging.md) and your language reference before mixing runtimes.

</details>

## Feedback

Report implementation issues in the relevant SDK repository. Use [KinopioHub Issues](https://github.com/skyboooox/KinopioHub/issues) for documentation or cross-language problems. Include versions, a minimal example and the actual result.
