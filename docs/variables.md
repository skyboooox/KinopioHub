# Variables and synchronization

[简体中文](variables.zh.md) · [Home](wiki-home.en.md) · [Networking](networking.md)

This chapter defines the behavior shared by the SDKs. Language-specific return types and scheduling rules are documented in each SDK reference.

In this chapter

- [1. Names and references](#chapter-1)
- [2. Values, absence and initial loading](#chapter-2)
- [3. Reading, writing and observing](#chapter-3)
- [4. Concurrent writes and deletion](#chapter-4)
- [5. Offline operation and lifetime](#chapter-5)
- [6. Desired state and commands](#chapter-6)

<a id="chapter-1"></a>
## 1. Names and references

A variable is identified by namespace and variable name. Both must match on communicating devices. The same name in another namespace is a different variable.

```js
const hub = new KinopioHub('workshop');
const battery = hub.var('battery');
```

Keep a reference and reuse it throughout the application. Creating it does not assign a value.

| Naming rule | Requirement |
| --- | --- |
| Length | 1–128 well-formed UTF-8 bytes |
| Excluded characters | U+0000–U+001F and U+007F |
| Comparison | Case-sensitive; no trimming or Unicode normalization |
| Slash | Literal content; `/battery` is a valid ROS variable name |

> **Sharing requires an explicit namespace.** Omission creates a new UUID for each Hub, so two default Hubs are isolated.

| Runtime | Read the namespace |
| --- | --- |
| JS / Python | `hub.namespace` |
| C++ / ESP32 | `hub.namespaceName()` |

The namespace stays unchanged for the Hub lifetime. Creating a variable reference never starts a new namespace.

State names are encoded byte by byte as two lowercase hexadecimal digits. Spaces, dots, `*` and `>` remain literal in set/get/watch operations. Message methods have separate [hierarchy and wildcard rules](messaging.md#chapter-2). For namespace `workshop` and variable `battery`:

| Traffic | NATS subject |
| --- | --- |
| Variable update | `776f726b73686f70.62617474657279` |
| Peer query | `_sys.v4.776f726b73686f70.sync` |
| Query reply | `_sys.v4.776f726b73686f70.inbox.<id>` |
| SDK report | `_sys.v4.776f726b73686f70.health.<instanceId>` |
| Python live | `_sys.v4.776f726b73686f70.live.…` |

Updates carry `{name, version: {counter, writer}, deleted, value?}`.

- The record keeps the original name; receivers check it against the encoded subject.
- Encoded data subjects cannot collide with control subjects.
- NATS permissions must cover data, queries, replies and health reports.

The [shared encoding vectors](../integration/fixtures/name-vectors.json) list accepted and rejected names.

Namespaces organize data, not permissions. Devices also need a connected NATS topology and compatible authentication. Do not use a namespace as a substitute for NATS account or subject permissions.

<a id="chapter-2"></a>
## 2. Values, absence and initial loading

| Data | Portable representation |
| --- | --- |
| JSON | Null, booleans, finite numbers, strings, arrays and objects |
| Integer-valued numbers | Within ±(2^53−1), even when the language supports larger integers |
| Larger identifiers | Strings |
| Dates and binary | Explicit application-defined JSON representation |

SDKs validate nesting, complexity and memory limits. A value accepted by a desktop SDK may still exceed the ESP32's smaller limits. Plan the shared schema around the smallest receiving device.

| State | JS | Python | C++ | ESP32 |
| --- | --- | --- | --- | --- |
| Present JSON null | `null` | `None` | Optional containing `Json(nullptr)` | `exists()` is true; JSON is null |
| No local value | `undefined` | `UNSET` | Empty optional | `exists()` is false |
| Initial lookup unfinished | `meta.exists === null` | `meta["exists"] is None` | `meta()["exists"]` is null | No equivalent tri-state metadata API |

| Runtime | Initial lookup |
| --- | --- |
| JS / Python / C++ | `variable.ready()` waits for a known local state, including known absence; check existence afterward. |
| ESP32 | Observe through `loop()` and callbacks; there is no variable `ready()` API. |

> **Ready does not mean present.** It also does not mean every possible peer has answered.

Do not implement initialization as an assumed atomic “read absent, then set.” Two devices can both see absence and write defaults. The normal conflict rule chooses the winner; there is no compare-and-set operation.

<a id="chapter-3"></a>
## 3. Reading, writing and observing

Reads return local copies. Keep the variable reference; call `set()` to publish a changed value.

**ESP32 ownership:** Stored snapshots own nested ArduinoJson strings, including strings linked to caller arrays. Reads return an owned `JsonDocument`. See [value ownership](arduino-api.md#chapter-3).

```js
const battery = hub.var('battery');
const stop = battery.watch((value, meta) => {
  if (meta.exists) console.log(value);
});
await battery.set(80);
// Call stop() when this view is no longer needed.
```

Watches expose initial state and subsequent changes according to the language's scheduling rules. Metadata changes, such as pending publication clearing or connection changes, can also notify a watcher. Treat it as a current-state view, not a durable event stream or a guarantee of exactly one callback per business action.

| Method | Behavior |
| --- | --- |
| `get(fallback)` | Local missing-value default; does not replace null/false/zero or start a network lookup |
| `watchValue(handler)` / Python `watch_value` | Value-only callback with the same watch timing |
| `pub/sub/req/handle` | Independent message operations; deleting state does not remove subscriptions |

Writes update local RAM. A successful write can occur while offline. Repeated writes of equal JSON still create new logical versions; transport deduplication only removes repetitions of the same version.

| Wait or operation | What success means |
| --- | --- |
| Hub `ready()` (JS/Python/C++) | Local SDK initialization completed |
| Variable `ready()` | This local view has an initialization result |
| Hub `connected()` (JS/Python/C++) | The SDK has an active NATS connection |
| `set()` / delete | The local current record was updated |
| Hub `flush()` | Current records were sent and NATS transport was confirmed |
| Application result variable | Whatever completion rule the application explicitly implements |

<a id="chapter-4"></a>
## 4. Concurrent writes and deletion

Each record carries `{counter, writer}`.

1. Compare `counter` numerically; it is encoded as a decimal string.
2. Higher counter wins; writer ID order breaks ties.
3. Receiving a record advances the local logical clock before later writes.

Wall-clock timestamps do not choose the winner.

**Merging selects a whole JSON value, not individual properties.**

| Data relationship | Model it as |
| --- | --- |
| Fields with independent writers | Separate variables |
| Fields that travel as one snapshot | One object; accept whole-value conflict resolution |

| After deletion | Result |
| --- | --- |
| RAM record | A versioned tombstone remains |
| Older peer value arrives | Cannot restore the deleted value |
| Later higher-version write | Can create the value again |
| Capacity | Tombstones still consume record slots; deletion does not reclaim all metadata |

There is no atomic operation spanning several variables. A reader can observe an intermediate state between two writes. Put inseparable fields in one value or define an application-level sequence identifier.

<a id="chapter-5"></a>
## 5. Offline operation and lifetime

1. A new Hub starts with empty memory and a new identity.
2. Online peers exchange their current records.
3. During a disconnect, a living SDK can keep reading and updating local RAM.
4. Reconnection merges retained current records with online peers.
5. Exiting the last process holding a record loses that record.

- **Only the current record is kept.** Several offline changes can collapse before publication; there is no operation log.
- **A broker is not a backup.** Restarting it never restores SDK data, and leaving it online does not retain values.
- **Living peers repair state.** Periodic synchronization repairs missed updates while copies remain alive.

<a id="chapter-6"></a>
## 6. Desired state and commands

Use variables for current measurements, configuration and desired state. A device should publish a separate reported value after applying a request. Include an application request ID when the requester needs to associate a result with an action.

Use [Python live channels](python-api.md#live) for expiring commands when supported by the receiver. Live sends are separate calls with no offline replay; they still do not prove execution. [ROS controls](ros-config.md#controls) add session checks for desired state and receiver leases for live commands.

Use [events and requests](messaging.md) for transient notifications and application replies. Do not use a current value as an event log or atomic counter. Neither current values nor Core NATS queue groups guarantee that every intermediate operation is processed.

Next: [connection modes and mesh](networking.md), then the API reference for [JS](javascript-api.md), [Python](python-api.md), [C++](cpp-api.md) or [ESP32](arduino-api.md).
