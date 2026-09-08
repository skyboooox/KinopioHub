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
const hub = new KinopioHub({
  namespace: 'workshop',
  servers: ['tls://nats.example.com:4222'],
  mesh: false,
  discovery: false,
  tls: { handshakeFirst: true },
});
await hub.connected();
```

`servers` is a list of **client** entry points. Alternatives should reach the same logical NATS system. Switching between unrelated brokers does not join them or make their clients exchange records.

TLS-first means the TLS handshake occurs before NATS INFO. INFO-then-TLS is a different server setting: use the matching handshake option. Use `token` or user/password options rather than embedding credentials in URLs. Custom CA or client-certificate settings are transport-specific; consult the SDK reference instead of copying another language's field names.

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

Constructing a Node/Python/C++ Hub starts automatic mode; importing a package alone does not. Members discover one another over IPv4 multicast and probe reachability. Election takes network quality and host load into account, with repeated checks and a minimum term to reduce unnecessary handoffs.

The elected host starts an ordinary NATS Core child process. Other SDKs use that node. Compatible Hubs share a manager inside a process; a physical host contributes one vote. The domain is intended for small LANs and tracks at most 32 other candidates per manager.

When the leader disappears, reachable participants can select a replacement. During a partition, different reachable groups may each remain available. After connectivity returns, they converge to one leader; a temporary overlap is allowed. Applications must tolerate connection changes and use their retained RAM state during recovery.

The election domain depends on group, authentication and upstream settings. Namespace does not split the node. Devices expecting to share one node must use equivalent domain settings. An ESP32's discovery configuration must match that domain, even though it never votes.

Managed LAN client listeners are plaintext and assume a trusted LAN. For explicit TLS policy, use your own broker in client-only mode. The SDK does not install certificates or change firewalls.

<a id="chapter-4"></a>
## 4. Connect a LAN node to a remote system

```js
const hub = new KinopioHub({
  mesh: {
    group: 'workshop',
    upstreams: ['nats://nats.example.com:7422'],
  },
});
```

The upstream must expose a real NATS **leaf listener**. A normal client port is not interchangeable with a leaf port. TLS and WSS leaf modes also require matching upstream support. C++ can use WS/WSS here because the managed NATS executable handles the leaf connection.

Use `mesh.upstreamTls` in JS/C++, or `mesh["upstream_tls"]` in Python, for leaf certificates and handshake mode. Its settings belong to the managed broker's upstream connection, not the SDK's direct client TLS connection. Alternatives should belong to one upstream system and use a compatible transport mode.

The SDK verifies actual leaf connectivity before applying an upstream-connected local node; an open TCP socket alone is insufficient. If no usable path exists, inspect status and errors rather than assuming local and remote variables are synchronized. Listener examples are in the [Server chapter](server.md).

<a id="chapter-5"></a>
## 5. Downloads, startup and shutdown

The first elected startup may download a pinned NATS executable and verify its integrity. The local cache stores this executable only. It contains no variable history, current values or writer identity.

Use `mesh.binary` with an appropriate local executable when automatic download is unsuitable. Automatic connection waits in Node/Python/C++ default to 60 seconds unless overridden. An explicit short timeout can expire before download or election finishes.

`close()` releases SDK resources and its participation in the shared node manager. The SDK manages only processes it started; it does not terminate an externally managed NATS service. Closing the last SDK that holds a value still loses that value, regardless of the broker's lifetime.

<a id="chapter-6"></a>
## 6. Read SDK status

| Field group | Meaning |
| --- | --- |
| `instanceId`, `name`, `sdk`, `version`, `runtime` | Runtime instance identity; `instanceId` changes on restart |
| `connection`, `server`, `rttMs`, `reconnects` | SDK transport state and observed connection behavior |
| `variables`, `pendingVariables`, `pendingBytes` | Current record inventory and pending publication |
| `sentMessages`, `receivedMessages`, `sentBytes`, `receivedBytes` | SDK protocol traffic; not application-only traffic or network framing |
| `health`, `currentError`, `lastError` | Current assessment and error information |
| `mesh.role`, `leaderId`, `members`, `reason`, `upstreamConnected` | Automatic-node state when supported |

Use local `status()` to inspect the observer itself. Instance reports are normally emitted every five seconds. Remote `online` means recently observed, `offline` means expired, and `unknown` means the observer cannot currently judge because it is disconnected. `fresh` and `lastSeen` help interpret the observation; reports are not permanent device registration records.

SDK health does not measure battery, temperature, robot controller readiness or completion of a command. Publish such business information as variables. A dashboard should show observer connection status alongside device reports so a disconnected dashboard does not imply every device is powered off.
