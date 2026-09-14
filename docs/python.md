# Python

Manual: [Installation and quick start](python.md) · [API and configuration](python-api.md) · [Variables](variables.md) · [Networking and status](networking.md) · [Troubleshooting](troubleshooting.md)

[简体中文](python.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/KinopioHub.py)

Python 3.10+, asyncio and the official NATS Python client. The SDK uses RAM variables and automatic LAN nodes without a Node.js runtime.

In this chapter

- [Start from source](#chapter-1)
- [Daily API](#chapter-2)
- [Connections](#chapter-3)
- [Live channels](#chapter-4)

<a id="chapter-1"></a>
## Start from source

In `KinopioHub.py`:

```sh
uv sync --extra dev
uv run python examples/watch.py
# In another terminal:
uv run python examples/basic.py
```

For another application, install this checkout into its environment with `python -m pip install -e /path/to/KinopioHub.py`.

```python
import asyncio
from kinopio_hub import KinopioHub

async def main():
    async with KinopioHub("workshop") as hub:
        battery = hub.var("battery")
        battery.watch(lambda value, meta: print(value))
        await battery.set(80)
        await hub.flush()

asyncio.run(main())
```

The context manager initializes the local SDK and closes it on exit. It does not wait for network connection on entry.

> **Note:** Keep a Hub running when it holds the only copy of a value.

<a id="chapter-2"></a>
## Daily API

| Operation | Meaning |
| --- | --- |
| `hub.var(name)` | Stable reference |
| `variable.value` / `variable.meta` | Current value copy and metadata |
| `await variable.set(value)` / `delete()` | Update local RAM |
| `variable.watch(callback)` | Synchronous `(value, meta)` callback; returns a stop function |
| `await variable.ready()` | Wait for known state, possibly absence |
| `await hub.connected()` / `flush()` | Wait for connection / NATS transport |
| `hub.status()` / `hub.watch(callback)` | Local SDK status |
| `await hub.instances.list()` / `hub.instances.watch(callback)` | Observed SDK reports |
| `await hub.close()` | Release resources |

Import `UNSET` to identify no locally available value; `None` is JSON null. `meta["exists"]` distinguishes unknown, absent and present.

> **Note:** Callbacks must be synchronous and brief; `on_callback_error` can handle exceptions.

See [How it works](architecture.md) for RAM lifetime, versions and health semantics.

<a id="chapter-3"></a>
## Connections

```python
hub = KinopioHub(
    namespace="demo",
    servers=["tls://nats.example.com:4222"],
    mesh=False,
    discovery=False,
    tls={"handshake_first": True},
)
```

Use `handshake_first` only for TLS-first servers. Direct clients support TCP/TLS/WS/WSS; authentication uses `token` or `user`/`password`. Custom client TLS requires `mesh=False`. Normal CA and hostname checks remain enabled.

Default automatic mode shares the election domain with JS and C++. `mesh={"group": "demo", "upstreams": ["nats://nats.example.com:7422"]}` connects a managed node to a real leaf listener. Leaf TLS uses `mesh["upstream_tls"]` with `handshake_first`, `ca_file`, `cert_file`, `key_file`. `discovery=False` disables legacy UDP hints, not mesh. Python does not fetch HTTP discovery manifests.

Public options use snake_case and **seconds**: `timeout=3`, `peer_timeout` defaults to 80% of it, `health_interval=5`, `probe_interval=15`. Automatic `connected()` / `flush()` allow 60 seconds unless explicitly overridden. Keys ending in `_ms`, including live `max_age_ms`, are milliseconds. Default data limits are 10,000 variables, 16 MiB of record data and 1,024 observed instances.

<a id="chapter-4"></a>
## Live channels

Live commands are separate from variables. Within an already-connected Hub, a receiver can use:

```python
channel = hub.live("control/command")
stop = await channel.subscribe(lambda value: print(value), max_age_ms=300)
# Keep this receiver running; later: await stop()
```

Another connected Hub in the same namespace sends `await hub.live("control/command").send({"data": "step"}, timeout=3)`.

Configure **one receiver per channel** across the deployment; cross-process ownership is not coordinated. Equal values are separate commands.

> **Note:** Receiver-issued leases reject expired, duplicate, reordered and old-connection messages. Disconnect invalidates leases and nothing is replayed. A successful send confirms transport, not execution.

For deferred work, pass `with_context=True` and accept `(value, context)`. Check `context.is_valid()` immediately before acting; `expires_at` uses the local monotonic clock. [ROS controls](ros.md#controls) use this path. Python is the only host SDK with live channels.

Examples also include `offline.py` and `sdk_status.py`, and accept `KINOPIO_EXAMPLE_SERVERS`, `KINOPIO_TOKEN`, `KINOPIO_EXAMPLE_TLS_FIRST=1`, `KINOPIO_MESH=0`, `KINOPIO_LEAF_SERVERS`. See [Development](development.md) for checks.

Events and requests use the same stable reference: `await ref.pub(data)`, `await ref.sub(handler)`, and `await ref.req()`; `handle` returns the automatic reply. Local `ref.get(fallback)` and `ref.watch_value(handler)` simplify state access. See [events and requests](python-api.md#messaging) for bounded collection, Headers, queues and drain.

See [shared messaging semantics](messaging.md) for cross-SDK topic, queue and lifecycle rules.
