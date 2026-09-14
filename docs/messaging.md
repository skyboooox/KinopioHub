# Events and requests

[简体中文](messaging.zh.md) · [Home](wiki-home.en.md) · [Variables](variables.md)

Keep one `hub.var(name)` reference and choose the operation that fits the data. This chapter explains shared semantics; language references describe their return types, callbacks and resource settings.

| Platform | Message API |
| --- | --- |
| JS / Python / C++ | All operations below |
| [ESP32 basic client](arduino-api.md#7-messages-requests-and-drain) | Exact-name events, single-response requests, asynchronous handlers and Hub drain |
| [ROS](ros-config.md) | Selected operations mapped through YAML |

> **ESP32 scope:** No business wildcards, queue groups, response collection, application Headers or subscription drain. It can call a desktop queue service and answer a desktop response collection.

In this chapter

- [Choose an operation](#chapter-1)
- [Names, wildcards and queues](#chapter-2)
- [Requests and multiple replies](#chapter-3)
- [Headers](#chapter-4)
- [Limits, disconnection and shutdown](#chapter-5)

<a id="chapter-1"></a>
## Choose an operation

| Need | Write or send | Receive or read |
| --- | --- | --- |
| Current state, including offline RAM updates | `set(value)` | `get(fallback)`, `watchValue(handler)` |
| An event for currently connected subscribers | `pub(data)` | `sub(handler)` |
| A request with one application response | `req(data)` | `handle(handler)` returns the response |
| A bounded collection of responses | `requestMany(data, options)` | Several handlers, or explicit replies from a subscription |

`pub`, `sub` and `req` are exact aliases for `publish`, `subscribe` and `request`. Python uses `watch_value` and `request_many`. Complete method names remain available. Queue names, timeouts and Headers are optional settings, not additional topic arguments.

| Convenience method | Behavior |
| --- | --- |
| `get(fallback)` | Reads local RAM immediately; uses the fallback only when no current value exists. It never waits for a peer or writes the fallback. |
| `watchValue(handler)` | Keeps the original watch timing and cancellation rules; metadata changes can still notify. |

Null, false, zero and empty strings/collections remain valid values.

This Node/browser example runs after `await hub.connected()`:

```js
const notice = hub.var('notice');
const subscription = await notice.sub(data => console.log(data));
await notice.pub({ text: 'hello' });
// Later: await subscription.unsubscribe();
```

`pub()` does not change `value`, its version or pending state. `sub()` does not replay the current value. Repeated events are independent messages, while repeated versions of a cloud variable are deduplicated. A message-only reference still consumes reference capacity.

<a id="chapter-2"></a>
## Names, wildcards and queues

State methods treat the whole variable name literally. Message methods interpret dots as hierarchy separators. A concrete message name contains nonempty segments and no `*`, `>` or U+0000–U+001F/U+007F characters; its total length is 1–128 UTF-8 bytes.

| Subscription pattern | Matches | Does not match |
| --- | --- | --- |
| `sensor.*` | `sensor.temperature` | `sensor`, `sensor.room.temperature` |
| `sensor.>` | `sensor.temperature`, `sensor.room.temperature` | `sensor` |
| `>` | Business messages in this namespace | Another namespace, state records or SDK reports |

- Only **`sub` and `handle`** accept patterns. Each wildcard occupies a whole segment; `>` must be last.
- Publishing or requesting a pattern fails locally.
- `hub.var('sensor.*').set(1)` writes the literal state name `sensor.*`; the same reference's `sub()` subscribes to the message pattern. There is no implicit mode switch.

### Queue groups

Supply the same `queue` to interchangeable subscribers or handlers. NATS chooses one member per group for each message; other groups and ordinary subscribers can also receive it.

> **Load balancing only:** A queue group does not retain work, retry failed handlers or guarantee application completion. Distinct physical actuators are not interchangeable workers.

<details>
<summary>Wire subjects and permissions</summary>

| Traffic | Subject or queue |
| --- | --- |
| State | `<hex(namespace)>.<hex(full name)>` |
| Messages | `_msg.v1.<hex(namespace)>.<hex(segment)>...` |
| Queue group | `_q.v1.<hex(namespace)>.<hex(full queue name)>` |
| Reply | Native `_INBOX` |

Hex is lowercase UTF-8 without normalization. Configure NATS permissions for these subjects; namespace and encoding do not grant isolation. The SDK has no raw-subject mode.

</details>

<a id="chapter-3"></a>
## Requests and multiple replies

```js
const lamp = hub.var('lamp');
const responder = await lamp.handle(async setting => {
  await applyLamp(setting);
  return { ok: true };
});
const result = await lamp.req({ on: true });
console.log(result.ok);
```

`applyLamp` is the application's operation. The handler returns JSON; the SDK sends that value as its response.

| Omitted value | Wire value |
| --- | --- |
| JS handler returns nothing / Python returns `None` | JSON null |
| `req()` has no body | JSON null |
| Request needs options but no body | Pass explicit null/None, then options |

The SDK does not guess whether an object is data or configuration.

| Request outcome | Behavior |
| --- | --- |
| First valid response | Return its data; default total timeout is **3 seconds** |
| Detailed mode | Also return response Headers |
| Business failure | Application data, for example `{ok:false,error:'unavailable'}` |
| Handler exception | Recorded locally; the caller may time out. No automatic remote error object. |

| Receiver | Receives | Reply behavior |
| --- | --- | --- |
| `sub` | Matching events and requests | Return value is ignored; advanced context offers explicit `reply(data, options)` |
| `handle` | Requests with a reply destination | One automatic reply from the return value; context can set response Headers |

Ordinary publications without a reply destination are ignored by `handle`.

### Collect multiple replies

`requestMany` / `request_many` collects response messages within a bounded window.

| Setting or result | Meaning |
| --- | --- |
| Default window | **3 seconds**, at most **16 replies**, subject to byte limits |
| Detailed `reason` | `deadline` or `maxReplies` |
| Count | Messages, not unique devices |
| Empty completed window | Valid empty result; it does not prove every device answered |

- **Failures:** Timeout, cancellation, disconnect and permission errors are distinct from application responses. Multi-response failures retain bounded partial results as defined by each language API.
- **Invalid and late replies:** A malformed first reply fails the request; a late reply never restarts it.
- **`NO_RESPONDERS`:** The broker sees no matching subscription interest. A non-replying monitor still creates interest, so absence of this error does not prove a healthy responder.

> **No automatic retries.** A timeout or cancellation cannot undo remote work. Retried side effects need an application operation ID and deduplication rule. A response confirms only the completion rule implemented by the handler.

<a id="chapter-4"></a>
## Headers

Messages use native NATS Headers. JS, Python and C++ accept a string or repeated string values for each key.

| Operation | Rule |
| --- | --- |
| Send | Lowercase names; preserve value order within each logical key, including mixed-case input |
| `get` | Case-insensitive lookup of the first value |
| `getAll` / Python `get_all` | All matching values in order |
| Enumerate | Received wire names; no cross-SDK order guarantee between different keys |
| ESP32 | Validate bounded Headers for transport status, discard application metadata; put device data in JSON |

```js
await hub.var('notice').pub('ready', {
  headers: { 'X-Trace': 'operation-42', 'X-Tag': ['device', 'status'] }
});
```

| Content | Constraint |
| --- | --- |
| Header name | ASCII token |
| Header value | Visible ASCII; trim outer ASCII spaces, keep internal spaces |
| Control characters | Reject CR, LF, NUL and other controls |
| Unicode or whitespace-significant text | Put it in JSON |
| Size | Headers + payload must fit broker and SDK limits |
| Response Headers | Read through detailed request results; never inserted into the JSON body |

<a id="chapter-5"></a>
## Limits, disconnection and shutdown

Messages require an active connection. New messages are rejected while disconnected or draining; the SDK does not store offline events or replay requests after reconnecting. Subscriptions are re-established on the new connection. Cloud variables retain their separate offline RAM behavior.

### Slow consumers and limits

Subscriptions, requests, message queues, response collections and outgoing bytes are bounded.

| Condition | Result |
| --- | --- |
| Handler queue full | Drop new incoming messages, preserve accepted FIFO order, report `SLOW_CONSUMER` and counters |
| Request inbox overflow | Fail that request |
| Need backlog or drop counts | Read subscription status and `hub.status().messaging` for pending and in-flight work, limits and known drops |

These counters cannot prove there was no loss elsewhere in the network.

Keep callbacks short. Awaitable handlers run serially per subscription by default; ESP32 work advances through `loop()`. A synchronous handler that blocks its execution thread cannot be made responsive by increasing a timeout.

| Operation | Meaning |
| --- | --- |
| `pub` completes | Local bounded transport accepted the message |
| `flush` completes | NATS confirmed preceding transport writes, not remote execution |
| `unsubscribe` | Stop new delivery and discard waiting local work; admitted handlers may finish |
| Subscription `drain` | Finish accepted work and replies for that subscription within a deadline |
| Hub `drain` | Stop new operations, finish admitted work and requests, confirm transport and close |
| `close` | Immediate cleanup; it does not implicitly drain |

### Drain deadlines

| Rule | Behavior |
| --- | --- |
| Deadline | **5 seconds** for the whole operation by default |
| Expiry | Clean up SDK-controlled resources and report `DRAIN_TIMEOUT` |
| Caller | Owning application, outside a managed handler |
| Node / Python | Detect handler context |
| Browser | Conservatively reject while a relevant handler is in flight, even for external calls; wait for those handlers first |

In Node/Python, owned-node cleanup may continue after `DRAIN_TIMEOUT`; a subsequent `await hub.close()` joins that cleanup. Transport interests and new operations are already stopped.

During a planned node switch, business subscriptions are retired before the replacement is activated; in-flight requests fail rather than being replayed. A handoff can lose events, and failures can leave uncertainty about remote execution. No end-to-end exactly-once guarantee is provided.

Language details: [JavaScript](javascript-api.md), [Python](python-api.md), [C++](cpp-api.md), [ESP32](arduino-api.md), [ROS YAML](ros-config.md).
