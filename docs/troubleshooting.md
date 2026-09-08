# Troubleshooting and migration

[简体中文](troubleshooting.zh.md) · [Home](wiki-home.en.md) · [Networking](networking.md)

In this chapter

- [1. Start with one connection](#chapter-1)
- [2. TLS and authentication](#chapter-2)
- [3. Timeouts and retries](#chapter-3)
- [4. Memory and callbacks](#chapter-4)
- [5. ROS routes and controls](#chapter-5)
- [6. Migrate from the old SDKs](#chapter-6)
- [7. Report a reproducible issue](#chapter-7)

<a id="chapter-1"></a>
## 1. Start with one connection

Reproduce with two SDK processes, one small JSON value, identical namespace/scope/name and one known reachable broker. Inspect each process's local status. Once direct communication works, add discovery, automatic nodes or remote leaf links one at a time.

| Symptom | Check | Next action |
| --- | --- | --- |
| `set()` works but another device sees nothing | Connection, namespace, names and broker topology | Wait for connection, try `flush()`, inspect the receiving SDK's errors |
| `ready()` resolves but value is missing | Existence metadata | Known absence is a valid result; wait for an actual writer |
| Value disappears after restart | Whether any SDK copy survived | This is RAM-only behavior; restore from a surviving peer or initialize anew |
| Values stop at a large payload | Receiver limits and broker payload limit | Reduce the record or raise suitable limits on all receivers |
| Watch fires without a different JSON value | Version and metadata | Equal-value writes and metadata changes can notify |
| Several automatic nodes remain | Group, auth, upstream settings, multicast and direct probes | Make the domains equivalent and restore bidirectional reachability |
| All devices show unknown | Observer connection | Reconnect the observer before judging remote availability |
| Node runs but remote values do not arrive | Actual leaf connection and permissions | Use a leaf listener; do not substitute a client port |

<a id="chapter-2"></a>
## 2. TLS and authentication

Check hostname, certificate chain, certificate dates and handshake mode. A certificate for a DNS name does not automatically validate an IP address. With ESP32, establish valid UTC time before attempting TLS. With ROS, CA paths resolve relative to the YAML file, and `--check-config` validates configuration rather than proving server reachability.

Authentication success does not guarantee permission for all SDK exchanges. State updates, peer queries, replies and health traffic need appropriate NATS permissions. Diagnose the reported subject permission failure; do not broadly disable authorization to hide it.

For a browser, inspect the page scheme and WebSocket endpoint. An HTTPS page needs WSS; normal browser certificate trust applies. For C++, ESP32 and ROS, use TCP/TLS client endpoints rather than WSS URLs.

<a id="chapter-3"></a>
## 3. Timeouts and retries

A timeout bounds the wait; it does not necessarily roll back an earlier RAM write or unsend an already transmitted message. Inspect the value, version, connection and application feedback before deciding to retry.

Retrying `set()` creates another version even for equal JSON. Repeating a live send is another command. Applications needing business-level duplicate protection should carry their own request ID and result state.

Automatic startup can include binary download and election. Do not apply a short direct-connection timeout to this phase unintentionally. JS/C++ timeouts use milliseconds; Python uses seconds except names explicitly ending in `_ms`.

<a id="chapter-4"></a>
## 4. Memory and callbacks

Record limits include deletion metadata. Creating an unbounded sequence of unique variable names eventually fills capacity; prefer a bounded set of references for current state. JSON data limits are not total process or firmware heap limits.

Keep callbacks short. Python watches require synchronous callbacks; schedule bounded background work explicitly. C++ callbacks can run on worker threads, so protect shared application data. ESP32 network progress depends on frequent `loop()` calls; long work, blocking waits and verbose serial output can delay synchronization.

<a id="chapter-5"></a>
## 5. ROS routes and controls

For missing outbound data, verify the topic exists, the type package is installed and sourced, and QoS is compatible. `field` selects data from a ROS message; the YAML file itself is not transmitted as telemetry. Renaming a cloud variable does not rename the ROS topic.

For rejected state control, obtain a fresh `_bridge.control_session`, send the complete typed message inside `{session, value}`, and ensure a matching ROS subscriber exists. For live control, verify receiver presence, lease lifetime and queue pressure. A successful NATS send alone is not evidence that ROS published or the robot acted.

One topic cannot appear in both outbound and control routes. Duplicate variables and collisions with the bridge-health variable are also rejected. These checks prevent ambiguous mappings and feedback loops.

<a id="chapter-6"></a>
## 6. Migrate from the old SDKs

The 3.0.0 rewrite changes the API and wire protocol. Install the rewritten source while packages are unpublished. Do not mix v2 and v3 and expect cloud variables to synchronize.

| Old assumption | Current approach |
| --- | --- |
| `getScope()` / `getVariable()` | `scope().var()` and the language's current reference API |
| Separate leaf runtime or node CLI | Automatic nodes configured on the Hub |
| Persisted values or stable writer after restart | New empty RAM state and identity; recover only from online peers |
| `synced()` or an external state service | Local writes plus optional transport `flush()` |
| Request/reply means v3 live control | Use Python live or explicitly configured ROS controls |
| Web already understands the rewrite | Web migration is still pending |

<a id="chapter-7"></a>
## 7. Report a reproducible issue

Include SDK and runtime versions, OS or ESP32 board, ROS distribution when applicable, connection mode, sanitized configuration, exact variable names, a minimal program, expected result and actual status/error. Say whether the problem appears with direct connection, automatic LAN nodes or a leaf upstream.

Remove credentials and private endpoints. Report implementation issues in that SDK's repository and cross-language issues in [KinopioHub](https://github.com/skyboooox/KinopioHub/issues). Test commands are in [Development](development.md).
