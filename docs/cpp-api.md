# C++ API reference

[简体中文](cpp-api.zh.md) · [Getting started](cpp.md) · [Home](wiki-home.en.md)

Version 3.0.0, currently unpublished. Include `<kinopio/kinopio.hpp>` and link `KinopioHub::kinopiohub`. `kinopio::Json` is `nlohmann::ordered_json`; `kinopio::VERSION` exposes the SDK version. The implementation uses the official NATS C client.

In this chapter

- [1. Integrate with CMake](#chapter-1)
- [2. Hub and ownership](#chapter-2)
- [3. Options and TLS](#chapter-3)
- [4. Variables and snapshots](#chapter-4)
- [5. Callback threads and cleanup](#chapter-5)
- [6. Status and errors](#chapter-6)

<a id="chapter-1"></a>
## 1. Integrate with CMake

For a sibling source checkout:

```cmake
cmake_minimum_required(VERSION 3.24)
project(my_device LANGUAGES C CXX)
add_subdirectory(../KinopioHub.cpp kinopio-build)
add_executable(my_device main.cpp)
target_link_libraries(my_device PRIVATE KinopioHub::kinopiohub)
```

Or install the SDK and use `find_package(KinopioHub CONFIG REQUIRED)` with the installation prefix in `CMAKE_PREFIX_PATH`. CMake propagates public C++20 and JSON requirements. OpenSSL, libcurl and nats.c remain build/link dependencies. Linux is a source target awaiting runtime validation; Windows is not implemented. See [Getting started](cpp.md) for build commands.

<a id="chapter-2"></a>
## 2. Hub and ownership

| Method | Result |
| --- | --- |
| `Hub(Json options = Json::object())` | Starts the SDK and its background worker |
| `ready()` | `Hub&`, local readiness |
| `connected(int timeout_ms = 0)` | `Hub&`, waits for a connection |
| `flush(int timeout_ms = 0)` | `void`, waits for NATS transport |
| `scope(const std::string&)` | Scope handle |
| `status()` | JSON snapshot |
| `watch(std::function<void(Json)>)` | `Stop` function for local status |
| `close()` | Explicit cleanup |

Hub is neither copyable nor movable. Its destructor closes it. Scope and Variable handles are copyable and refer to the Hub's shared state; retaining a handle does not keep a closed Hub operational. Explicitly flush before closing if required; RAII cleanup is not an execution acknowledgment.

Wait methods are synchronous and block the caller. A timeout of zero selects the configured default, not an infinite wait. Defaults are 60,000 ms for automatic connection/flush waits and 3,000 ms in client-only mode; explicit constructor or call timeouts override the applicable default.

<a id="chapter-3"></a>
## 3. Options and TLS

Options are a JSON object using camelCase and **milliseconds**. General timer/capacity values must be positive integers within the implementation's supported range.

| Option | Default / meaning |
| --- | --- |
| `namespace`, `name` | Namespace defaults to `"default"`; name is a display label |
| `servers` | TCP/TLS client URL string or array |
| `mesh` | Enabled by default; `false` or a mesh object |
| `discovery` | Set false to disable endpoint hints; does not disable mesh |
| `token`, `user`, `pass` | Client authentication |
| `tls` | `caFile`, `certFile`, `keyFile`, `handshakeFirst`; client-only mode |
| `timeout`, `peerTimeout` | `3000`; peer wait defaults to 80% of timeout |
| `healthInterval`, `probeInterval` | `5000`, `15000` |
| `maxVariables`, `maxMemoryBytes`, `maxInstances` | `10000`, `16777216`, `1024` |
| `selection` | `improvementMs`, `improvementRatio`, `cooldownMs` tune client switching |
| `mesh.group`, `mesh.binary`, `mesh.upstreams` | Domain, optional executable, real leaf alternatives |
| `mesh.upstreamTls` | Leaf `caFile`, `certFile`, `keyFile`, `handshakeFirst` |

```cpp
kinopio::Hub hub({
    {"namespace", "workshop"},
    {"mesh", false},
    {"discovery", false},
    {"servers", {"tls://nats.example.com:4222"}},
    {"tls", {{"caFile", "ca.pem"}, {"handshakeFirst", true}}}
});
```

CA files are local paths. Supply both client certificate and key for mutual TLS. Direct WS/WSS is rejected; WS/WSS leaf upstreams are handled by the managed NATS executable. See [Networking](networking.md) before configuring a remote upstream.

<a id="chapter-4"></a>
## 4. Variables and snapshots

| Method | Return / meaning |
| --- | --- |
| `scope.var(name)` | Variable handle |
| `set(const Json&)` | `void`, validates and updates RAM |
| `erase()` | `void`, versioned deletion |
| `value()` | `std::optional<Json>` by value |
| `meta()` | JSON initialization, existence, version, pending and connection metadata |
| `ready(int timeout_ms = 0)` | `Variable&`, waits for local state initialization |
| `watch(callback)` | `Stop`; callback accepts `std::optional<Json>, Json` |

```cpp
auto battery = hub.scope("devices").var("battery");
battery.ready();
if (auto value = battery.value()) {
    std::cout << value->dump() << '\n';
}
battery.set(nullptr);
battery.erase();
```

The fragment assumes `<iostream>` and a live Hub. Empty optional means no local value; JSON null is a value inside a nonempty optional. Check `meta()["exists"]` to distinguish unfinished lookup from absence. Reading or editing a returned JSON snapshot does not write back to the variable.

<a id="chapter-5"></a>
## 5. Callback threads and cleanup

`kinopio::Stop` is `std::function<void()>`. Calling it unregisters the watcher. Callbacks are serialized per Hub but can execute on the emitting caller or a background network worker. Synchronize shared application data; never assume a UI main thread.

Keep callbacks brief and dispatch blocking application work elsewhere. Stopping a watch does not cancel an already-dispatched callback. Calling `close()` inside a callback requests shutdown without waiting for worker completion; normal application shutdown should close the Hub from the owning context.

Capture application objects only when their lifetime is controlled. Store stop functions alongside the consumers that own the subscriptions. Do not hold application locks across SDK operations if callbacks need the same locks.

<a id="chapter-6"></a>
## 6. Status and errors

`hub.instances.list()` synchronously returns the observed report list as JSON. `hub.instances.watch(std::function<void(Json)>)` returns a stop function. Local `status()` and remote instance reports follow [SDK status semantics](networking.md#6-read-sdk-status).

`kinopio::Error` derives from `std::runtime_error`, exposes `.code`, and provides the message through `what()`. Common conditions include invalid options/values, capacity exhaustion, timeout, closed Hub and unsupported transport. Other C++/JSON exceptions can also occur; use normal application exception handling.

C++ has no live API, persistence, history or separate leaf runtime API. Use the [shared variable chapter](variables.md) for concurrent writers and offline behavior, and [Troubleshooting](troubleshooting.md) for connection diagnosis.
