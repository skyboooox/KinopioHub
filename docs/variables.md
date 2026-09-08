# Variables and synchronization

[简体中文](variables.zh.md) · [Home](wiki-home.en.md) · [Networking](networking.md)

This chapter defines the behavior shared by the 3.0.0 SDKs. Language-specific return types and scheduling rules are documented in each SDK reference.

In this chapter

- [1. Names and references](#chapter-1)
- [2. Values, absence and initial loading](#chapter-2)
- [3. Reading, writing and observing](#chapter-3)
- [4. Concurrent writes and deletion](#chapter-4)
- [5. Offline operation and lifetime](#chapter-5)
- [6. Desired state and commands](#chapter-6)

<a id="chapter-1"></a>
## 1. Names and references

A variable has three names: namespace, scope and variable name. All three must match on communicating devices. The same name in another namespace is a different variable.

```js
const hub = new KinopioHub({ namespace: 'workshop' });
const battery = hub.scope('devices').var('battery');
```

Use a scope for a device or a related group of values. A reference can be retained and reused throughout the application; creating a reference does not assign a value. Names accept 1–128 UTF-8 bytes without control characters. A slash in a variable name is part of that name, which is why a ROS variable such as `/battery` is valid.

Namespaces organize data, not permissions. Devices also need a connected NATS topology and compatible authentication. Do not use a namespace as a substitute for NATS account or subject permissions.

<a id="chapter-2"></a>
## 2. Values, absence and initial loading

Values use the portable JSON subset: null, booleans, finite numbers, strings, arrays and objects. Integer-valued numbers must fit ±(2^53−1), even in languages with larger native integers. Encode large identifiers as strings. Convert dates and binary data explicitly into an application-defined JSON representation.

SDKs validate nesting, complexity and memory limits. A value accepted by a desktop SDK may still exceed the ESP32's smaller limits. Plan the shared schema around the smallest receiving device.

| State | JS | Python | C++ | ESP32 |
| --- | --- | --- | --- | --- |
| Present JSON null | `null` | `None` | Optional containing `Json(nullptr)` | `exists()` is true; JSON is null |
| No local value | `undefined` | `UNSET` | Empty optional | `exists()` is false |
| Initial lookup unfinished | `meta.exists === null` | `meta["exists"] is None` | `meta()["exists"]` is null | No equivalent tri-state metadata API |

In JS, Python and C++, `variable.ready()` waits until the local state is known, including known absence. It does not promise that a value exists or that every possible peer has answered. Inspect existence after waiting. ESP32 applications observe values through `loop()` and callbacks; there is no variable `ready()` API.

Do not implement initialization as an assumed atomic “read absent, then set.” Two devices can both see absence and write defaults. The normal conflict rule chooses the winner; there is no compare-and-set operation.

<a id="chapter-3"></a>
## 3. Reading, writing and observing

Reading returns a local snapshot. Mutating the returned object does not publish it: call `set()` with the changed value. Keeping the reference avoids repeatedly rebuilding application wiring.

```js
const battery = hub.scope('devices').var('battery');
const stop = battery.watch((value, meta) => {
  if (meta.exists) console.log(value);
});
await battery.set(80);
// Call stop() when this view is no longer needed.
```

Watches expose initial state and subsequent changes according to the language's scheduling rules. Metadata changes, such as pending publication clearing or connection changes, can also notify a watcher. Treat it as a current-state view, not a durable event stream or a guarantee of exactly one callback per business action.

Writes update local RAM. A successful write can occur while offline. Repeated writes of equal JSON still create new logical versions; transport deduplication only removes repetitions of the same version.

| Wait or operation | What success means |
| --- | --- |
| Hub `ready()` | Local SDK initialization completed |
| Variable `ready()` | This local view has an initialization result |
| Hub `connected()` | The SDK has an active NATS connection |
| `set()` / delete | The local current record was updated |
| Hub `flush()` | Current records were sent and NATS transport was confirmed |
| Application result variable | Whatever completion rule the application explicitly implements |

<a id="chapter-4"></a>
## 4. Concurrent writes and deletion

Each record carries `{counter, writer}`. The counter is a decimal string and is compared numerically. Higher counters win; writer ID order breaks ties. Wall-clock timestamps do not decide the result. Receiving records advances the local logical clock before later writes.

This chooses one whole JSON value. Concurrent edits to different properties of one object are not merged property by property. If independent writers own independent fields, use separate variables. If multiple fields must travel as one snapshot, use one object and accept whole-value conflict resolution.

Deleting creates a versioned tombstone in RAM. It prevents an older value from reappearing during peer synchronization. A later higher-version write can create the value again. Tombstones consume record capacity; deletion is not a way to remove all version metadata or reclaim every slot.

There is no atomic operation spanning several variables. A reader can observe an intermediate state between two writes. Put inseparable fields in one value or define an application-level sequence identifier.

<a id="chapter-5"></a>
## 5. Offline operation and lifetime

1. A new Hub starts with empty memory and a new identity.
2. Online peers exchange their current records.
3. During a disconnect, a living SDK can keep reading and updating local RAM.
4. Reconnection merges retained current records with online peers.
5. Exiting the last process holding a record loses that record.

Offline writes do not create a stored operation log. Several changes to the same variable can collapse to its current record before publication. Restarting the broker does not restore SDK data, and keeping only a broker online does not retain variables. Periodic synchronization repairs missed current-state updates while copies remain alive.

<a id="chapter-6"></a>
## 6. Desired state and commands

Use variables for current measurements, configuration and desired state. A device should publish a separate reported value after applying a request. Include an application request ID when the requester needs to associate a result with an action.

Use [Python live channels](python-api.md#live) for expiring commands when supported by the receiver. Live sends are separate calls with no offline replay; they still do not prove execution. [ROS controls](ros-config.md#controls) add session checks for desired state and receiver leases for live commands.

Do not use a variable as an event log, an atomic counter or a queue where every intermediate value must be processed. Those guarantees are outside the current SDK.

Next: [connection modes and mesh](networking.md), then the API reference for [JS](javascript-api.md), [Python](python-api.md), [C++](cpp-api.md) or [ESP32](arduino-api.md).
