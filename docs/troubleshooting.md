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

1. Run two SDK processes, one small JSON value and one known reachable broker.
2. Use identical namespace and variable names; inspect both local statuses.
3. Once direct communication works, add discovery, automatic nodes or remote leaf links one at a time.

| Symptom | Check | Next action |
| --- | --- | --- |
| `set()` works but another device sees nothing | Connection, namespace, names and broker topology | Wait for connection, try `flush()`, inspect the receiving SDK's errors |
| `ready()` resolves but value is missing | Existence metadata | Known absence is a valid result; wait for an actual writer |
| Value disappears after restart | Whether any SDK copy survived | This is RAM-only behavior; restore from a surviving peer or initialize anew |
| Values stop at a large payload | Receiver limits and broker payload limit | Reduce the record or raise suitable limits on all receivers |
| Watch fires without a different JSON value | Version and metadata | Equal-value writes and metadata changes can notify |
| Several automatic nodes remain | Group, auth, upstream settings, multicast and direct probes | Make the domains equivalent and restore bidirectional reachability |
| Value arrived but `flush()` times out or pending stays nonzero | Transport errors, PING/PONG response and SDK loop progress | Keep processing the SDK loop; retain the error and verify a later flush rather than treating value arrival as confirmation |
| All devices show unknown | Observer connection | Reconnect the observer before judging remote availability |
| Node runs but remote values do not arrive | Actual leaf connection and permissions | Use a leaf listener; do not substitute a client port |

<a id="chapter-2"></a>
## 2. TLS and authentication

| Check | What matters |
| --- | --- |
| Certificate | Hostname, chain, dates and handshake mode |
| DNS name vs IP | A DNS certificate does not automatically validate an IP address |
| ESP32 clock | Establish valid UTC before TLS |
| ROS CA path | Resolved relative to YAML |
| ROS `--check-config` | Validates configuration, not server reachability |

Authentication success does not guarantee permission for all SDK exchanges. State updates, peer queries, replies and health traffic need appropriate NATS permissions. Diagnose the reported subject permission failure; do not broadly disable authorization to hide it.

For a browser, inspect the page scheme and WebSocket endpoint. An HTTPS page needs WSS; normal browser certificate trust applies. For C++, ESP32 and ROS, use TCP/TLS client endpoints rather than WSS URLs.

<a id="chapter-3"></a>
## 3. Timeouts and retries

A timeout bounds the wait; it does not necessarily roll back an earlier RAM write or unsend an already transmitted message. Inspect the value, version, connection and application feedback before deciding to retry.

Retrying `set()` creates another version even for equal JSON. Repeating a live send is another command. Applications needing business-level duplicate protection should carry their own request ID and result state.

Automatic startup can include binary download and election. Do not apply a short direct-connection timeout to this phase unintentionally. JS/C++ timeouts use milliseconds; Python uses seconds except names explicitly ending in `_ms`.

### Message failures

| Error or symptom | Next step |
| --- | --- |
| `NO_RESPONDERS` | Start a matching `handle` or reply-capable subscriber in the same namespace. |
| Request timeout | Check the responder and application outcome before retrying; execution may already have started. |
| `INVALID_TOPIC` | Publish/request a concrete name; only supported `sub`/`handle` operations accept patterns. |
| `SLOW_CONSUMER` | Shorten handlers or reduce input rate; inspect backlog and drops before changing limits. |
| `BUFFER_OVERFLOW` | Check request/collection and byte budgets; inspect bounded partial results when available. |
| `DISCONNECTED` / `DRAINING` | New messages require an active connection; they are not queued for replay. |
| `DRAIN_TIMEOUT` | Inspect work still in flight; shutdown has no device-execution guarantee. |

See [message semantics and limits](messaging.md#chapter-5).

<a id="chapter-4"></a>
## 4. Memory and callbacks

Record limits include deletion metadata. Creating an unbounded sequence of unique variable names eventually fills capacity; prefer a bounded set of references for current state. JSON data limits are not total process or firmware heap limits.

**Keep callbacks short.**

| Runtime | Callback rule |
| --- | --- |
| Python | State watches require synchronous callbacks; explicitly schedule bounded background work |
| C++ | Callbacks may run on worker threads; protect shared data |
| ESP32 | Call `loop()` frequently; long tasks, blocking waits and verbose serial output delay synchronization |

<a id="chapter-5"></a>
## 5. ROS routes and controls

For missing outbound data, verify the topic exists, the type package is installed and sourced, and QoS is compatible. `field` selects data from a ROS message; the YAML file itself is not transmitted as telemetry. Renaming a cloud variable does not rename the ROS topic.

| Rejected operation | Check |
| --- | --- |
| State control | Fresh `_bridge.control_session`, full typed `{session, value}` message and a matching ROS subscriber |
| Live control | Receiver presence, lease lifetime and queue pressure |

> **Execution evidence:** A successful NATS send does not prove ROS published or the robot acted.

One topic cannot appear in both outbound and control routes. Duplicate variables and collisions with the bridge-health variable are also rejected. These checks prevent ambiguous mappings and feedback loops.

<a id="chapter-6"></a>
## 6. Migrate from the old SDKs

**The current SDK uses state protocol 4 and business-message protocol 1.** Records from old SDKs or protocols using `scope` are incompatible.

1. Upgrade all SDKs together, including firmware, ROS's Python dependency and Web's JavaScript dependency.
2. Update NATS permissions for flat data, `_sys.v4` control, `_msg.v1` messages and native reply inbox subjects.
3. Stop old peers and initialize current RAM state from the application. There is no disk-data migration.

| Old assumption | Current approach |
| --- | --- |
| `getScope()` / `getVariable()` | `hub.var(name)` |
| `new KinopioHub({namespace, name})` | `new KinopioHub(namespace, options)`; status uses `instanceId` and `namespace` |
| `scope(s).var(v)` | Choose one flat name; explicitly use a prefix such as `s/v` when needed to avoid collisions |
| Omitted namespace shares default | Omission generates an isolated UUID; explicitly share a namespace |
| Separate leaf runtime or node CLI | Automatic nodes configured on the Hub |
| Persisted values or stable writer after restart | New empty RAM state and identity; recover only from online peers |
| `synced()` or an external state service | Local writes plus optional transport `flush()` |
| Request/reply used as live control | Use Python live or explicitly configured ROS controls |
| Web profiles using scope and raw subjects | Use the browser SDK with an explicit shared namespace and variable names; keep RAM state separate from events and requests |

<a id="chapter-7"></a>
## 7. Report a reproducible issue

| Include | Examples |
| --- | --- |
| Environment | SDK/runtime versions, OS, ESP32 board or ROS distribution |
| Connection | Direct, automatic LAN node or leaf upstream; sanitized configuration |
| Reproduction | Exact variable names and minimal program |
| Result | Expected behavior, actual status and errors |

Remove credentials and private endpoints. Report implementation issues in that SDK's repository and cross-language issues in [KinopioHub](https://github.com/skyboooox/KinopioHub/issues). Test commands are in [Development](development.md).
