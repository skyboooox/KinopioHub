# Connections, mesh and SDK status

[简体中文](networking.zh.md) · [Home](wiki-home.en.md) · [Troubleshooting](troubleshooting.md)

In this chapter

- [1. Choose a connection mode](#chapter-1)
- [2. Direct connection](#chapter-2)
- [3. Automatic LAN node lifecycle](#chapter-3)
- [4. Connect a LAN node to a remote system](#chapter-4)
- [5. Downloads, startup and shutdown](#chapter-5)
- [6. Read SDK status](#chapter-6)

<a id="chapter-1"></a>
## 1. Choose a connection mode

| Situation | Configuration | Who runs the broker? |
| --- | --- | --- |
| Small trusted LAN | Default Node/Python/C++ Hub | The elected SDK host |
| Existing NATS service | Explicit `servers`, disable mesh and discovery | Your NATS deployment |
| LAN with a remote NATS system | Automatic mesh with real leaf `upstreams` | Elected local host plus your upstream deployment |
| Browser or ESP32 | Reachable client endpoint or supported discovery | Another host; these SDKs never host a node |

One long-lived Hub per application is usually sufficient. Creating separate Hubs is useful when their namespace or connection domain differs; it is not necessary for each variable.

<a id="chapter-2"></a>
## 2. Direct connection

For JS and C++, option names use camelCase. Python uses snake_case. Timeout units are milliseconds in JS/C++ and seconds in Python.

```js
const hub = new KinopioHub('workshop', { servers: ['tls://nats.example.com:4222'],
  mesh: false,
  discovery: false,
  tls: { handshakeFirst: true },
});
await hub.connected();
```

`servers` is a list of **client** entry points. Alternatives should reach the same logical NATS system. Switching between unrelated brokers does not join them or make their clients exchange records.

| Connection detail | Check |
| --- | --- |
| TLS-first | TLS handshake before NATS INFO |
| INFO-then-TLS | Match the listener's different handshake mode |
| Credentials | Use `token` or user/password options, not credentials embedded in URLs |
| Custom CA / client certificate | Use the transport-specific SDK fields; do not copy another language's names |

| Runtime | Direct transport | Notes |
| --- | --- | --- |
| Node.js | TCP / TLS / WS / WSS | Custom TCP TLS and authenticators require client-only mode |
| Python | TCP / TLS / WS / WSS | Custom TLS requires client-only mode |
| C++ | TCP / TLS | Official nats.c transport |
| Browser | WS / WSS | HTTPS pages need trusted WSS |
| ESP32 | TCP / TLS | Supply CA PEM and valid UTC time |
| ROS | TCP / TLS | TLS YAML requires `ca_file`; explicit servers default to client-only |

<a id="chapter-3"></a>
## 3. Automatic LAN node lifecycle

1. Creating a Node/Python/C++ Hub enables automatic mode. An import alone starts nothing; Python requires a running asyncio loop.
2. Members discover peers over IPv4 multicast and probe reachability.
3. Election compares network quality and host load. Repeated checks and a minimum term reduce unnecessary handoffs.

| Ownership and scale | Behavior |
| --- | --- |
| Elected host | Starts a NATS Core child process; other SDKs use it |
| Same process | Compatible Hubs share a manager |
| Votes | Grouped by discovered host identity, derived from hostname and network interfaces |
| Interface visibility | Keep it consistent across processes |
| Candidate budget | At most 32 other candidates per manager; designed for small LANs |

| Network event | Expected behavior |
| --- | --- |
| Leader disappears | Reachable participants select a replacement |
| Partition | Each reachable group may remain available independently |
| Connectivity returns | Converge to one leader; temporary overlap is allowed |

Applications tolerate connection changes and use retained RAM state during recovery.

> **One domain requires equivalent settings:** group, authentication and upstreams determine the election domain. Namespace does not split a node. ESP32 discovery must match that domain even though the device never votes.

Managed LAN client listeners are plaintext and assume a trusted LAN. For explicit TLS policy, use your own broker in client-only mode. The SDK does not install certificates or change firewalls.

<a id="chapter-4"></a>
## 4. Connect a LAN node to a remote system

```js
const hub = new KinopioHub('workshop', {
  mesh: {
    group: 'workshop',
    upstreams: ['nats://nats.example.com:7422'],
  },
});
```

The upstream must expose a real NATS **leaf listener**. A normal client port is not interchangeable with a leaf port. TLS and WSS leaf modes also require matching upstream support. C++ can use WS/WSS here because the managed NATS executable handles the leaf connection.

| Runtime | Leaf TLS settings |
| --- | --- |
| JS / C++ | `mesh.upstreamTls` |
| Python | `mesh["upstream_tls"]` |

These configure the managed broker's leaf certificates and handshake, not the SDK's direct client TLS. Alternative upstreams must belong to one system and use a compatible transport mode.

The SDK verifies actual leaf connectivity before applying an upstream-connected local node; an open TCP socket alone is insufficient. If no usable path exists, inspect status and errors rather than assuming local and remote variables are synchronized. Listener examples are in the [Server chapter](server.md).

<a id="chapter-5"></a>
## 5. Downloads, startup and shutdown

The first elected startup may download a pinned NATS executable and verify its integrity. The local cache stores this executable only. It contains no variable history, current values or writer identity.

Use `mesh.binary` with an appropriate local executable when automatic download is unsuitable. Automatic connection waits in Node/Python/C++ default to 60 seconds unless overridden. An explicit short timeout can expire before download or election finishes.

`close()` releases SDK resources and its participation in the shared node manager. The SDK manages only processes it started; it does not terminate an externally managed NATS service. Closing the last SDK that holds a value still loses that value, regardless of the broker's lifetime.

Use [drain](messaging.md#chapter-5) when accepted messages and replies must finish before shutdown. Planned node handoffs retire old business interests before activating replacements; pending requests fail without automatic replay. Current variables still merge after reconnection.

<a id="chapter-6"></a>
## 6. Read SDK status

| Field group | Meaning |
| --- | --- |
| `instanceId`, `namespace`, `sdk`, `version`, `runtime` | Runtime instance identity; `instanceId` changes on restart |
| `connection`, `server`, `rttMs`, `reconnects` | SDK transport state and observed connection behavior |
| `variables`, `pendingVariables`, `pendingBytes` | Current record inventory and publication awaiting transport confirmation |
| `sentMessages`, `receivedMessages`, `sentBytes`, `receivedBytes` | SDK protocol traffic; not application-only traffic or network framing |
| `health`, `currentError`, `lastError` | Current assessment and error information |
| `mesh.role`, `leaderId`, `members`, `reason`, `upstreamConnected` | Automatic-node state when supported |
| `messaging` | Message phase, requests, backlog, active handlers and known drops; local status additionally includes limits |

Use local `status()` to inspect the observer itself. Reports are normally emitted **every five seconds**.

| Observation | Meaning |
| --- | --- |
| `online` | Report observed recently |
| `offline` | Report expired |
| `unknown` | Observer disconnected; cannot judge |
| `fresh`, `lastSeen` | Context for the observation |

Reports are not permanent device registration records.

| ESP32 view | Contents |
| --- | --- |
| Local message status | Backlog, active requests/handlers, drops and errors |
| Remote heartbeat | Identity, SDK/version, connection, health and any current error |
| Other instances | No subscription or cache; use JS/Python/C++ to build the online-device view |

- Remote **`messaging`** is smaller than local status; ESP32 omits it.
- Top-level **`pendingVariables` / `pendingBytes`** describe current-state transport; message backlog is separate.
- **Missing means unreported, not zero.** Unknown native or network loss cannot be read as zero loss.

A remote value can already be visible while its sender still awaits a transport confirmation. Read `pendingVariables` and error fields together; `connection: connected` alone is not evidence that every flush completed.

SDK health does not measure battery, temperature, robot controller readiness or completion of a command. Publish such business information as variables. A dashboard should show observer connection status alongside device reports so a disconnected dashboard does not imply every device is powered off.
