# Python API reference

[简体中文](python-api.zh.md) · [Getting started](python.md) · [Home](wiki-home.en.md)

Python 3.10+ with asyncio. Public exports include `KinopioHub`, `Variable`, `KinopioError`, `UNSET`, `LiveChannel`, `LiveContext`, `Headers`, `Reply`, `ManyResult`, `Subscription`, `MessageContext`, `HandleContext`, `MessageError` and `__version__`.

In this chapter

- [1. Event loop and lifecycle](#chapter-1)
- [2. Constructor options](#chapter-2)
- [3. Variables](#chapter-3)
- [4. Callbacks and instance reports](#chapter-4)
- [5. Live channels](#chapter-5)
- [6. Errors and integration](#chapter-6)
- [7. Events and requests](#messaging)

<a id="chapter-1"></a>
## 1. Event loop and lifecycle

```python
import asyncio
from kinopio_hub import KinopioHub, UNSET

async def main():
    async with KinopioHub("workshop") as hub:
        await hub.connected()
        battery = hub.var("battery")
        await battery.ready()
        if battery.value is not UNSET:
            print(battery.value)

asyncio.run(main())
```

Use one asyncio event loop for a Hub and its operations. Construction inside a running loop starts initialization; otherwise startup is deferred until an asynchronous operation initializes it. Context-manager entry waits for local initialization, not network connectivity. Exit closes the Hub.

`await hub.ready()` and `await hub.connected(timeout=None)` return the Hub. `await hub.flush(timeout=None)` and `await hub.close()` return no value. `hub.instance_id` identifies this runtime instance; `hub.state` is the local connection state. Closing does not persist records or imply a final flush.

<a id="chapter-2"></a>
## 2. Constructor options

Namespace is the only positional parameter; remaining settings use keywords. Omission or `None` generates a UUID exposed as read-only `hub.namespace`; display name is not accepted.

The signature is `KinopioHub(namespace=None, *, servers=None, mesh=True, **options)`. Python option names use snake_case; general durations are **seconds**. Fields explicitly ending in `_ms` use milliseconds.

| Option | Default | Meaning |
| --- | --- | --- |
| `namespace` | Random UUID | Shared data namespace |
| `servers` | By connection mode | Client URL string or list |
| `mesh` | `True` | Automatic nodes; `False` for client-only |
| `discovery` | Enabled | Legacy UDP endpoint hints; no HTTP manifest fetching |
| `token` | Unset | Token authentication |
| `user`, `password` | Unset | User/password authentication |
| `tls` | Unset | Client TLS settings; use `mesh=False` |
| `timeout` | `3` | General timeout; explicitly setting it also changes connection waits |
| `peer_timeout` | 80% of `timeout` | Peer discovery wait |
| `health_interval` | `5` | SDK reporting period |
| `probe_interval` | `15` | Connection probe period |
| `max_variables` | `10000` | Record/reference capacity |
| `max_memory_bytes` | `16777216` | Record-data budget |
| `max_instances` | `1024` | Observed instance capacity |
| `selection` | SDK policy | `improvement_ms`, `improvement_ratio`, `cooldown` for client switching |
| `on_callback_error` | Unset | Synchronous callback error handler |

Automatic `connected()` and `flush()` default to 60 seconds when no explicit timeout overrides them. `tls` accepts an `ssl.SSLContext` or a dictionary with `ca_file`, `cert_file`, `key_file`, `handshake_first`; dictionary paths are application paths. `mesh` dictionaries accept `group`, `binary`, `upstreams`, `upstream_tls`; leaf TLS uses the same snake_case certificate keys. ROS separately resolves its YAML-relative paths.

<a id="chapter-3"></a>
## 3. Variables

| Member | Result |
| --- | --- |
| `hub.var(name)` | Stable reference |
| `variable.get(fallback=UNSET)` | Local snapshot; fallback only when absent, without writing it |
| `variable.watch_value(callback)` | Value-only synchronous watch; returns the existing stop function |
| `variable.value` | JSON-compatible copy, or the `UNSET` sentinel |
| `variable.meta` | Dictionary of initialization, existence, version, pending and connection state |
| `await variable.set(value)` | Local RAM write |
| `await variable.delete()` | Versioned deletion |
| `await variable.ready(timeout=None)` | The variable after local state initialization |
| `variable.watch(callback)` | Synchronous stop function |

Use identity comparison with `UNSET`. `None`, `False`, zero and empty collections are valid values; a truthiness check cannot distinguish them from absence. `meta["exists"]` is `None` when unknown, `False` when absent and `True` when present. Metadata/report field names such as `instanceId` and `pendingVariables` retain the shared wire spelling even though constructor options use snake_case.

Names are 1–128 UTF-8 bytes without control characters. Protocol 4 encodes both the namespace and variable name as UTF-8 hexadecimal tokens; a state record uses `<namespace-token>.<variable-token>`, while SDK control subjects use `_sys.v4.<namespace-token>`. These subjects are internal protocol details, not a substitute for `hub.var(name)`.

```python
battery = hub.var("battery")
await battery.set(None)
assert battery.value is None
await battery.delete()
assert battery.value is UNSET
```

JSON-compatible values exclude bytes, sets, custom objects, nonfinite numbers and unsafe integer-valued numbers. Serialize an application type explicitly; Python's arbitrary-size integers do not remove the cross-language numeric limit. Reads do not subscribe to an operation history. See [Variables](variables.md).

<a id="chapter-4"></a>
## 4. Callbacks and instance reports

Variable watches take `(value, meta)`, Hub watches take local status, and instance watches take a list of observed reports. All these callbacks must be synchronous. An `async def` watcher is not supported; an awaitable return is treated as a callback error.

```python
stop = hub.instances.watch(
    lambda items: print([(item["instanceId"], item["online"]) for item in items])
)
reports = await hub.instances.list()
# Call stop() during cleanup.
```

`hub.status()` is synchronous. Keep callbacks short and move longer work into explicitly managed tasks with bounded concurrency. Stop application tasks during shutdown as well as stopping watches. `on_callback_error` must also be synchronous.

<a id="live"></a>
<a id="chapter-5"></a>
## 5. Live channels

`hub.live(name)` returns a channel in the Hub namespace. Use identical names at sender and receiver; a ROS live route normally uses the route variable, such as `control/command`. Live channels do not create a cloud variable.

| Method | Parameters / result |
| --- | --- |
| `await channel.subscribe(callback, max_age_ms=300, with_context=False)` | Registers a synchronous receiver; returns an asynchronous stop callable |
| `await channel.send(value, timeout=3)` | Sends one command through an active connection; confirms transport |
| `context.is_valid()` | Whether deferred work still belongs to a valid receiver session and lease |
| `context.expires_at` | Local monotonic deadline, not UTC or another device's clock |

Both sides must be connected. Receiver lease duration accepts 1–60,000 ms. Deploy one receiver per channel; ownership is not coordinated across processes. A concurrent send on the same channel object can return `BUSY`, so serialize those sends. No receiver, disconnection or lease expiry can cause a send to fail.

```python
channel = hub.live("control/command")
stop = await channel.subscribe(lambda value: print(value), max_age_ms=300)
try:
    await asyncio.Event().wait()
finally:
    await stop()
```

Run the receiver inside a connected Hub. A second connected Hub can call `await hub.live("control/command").send({"data": "step"})`. Equal JSON in two sends represents two commands; nothing is replayed after reconnect.

With `with_context=True`, the callback takes `(value, context)`. If it queues work, check `context.is_valid()` immediately before acting. Do not substitute wall-clock comparisons for the receiver's monotonic validity check. A successful send is not a completion receipt. Use application feedback and, where needed, a local controller watchdog.

<a id="chapter-6"></a>
## 6. Errors and integration

Catch `KinopioError` and inspect `.code`. Watch local `status()` for background connection or report errors. `TIMEOUT`, `DISCONNECTED` and `CLOSED` describe different lifecycle conditions; a failed transport wait does not remove local values. Limit retry concurrency, particularly for live operations.

Install the matching Python SDK before the ROS bridge. There is no Node runtime dependency. [ROS configuration](ros-config.md) describes route-specific behavior; [Development](development.md) lists source tests and interoperability checks.


<a id="messaging"></a>
## 7. Events and requests

Message methods live on `hub.var(name)`, share its stable reference and never create or modify a state record. `set/watch/value/ready` retain their state meaning, and deleting state does not cancel subscriptions.

`get(fallback)` uses the fallback only for unknown/deleted state, preserving valid `None`, `False`, zero and empty values. `watch_value` preserves the existing synchronous watch timing and metadata-driven notifications.

| Method | Keyword options and result |
| --- | --- |
| `await ref.publish(data)` / `ref.pub(data)` | `headers=None`; accepts one JSON event into bounded transport |
| `await ref.subscribe(handler)` / `ref.sub(handler)` | `queue=None`, `with_context=False`, `pending_messages=256`, `pending_bytes=1048576`; returns `Subscription` after the SUB/PONG readiness barrier |
| `await ref.handle(handler)` | Same subscription options; automatically replies with the sync/async return value, including JSON null for `None` |
| `await ref.request(data=None)` / `ref.req(data=None)` | `timeout=3`, `headers=None`, `details=False`; first response data, or `Reply(data, headers)` |
| `await ref.request_many(data=None)` | Same request options plus `max_replies=16`, `max_bytes=1048576`; data list, or `ManyResult(replies, reason)` |
| `await subscription.unsubscribe()` | Stops interest and discards queued messages; running callbacks may finish |
| `await subscription.drain(timeout=5)` | Stops interest, finishes accepted callbacks and replies, confirms transport |
| `await hub.drain(timeout=5)` | One total deadline for callbacks, outstanding requests, transport confirmation and closure |
| `subscription.status()` | Local backlog, handler count, drops, high water marks and effective limits |

All durations above are seconds. Short names use the same implementation, errors and cancellation as full names. The payload is never guessed to be an options object; call `await ref.req(None, timeout=1)` for options without data.

| Request rule | Behavior |
| --- | --- |
| `request_many` | Sends once and counts reply messages, not distinct devices |
| Deadline | Can successfully return an empty list; detailed reasons are `deadline` or `maxReplies` |
| Collection limit | May be lowered, never above 16 replies or 1 MiB |

### Callback contexts

Callbacks are serial per subscription, accept data only by default, and may return awaitables. With `with_context=True`, the second argument exposes `topic` and `headers`.

| Context | Reply behavior |
| --- | --- |
| Subscribe | `await context.reply(data, headers=None)` can reply multiple times while the callback runs |
| Handle | Set `reply_headers` to a `Headers`/mapping before returning; there is no manual reply |
| Escaped background task | Cannot retain a usable reply context |

Handle ignores ordinary events with no reply subject; subscribe return values never automatically reply.

```python
from kinopio_hub import Headers

async def respond(data, context):
    context.reply_headers = Headers({"X-Worker": ["device-a", "primary"]})
    return {"ok": True, "input": data}

responder = await hub.var("robot.reset").handle(
    respond, queue="reset-workers", with_context=True
)
reply = await hub.var("robot.reset").req(details=True)
print(reply.data, reply.headers.get_all("x-worker"))
await responder.drain()
```

Message names use dot-separated segments, 1–128 UTF-8 bytes without C0/DEL controls or empty segments. `subscribe/handle` allow whole-segment `*` and final `>`; `>` requires at least one additional segment. Publishing or requesting a wildcard is `INVALID_TOPIC`. The state methods still treat the same name literally. Encoded `_msg.v1` subjects are separate from protocol-4 state; namespace is not an authorization boundary. Queue names are encoded as one complete name and forbid wildcards. Members of one queue must be equivalent workers; queue groups do not imply exactly-once execution.

### Headers

`Headers` accepts a mapping of strings/string lists or ordered `(key, value)` pairs. `items()` preserves local entries.

| Rule | Behavior |
| --- | --- |
| Outbound normalization | Lowercase names; trim ASCII edge spaces; preserve duplicate values per key |
| Lookup | `get/get_all` are case-insensitive; `get` returns the first value |
| Mutation | `add`, item assignment and `update` append; deletion removes all case variants |
| Wire iteration | Reflects received names; order across different keys is unspecified |
| Limits | ASCII-token names, visible-ASCII values, 32 entries / 4 KiB headers / 64 KiB JSON payload |

Payload plus Headers must also fit the broker limit. Put Unicode and whitespace-significant data in JSON. Reply headers use native NATS Headers without a business envelope.

New message operations fail immediately with `DISCONNECTED` offline and do not wait for `connected()` or buffer for replay. Requests are never retried automatically. `NO_RESPONDERS` means no matching subscription interest; a nonreplying subscriber produces `TIMEOUT`. Handler exceptions or invalid returned JSON record local `HANDLER_ERROR` without exposing exception text to the remote peer. Application failures can be ordinary JSON such as `{"ok": False}`. A timeout, cancellation or disconnection does not undo remote effects.

`MessageError` extends `KinopioError` with bounded `.partial_replies` containing `Reply` objects. Request collection errors include `BUFFER_OVERFLOW`, invalid replies, permission rejection and disconnection. Native task cancellation is preserved. For cancellation partials, retain the task and read `getattr(task, "partial_replies", [])` after catching `asyncio.CancelledError`; older Python Task implementations do not preserve custom attributes on the propagated cancellation exception.

### Capacity and status

| Hub `messaging` default | Value |
| --- | --- |
| `subscriptions`, `requests` | 128, 64 |
| `pending_messages`, `pending_bytes` | 4096, 8388608 |
| `outbound_bytes` | 8388608 |
| Per subscription | 256 messages, 1 MiB and one running callback |

The receive budget includes queued messages, active handlers and collected responses, including Headers, subject and reply bytes. Full queues drop new arrivals, retain FIFO for accepted work and report `SLOW_CONSUMER`; recovery clears the current warning while cumulative drops remain.

`hub.status()["messaging"]` exposes aggregate counters, phase and limits; native drop observations are separate. Broker/network loss is not measurable from these counters. Byte budgets are not a Python heap/TLS memory ceiling.

Python uses the pinned nats-py framing, connection and header primitives, with a bounded admission callback replacing an additional native business queue. Connection handoff stops old business interest and waits up to five seconds for accepted handlers before binding the new generation. Events may be lost in the gap. Requests and reply contexts remain tied to their original connection and cannot replay on a replacement.

### Drain and ownership

Drain rejects new message operations and state writes with `DRAINING`; accepted replies remain allowed. Calling a Hub's drain inside one of its managed handlers, or a subscription's drain inside its own handler, raises `DRAIN_IN_HANDLER`; notify an outer owner task instead.

`close()` is immediate cleanup and can interrupt drain. Deadline expiry forces cleanup and raises `DRAIN_TIMEOUT`.

> **Note:** Arbitrary blocking synchronous application code and already-started device effects cannot be forcibly undone. Existing live-channel lease semantics remain separate.

See [shared messaging semantics](messaging.md) for cross-SDK topic, queue and lifecycle rules.

If owned mesh cleanup outlasts the drain deadline, `DRAIN_TIMEOUT` returns promptly while cleanup continues; `await hub.close()` joins that cleanup.
