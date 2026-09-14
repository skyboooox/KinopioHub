# C++ API reference

[简体中文](cpp-api.zh.md) · [Getting started](cpp.md) · [Home](wiki-home.en.md)

Include `<kinopio/kinopio.hpp>` and link `KinopioHub::kinopiohub`. `kinopio::Json` is `nlohmann::ordered_json`; `kinopio::VERSION` exposes the SDK version. The implementation uses the official NATS C client.

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

Or install the SDK and use `find_package(KinopioHub CONFIG REQUIRED)` with the installation prefix in `CMAKE_PREFIX_PATH`. CMake propagates public C++20 and JSON requirements. OpenSSL, libcurl and nats.c remain build/link dependencies. Build for macOS or Linux; Windows is not supported. See [Getting started](cpp.md) for build commands.

<a id="chapter-2"></a>
## 2. Hub and ownership

| Method | Result |
| --- | --- |
| `Hub()` / `Hub(namespace, Json options = Json::object())` | Starts the SDK and its background worker |
| `ready()` | `Hub&`, local readiness |
| `connected(int timeout_ms = 0)` | `Hub&`, waits for a connection |
| `flush(int timeout_ms = 0)` | `void`, waits for NATS transport |
| `var(const std::string&)` | Variable handle |
| `status()` | JSON snapshot |
| `watch(std::function<void(Json)>)` | `Stop` function for local status |
| `drain(int timeout_ms = 5000)` | Stop new work, complete accepted work within one deadline, close transport |
| `close()` | Explicit cleanup |

`Hub()` generates a UUID namespace; `namespaceName()` returns the immutable actual namespace. Use `Hub(std::nullopt, options)` for a generated namespace with advanced options. Options do not accept namespace or name. Hub is neither copyable nor movable. Its destructor closes it. Variable handles are copyable and refer to the Hub's shared state; retaining a handle does not keep a closed Hub operational. Explicitly flush before closing if required; RAII cleanup is not an execution acknowledgment.

Wait methods are synchronous and block the caller. A timeout of zero selects the configured default, not an infinite wait. Defaults are 60,000 ms for automatic connection/flush waits and 3,000 ms in client-only mode; explicit constructor or call timeouts override the applicable default.

<a id="chapter-3"></a>
## 3. Options and TLS

Options are a JSON object using camelCase and **milliseconds**. General timer/capacity values must be positive integers within the implementation's supported range.

| Option | Default / meaning |
| --- | --- |
| `servers` | TCP/TLS client URL string or array |
| `mesh` | Enabled by default; `false` or a mesh object |
| `discovery` | Set false to disable endpoint hints; does not disable mesh |
| `token`, `user`, `pass` | Client authentication |
| `tls` | `caFile`, `certFile`, `keyFile`, `handshakeFirst`; client-only mode |
| `timeout`, `peerTimeout` | `3000`; peer wait defaults to 80% of timeout (`2400`) |
| `healthInterval`, `probeInterval` | `5000`, `15000` |
| `maxVariables`, `maxMemoryBytes`, `maxInstances` | `10000`, `16777216`, `1024` |
| `selection` | `improvementMs`, `improvementRatio`, `cooldownMs` tune client switching |
| `mesh.group`, `mesh.binary`, `mesh.upstreams` | Domain, optional executable, real leaf alternatives |
| `mesh.upstreamTls` | Leaf `caFile`, `certFile`, `keyFile`, `handshakeFirst` |

```cpp
kinopio::Hub hub("workshop", {
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
| `hub.var(name)` | Variable handle |
| `set(const Json&)` | `void`, validates and updates RAM |
| `erase()` | `void`, versioned deletion |
| `value()` / `get()` | `std::optional<Json>` by value |
| `get(const Json &fallback)` | JSON current value, or fallback only when absent |
| `watchValue(callback)` | Existing watch with only `std::optional<Json>` |
| `meta()` | JSON initialization, existence, version, pending and connection metadata |
| `ready(int timeout_ms = 0)` | `Variable&`, waits for local state initialization |
| `watch(callback)` | `Stop`; callback accepts `std::optional<Json>, Json` |

```cpp
auto battery = hub.var("battery");
battery.ready();
if (auto value = battery.value()) {
    std::cout << value->dump() << '\n';
}
battery.set(nullptr);
battery.erase();
```

The fragment assumes `<iostream>` and a live Hub. Empty optional means no local value; JSON null is a value inside a nonempty optional. Check `meta()["exists"]` to distinguish unfinished lookup from absence. Reading or editing a returned JSON snapshot does not write back to the variable.

Names are 1–128 UTF-8 bytes without control characters. Protocol 4 encodes both the namespace and variable name as UTF-8 hexadecimal tokens; a state record uses `<namespace-token>.<variable-token>`, while SDK control subjects use `_sys.v4.<namespace-token>`. These subjects are internal protocol details, not a substitute for `hub.var(name)`.

<a id="chapter-5"></a>
## 5. Callback threads and cleanup

`kinopio::Stop` is `std::function<void()>`. Calling it unregisters the watcher. State watch callbacks are serialized per Hub but can execute on the emitting caller or a background network worker. Synchronize shared application data; never assume a UI main thread.

Keep callbacks brief and dispatch blocking application work elsewhere. Stopping a watch does not cancel an already-dispatched callback. Calling `close()` inside a callback requests shutdown without waiting for worker completion; normal application shutdown should close the Hub from the owning context.

Capture application objects only when their lifetime is controlled. Store stop functions alongside the consumers that own the subscriptions. Do not hold application locks across SDK operations if callbacks need the same locks.

<a id="chapter-6"></a>
## 6. Status and errors

`hub.instances.list()` synchronously returns the observed report list as JSON. `hub.instances.watch(std::function<void(Json)>)` returns a stop function. Local `status()` and remote instance reports follow [SDK status semantics](networking.md#6-read-sdk-status).

`kinopio::Error` derives from `std::runtime_error`, exposes `.code`, and provides the message through `what()`. Common conditions include invalid options/values, capacity exhaustion, timeout, closed Hub and unsupported transport. Other C++/JSON exceptions can also occur; use normal application exception handling.

C++ has no live API, persistence or history. Use the [shared variable chapter](variables.md) for concurrent writers and offline behavior, and [Troubleshooting](troubleshooting.md) for connection diagnosis.

<a id="messages"></a>
## Messages and typed operations

The shared [messaging contract](messaging.md) defines message names, wildcard matching, queue groups, JSON validation, Headers, request uncertainty and drain. All operations below are on `Variable`; short names call the same implementation. Methods do not create or update RAM state records.

`get(fallback)` chooses from one locked state snapshot: null, false, zero and empty values never select the fallback. `watchValue` preserves watch timing and its `Stop` function.

| API | Result |
| --- | --- |
| `publish(data, MessageOptions = {})` / `pub(...)` | `void`; accepts a bounded local write |
| `subscribe(callback, SubscribeOptions = {})` / `sub(...)` | Copyable `Subscription` |
| `handle(callback, SubscribeOptions = {})` | Subscription; JSON callback result automatically replies |
| `handleDeferred(callback, SubscribeOptions = {})` | Subscription; callback receives a one-shot `DeferredReply` |
| `request(data = nullptr, RequestOptions = {})` / `req(...)` | `RequestOperation<Json>` |
| `requestDetails(...)` | `RequestOperation<Reply>` |
| `requestMany(data = nullptr, RequestOptions = {})` | `RequestOperation<std::vector<Json>>` |
| `requestManyDetails(...)` | `RequestOperation<Replies>` |

`subscribe` accepts either `(const Json&)` or `(const Json&, const MessageContext&)`. The context owns its `topic` and `headers`; `reply(data, MessageOptions)` explicitly replies, including multiple times, while that callback is active. A retained context cannot reply after the callback finishes. Missing reply subjects produce `NO_REPLY_SUBJECT`.

`handle` accepts `(const Json&) -> Json` or `(const Json&, HandleContext&) -> Json`. Set `context.replyHeaders` to attach response headers. The context has no manual reply method. Return `nullptr` for JSON null; handler exceptions record `HANDLER_ERROR` without sending exception text or an automatic error envelope. Ordinary events without a reply subject do not invoke request handlers.

```cpp
kinopio::SubscribeOptions subscribers;
subscribers.queue = "equivalent-workers";
auto responder = hub.var("lamp").handle(
    [](const kinopio::Json &data, kinopio::HandleContext &context) {
        context.replyHeaders = kinopio::Headers{{"X-Service", "lamp"}};
        return kinopio::Json{{"ok", true}, {"on", data.at("on")}};
    }, subscribers);
kinopio::RequestOptions request;
request.timeout = 1000;
auto response = hub.var("lamp").requestDetails({{"on", true}}, request).get();
auto service = response.headers.get("x-service");
```

`Reply` contains `data` and `headers`; `Replies` contains `std::vector<Reply> replies` and `reason` (`deadline` or `maxReplies`). Request handles provide nonblocking `ready()`, `cancel()`, and `partialReplies()`, plus blocking `get()`. Failure throws `RequestError`, whose `partialReplies` preserves a bounded collection of complete reply objects. Cancellation stops local waiting, not an already-running remote operation. Requests are never automatically resent.

`RequestOptions` inherits `MessageOptions.headers`, defaults to a total 3000 ms timeout, 16 replies and 1 MiB of reply bytes. Limits may be reduced; the timeout starts at invocation.

> **Note:** A single reply timeout is `TIMEOUT`; a many-reply deadline succeeds, possibly with an empty vector. No-interest 503 is `NO_RESPONDERS`; malformed first replies fail immediately. Headers plus JSON respect broker `max_payload` as well as SDK limits.

### Headers

`Headers` accepts initializer-list pairs or a JSON object containing strings/string arrays.

| Rule | Behavior |
| --- | --- |
| Lookup | `get()` returns the first value and `getAll()` returns all values, case-insensitively |
| Entries | `add()` preserves duplicates; `entries()` exposes stored key spellings |
| Outbound normalization | Keys are lowercase; edge ASCII spaces are trimmed; inner spaces and per-key value order remain |
| Limits | ASCII-token keys, visible-ASCII values, 4096 encoded bytes, 32 entries and 64 KiB structurally valid JSON |

Put whitespace-significant data in JSON.

### Deferred replies

`handleDeferred` callbacks receive `(const Json&, const HandleContext&, DeferredReply)`. Copy the handle into an application-owned operation, then call `complete(data, MessageOptions)` once or `cancel()`.

| Condition | Result |
| --- | --- |
| Completed or generation invalidated | `complete()` and `cancel()` return false |
| Last handle dropped | Cancels the unfinished reply |
| Callback and deferred operation both finish | SDK stops tracking completion |

No detached external operation is implicitly awaited. Synchronize the application-owned device operation and handle; retaining a handle never makes an old connection usable again.

`Subscription::ready()` confirms successful SUB/flush registration. Initial registration is synchronous and bounded to 3000 ms; invoke it outside callbacks. `unsubscribe()` discards queued work while retaining running callbacks in capacity accounting. `drain(timeout_ms = 5000)` first drains the native subscription, then SDK work, within one deadline. Destroying the last subscription handle unsubscribes; temporary Variable handles do not affect a retained subscription.

### Capacity

| Scope | Limit |
| --- | --- |
| One subscription | One managed callback/deferred operation; 256 messages / 1 MiB by default |
| Reduced subscription limit | `SubscribeOptions.maxPendingMessages` / `.maxPendingBytes`, minimum 2 messages / 3 bytes |
| Native reservation | Up to 16 messages / 72 KiB plus bounded delivery-copy bytes |
| Hub | 4096 received messages / 8 MiB; 128 subscriptions; 64 requests |
| Outbound buffer | 1 MiB |

Native reservations can reject a mixed allocation before count ceilings. Reply collections and running handlers share the global budget. These are accounted raw-data limits, not a process heap limit.

`subscription.status()` exposes pending work, in-flight handlers, SDK/native drop counts, high-water marks, `slow`, and effective limits. `hub.status().messaging` and health reports contain only aggregate phase/count fields. `SLOW_CONSUMER` reports local overload; native and SDK drops are separate. Lost broker/network messages cannot be inferred from those counts.

### Drain and callback ownership

Run blocking `get()`, connection waits, flush and drain outside SDK callbacks. Forbidden waits produce `BLOCKING_IN_HANDLER`; handler drain produces `DRAIN_IN_HANDLER`.

Message callbacks use bounded concurrent workers independently of nats.c delivery. Different subscriptions can overlap, so synchronize shared application objects.

Hub drain rejects new messages and state writes with `DRAINING`, preserves accepted reply contexts until the deadline, and closes transport promptly on `DRAIN_TIMEOUT`.

> **Note:** A timed-out drain cannot stop arbitrary application code. `close()` / destruction joins owned cleanup but never waits indefinitely for unowned handlers. Handoff allows up to 5000 ms for accepted old-generation work, retires old interests before new ones, invalidates timed-out replies and never replays events.
