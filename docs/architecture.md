# How it works

[简体中文](architecture.zh.md) · [Home](wiki-home.en.md)

In this chapter

- [A variable shared by online instances](#chapter-1)
- [Automatic LAN nodes](#chapter-2)
- [Existing servers and remote networks](#chapter-3)
- [SDK health and controls](#chapter-4)

<a id="chapter-1"></a>
## A variable shared by online instances

A variable is identified by `namespace + scope + name`. Use the same names and a connected NATS topology to exchange it across SDKs. A namespace separates data names; it is not an access-control boundary. Configure authentication and subject permissions in NATS.

Each Hub starts with empty memory and a new writer identity. It asks online peers for their current records and continues receiving updates. Without a peer, a bounded lookup establishes local absence and the application can write a new value.

| Event | Result |
| --- | --- |
| `set()` or delete | Update local RAM, even while disconnected |
| Reconnect | Merge retained current records with online peers |
| New device joins | Obtain values from an online copy, if one exists |
| Page reload, process restart or last copy exits | No local restoration; surviving online peers are the only recovery source |
| `flush()` succeeds | NATS transport completed, without proving peer receipt or device execution |

Records contain a logical counter and writer ID. The greater counter wins; ties use writer ID order. Writes do not use wall-clock time. The same version is deduplicated, but setting an equal value again creates a new version. Deletes retain a versioned tombstone in RAM, so an older copy cannot undo them. Periodic peer queries repair missed updates.

JSON null, zero and false are values. Unknown and absent are separate metadata states. Values must fit the receiving SDK's limits; integer-valued numbers must stay within ±(2^53−1). There is no history, disk persistence, cross-variable transaction or conditional update. A broker alone does not retain variables for a later SDK.

<a id="chapter-2"></a>
## Automatic LAN nodes

Creating a Node.js, Python or C++ Hub enables discovery and election by default. Importing the package alone starts nothing. Compatible participants compare reachability, latency, failure rate and host load, with a minimum term and repeated improvement checks to limit handoffs. The winner owns a plain NATS Core process and peers use its endpoint.

The election domain includes group, authentication and leaf upstream settings. Namespace does not create a separate node. Hubs in one process share a manager; each physical host contributes one vote. This targets small IPv4 LANs, with up to 32 other candidates per manager, multicast discovery and direct control probes. Firewalls and isolated multicast can prevent coordination.

Mutually reachable members eventually converge to one node. Partitions may elect separate nodes and briefly overlap after reconnecting. The SDK stops only its own processes. Managed LAN listeners use plaintext NATS/WS and assume a trusted LAN; the SDK does not install certificates or change firewall rules.

The first elected startup may download a version-pinned, integrity-checked NATS executable. Its cache contains the executable, not variable data. Supply `mesh.binary` for an existing compatible executable. `mesh: false` selects client-only operation. Browser and ESP32 instances never host or vote.

<a id="chapter-3"></a>
## Existing servers and remote networks

`servers` selects client endpoints. SDKs can probe alternatives and switch when network quality improves, with hysteresis. Endpoint selection does not connect otherwise separate NATS systems.

`mesh.upstreams` selects real **leaf-node endpoints** for the managed broker. Client and leaf ports are not interchangeable. Alternatives must belong to one upstream system and use a compatible transport mode. A TCP probe does not prove leaf authentication; the SDK checks actual leaf connectivity before applying an upstream-connected local node. See the [Server guide](server.md) for a minimal topology.

| Runtime | Direct client transport | Automatic node |
| --- | --- | --- |
| Node.js / Python | TCP, TLS, WS, WSS | Yes |
| Browser | WS, WSS | No |
| C++ | TCP, TLS | Yes; WS/WSS leaf upstreams run through NATS Server |
| ESP32 | TCP, TLS | No |
| ROS 2 | TCP, TLS | Inherits Python defaults; explicit servers default to client-only |

<a id="chapter-4"></a>
## SDK health and controls

SDKs normally report identity, uptime, connection, counters and errors every five seconds. Reports exclude business values and credentials. Instance `online` / `offline` means a report was observed recently / has expired; `unknown` means the observer is disconnected. This does not prove device power or application health. Reports are also memory-only.

Use variables for desired state and a separate reported value for the device's result. [Python live channels](python.md#live-channels) and [ROS controls](ros.md#controls) add expiring, non-replayed commands. Transport acknowledgment still does not mean an actuator completed an action.
