# C++

Manual: [Installation and quick start](cpp.md) · [API and configuration](cpp-api.md) · [Variables](variables.md) · [Networking and status](networking.md) · [Troubleshooting](troubleshooting.md)

[简体中文](cpp.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/KinopioHub.cpp)

The C++20 SDK uses the official NATS C client for TCP/TLS, with automatic LAN nodes and RAII cleanup.

> **Note:** Build for macOS or Linux; Windows is not supported.

In this chapter

- [Build from source](#chapter-1)
- [Daily API](#chapter-2)
- [Connections and options](#chapter-3)

<a id="chapter-1"></a>
## Build from source

Requires CMake 3.24+, a C++20 compiler, OpenSSL and libcurl. CMake uses an installed compatible NATS C client / nlohmann JSON package or fetches the pinned source dependencies.

In `KinopioHub.cpp`:

```sh
cmake -S . -B build-v3 -DBUILD_TESTING=ON
cmake --build build-v3 -j
./build-v3/kinopio_example_watch
# In another terminal:
./build-v3/kinopio_example_basic
```

An application can use `add_subdirectory()` for this checkout and link `KinopioHub::kinopiohub`. Alternatively install with `cmake --install build-v3 --prefix /path/to/prefix` and use `find_package(KinopioHub CONFIG REQUIRED)`. Use a fresh build directory.

```cpp
#include <kinopio/kinopio.hpp>
#include <iostream>

int main() {
    kinopio::Hub hub("workshop");
    auto battery = hub.var("battery");
    battery.set(80);
    hub.flush();
    std::cout << battery.value()->dump() << '\n';
}
```

<a id="chapter-2"></a>
## Daily API

| Operation | Meaning |
| --- | --- |
| `hub.var(name)` | Copyable handle to stable state |
| `variable.set(value)` / `erase()` | Update RAM, including while disconnected |
| `variable.value()` | Return `std::optional<kinopio::Json>` by value |
| `variable.meta()` | Initialization, existence, version and transport metadata |
| `variable.watch(callback)` | `(std::optional<Json>, Json)` snapshots; returns a stop function |
| `variable.ready(timeout_ms)` | Wait for known state, possibly absence |
| `hub.connected(timeout_ms)` / `flush(timeout_ms)` | Wait for connection / transport |
| `hub.status()` / `hub.watch(callback)` | Local SDK status |
| `hub.instances.list()` / `watch(callback)` | Observed SDK reports |
| `hub.close()` | Explicit cleanup; the destructor also closes |

An empty optional means no locally available value; an optional containing `Json(nullptr)` is JSON null. `Hub` cannot be copied or moved. Variable handles do not keep a closed Hub operational.

> **Note:** The shared [RAM and version rules](architecture.md) apply.

State watch callbacks execute on the emitting thread, including a background network worker, and are serialized per Hub. Keep them brief and synchronize shared application data. An already-dispatched callback may finish after its watch is stopped. Calling `close()` from a callback requests shutdown without blocking for worker completion.

<a id="chapter-3"></a>
## Connections and options

```cpp
kinopio::Hub hub("demo", {
    {"servers", {"tls://nats.example.com:4222"}},
    {"mesh", false},
    {"discovery", false},
    {"tls", {{"handshakeFirst", true}}}
});
```

Use `handshakeFirst` only for TLS-first servers. Direct connections accept TCP/TLS, not WS/WSS. Authentication uses `token` or `user`/`pass`, separate from the URL. Custom client TLS requires client-only mode; certificate and hostname verification remain enabled.

Default automatic mode can reach a WS/WSS **leaf** upstream through its managed NATS Server: set `mesh.upstreams` to an actual leaf endpoint. Group is `mesh.group`; leaf TLS is `mesh.upstreamTls` with `handshakeFirst`, `caFile`, `certFile`, `keyFile`. See the [Server guide](server.md).

Options use camelCase and **milliseconds**. `connected()` and `flush()` allow 60 seconds by default in automatic mode, otherwise the default timeout is 3 seconds. Explicit timeouts override defaults. Records default to a 10,000-variable / 16 MiB limit; observed instances default to 1,024. These are data limits, not a process-memory cap.

Other executables are `kinopio_example_offline` and `kinopio_example_sdk_status`. Examples accept `KINOPIO_EXAMPLE_SERVERS`, `KINOPIO_TOKEN`, `KINOPIO_EXAMPLE_TLS_FIRST=1`, `KINOPIO_MESH=0`, `KINOPIO_LEAF_SERVERS`. Tests are in [Development](development.md). C++ does not provide a live-channel API.

## Messages

State and messages share the same stable variable handle. `battery.pub(81)` sends an event; it does not change `battery.get()`. `battery.sub(callback)` receives data, while `battery.handle(callback)` automatically replies with the returned JSON. `battery.req().get()` sends JSON null and waits for one JSON response.

> **Note:** Keep the returned `Subscription` alive; destroying its last copy unsubscribes without draining.

Use `requestMany()` for a bounded collection, `requestDetails()` / `requestManyDetails()` for typed reply metadata, and `handleDeferred()` for a tracked device operation that completes later. Blocking waits and drain must run outside SDK callbacks. Message callbacks run separately from nats.c delivery and are serial per subscription; callbacks from different subscriptions may overlap. See the [C++ API](cpp-api.md#messages) and the shared [messaging contract](messaging.md).

Build and run `kinopio_example_messaging` for a short state, event and request example. Message operations require an active connection and use message protocol 1 alongside unchanged RAM state protocol 4.
