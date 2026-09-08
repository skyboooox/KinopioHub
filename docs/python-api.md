# Python API reference

[简体中文](python-api.zh.md) · [Getting started](python.md) · [Home](wiki-home.en.md)

Version 3.0.0, currently unpublished; Python 3.10+ with asyncio. Public exports include `KinopioHub`, `Scope`, `Variable`, `KinopioError`, `UNSET`, `LiveChannel`, `LiveContext` and `__version__`.

In this chapter

- [1. Event loop and lifecycle](#chapter-1)
- [2. Constructor options](#chapter-2)
- [3. Variables](#chapter-3)
- [4. Callbacks and instance reports](#chapter-4)
- [5. Live channels](#chapter-5)
- [6. Errors and integration](#chapter-6)

<a id="chapter-1"></a>
## 1. Event loop and lifecycle

```python
import asyncio
from kinopio_hub import KinopioHub, UNSET

async def main():
    async with KinopioHub(namespace="workshop", name="monitor") as hub:
        await hub.connected()
        battery = hub.scope("devices").var("battery")
        await battery.ready()
        if battery.value is not UNSET:
            print(battery.value)

asyncio.run(main())
```

Use one asyncio event loop for a Hub and its operations. Construction inside a running loop starts initialization; otherwise startup is deferred until an asynchronous operation initializes it. Context-manager entry waits for local initialization, not network connectivity. Exit closes the Hub.

`await hub.ready()` and `await hub.connected(timeout=None)` return the Hub. `await hub.flush(timeout=None)` and `await hub.close()` return no value. `hub.instance_id` identifies this runtime instance; `hub.state` is the local connection state. Closing does not persist records or imply a final flush.

<a id="chapter-2"></a>
## 2. Constructor options

The signature is `KinopioHub(namespace="default", servers=None, mesh=True, **options)`. Python option names use snake_case; general durations are **seconds**. Fields explicitly ending in `_ms` use milliseconds.

| Option | Default | Meaning |
| --- | --- | --- |
| `namespace` | `"default"` | Shared data namespace |
| `name` | SDK default | Display name, separate from runtime identity |
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

Automatic `connected()` and `flush()` default to 60 seconds when no explicit timeout overrides them. TLS dictionaries accept `ca_file`, `cert_file`, `key_file`, `handshake_first` for the supported certificate path. `mesh` dictionaries accept `group`, `binary`, `upstreams`, `upstream_tls`; leaf TLS uses the same snake_case certificate keys. Certificate paths for direct Python applications are application paths; ROS separately resolves its YAML-relative paths.

<a id="chapter-3"></a>
## 3. Variables

| Member | Result |
| --- | --- |
| `hub.scope(name).var(name)` | Stable reference |
| `variable.value` | JSON-compatible copy, or the `UNSET` sentinel |
| `variable.meta` | Dictionary of initialization, existence, version, pending and connection state |
| `await variable.set(value)` | Local RAM write |
| `await variable.delete()` | Versioned deletion |
| `await variable.ready(timeout=None)` | The variable after local state initialization |
| `variable.watch(callback)` | Synchronous stop function |

Use identity comparison with `UNSET`. `None`, `False`, zero and empty collections are valid values; a truthiness check cannot distinguish them from absence. `meta["exists"]` is `None` when unknown, `False` when absent and `True` when present. Metadata/report field names such as `instanceId` and `pendingVariables` retain the shared wire spelling even though constructor options use snake_case.

```python
battery = hub.scope("devices").var("battery")
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
    lambda items: print([(item["name"], item["online"]) for item in items])
)
reports = await hub.instances.list()
# Call stop() during cleanup.
```

`hub.status()` is synchronous. Keep callbacks short and move longer work into explicitly managed tasks with bounded concurrency. Stop application tasks during shutdown as well as stopping watches. `on_callback_error` must also be synchronous.

<a id="live"></a>
<a id="chapter-5"></a>
## 5. Live channels

`hub.live(name)` returns a channel in the Hub namespace. Use identical names at sender and receiver; a ROS live route normally uses `robot/variable`, such as `robot01/control/command`. Live channels do not create a cloud variable.

| Method | Parameters / result |
| --- | --- |
| `await channel.subscribe(callback, max_age_ms=300, with_context=False)` | Registers a synchronous receiver; returns an asynchronous stop callable |
| `await channel.send(value, timeout=3)` | Sends one command through an active connection; confirms transport |
| `context.is_valid()` | Whether deferred work still belongs to a valid receiver session and lease |
| `context.expires_at` | Local monotonic deadline, not UTC or another device's clock |

Both sides must be connected. Receiver lease duration accepts 1–60,000 ms. Deploy one receiver per channel; ownership is not coordinated across processes. A concurrent send on the same channel object can return `BUSY`, so serialize those sends. No receiver, disconnection or lease expiry can cause a send to fail.

```python
channel = hub.live("robot01/control/command")
stop = await channel.subscribe(lambda value: print(value), max_age_ms=300)
try:
    await asyncio.Event().wait()
finally:
    await stop()
```

Run the receiver inside a connected Hub. A second connected Hub can call `await hub.live("robot01/control/command").send({"data": "step"})`. Equal JSON in two sends represents two commands; nothing is replayed after reconnect.

With `with_context=True`, the callback takes `(value, context)`. If it queues work, check `context.is_valid()` immediately before acting. Do not substitute wall-clock comparisons for the receiver's monotonic validity check. A successful send is not a completion receipt. Use application feedback and, where needed, a local controller watchdog.

<a id="chapter-6"></a>
## 6. Errors and integration

Catch `KinopioError` and inspect `.code`. Watch local `status()` for background connection or report errors. `TIMEOUT`, `DISCONNECTED` and `CLOSED` describe different lifecycle conditions; a failed transport wait does not remove local values. Limit retry concurrency, particularly for live operations.

Install the local 3.0.0 Python SDK before the matching ROS bridge. There is no Node runtime dependency, old CLI or separate leaf API. [ROS configuration](ros-config.md) describes route-specific behavior; [Development](development.md) lists source tests and interoperability checks.
