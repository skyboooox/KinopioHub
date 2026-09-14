# ESP32 API and resource reference

[简体中文](arduino-api.zh.md) · [Getting started](arduino.md) · [Home](wiki-home.en.md)

The Arduino ESP32 SDK is a basic client. Wi-Fi, time initialization and the application loop remain under firmware control; it never downloads or runs a broker.

In this chapter

- [1. Initialization and loop ownership](#chapter-1)
- [2. Complete Config fields](#chapter-2)
- [3. Variable methods](#chapter-3)
- [4. Flush and status](#chapter-4)
- [5. TLS setup](#chapter-5)
- [6. Memory and firmware acceptance](#chapter-6)
- [7. Messages, requests and drain](#7-messages-requests-and-drain)

<a id="chapter-1"></a>
## 1. Initialization and loop ownership

### Hub lifetime

Create a long-lived `kinopio::Hub hub("workshop")`, or use `Hub()` for a generated UUID namespace. Read it with `namespaceName()`.

The default UUID is generated once at the first getter or `begin()` call and stays the same across later `begin()` calls. Config has no namespace or display name.

### Start and loop

Configure Wi-Fi, then call `hub.begin(config)` and call `hub.loop()` frequently from one Arduino task. `begin()` returns `bool`.

An empty server starts discovery; an explicit server attempts that connection. A true return from discovery initialization does not mean a broker is already connected.

> **Note:** Inspect `hub.connected()` separately. Do not call `begin()` repeatedly as a reconnect strategy: it starts a new lifetime with empty records. `disconnect()` pauses transport while retaining RAM, `reconnect()` resumes it, and `close()` releases SDK state. Variable handles must not outlive their owning Hub.

Ordinary Wi-Fi loss is handled through subsequent loop progress. Long blocking application work delays network receive, pending publication, peer repair and health reports. Avoid concurrently calling the SDK from several FreeRTOS tasks without an application ownership scheme.

<a id="chapter-2"></a>
## 2. Complete Config fields

All durations are **milliseconds**; sizes are bytes unless noted.

| Field | Default | Purpose |
| --- | --- | --- |
| `server` | Empty | Discover a node; otherwise one `nats://` or `tls://` client URL |
| `group` | `"default"` | Discovery domain group |
| `upstreams` | Empty vector | Match the discovered mesh domain's upstream configuration; no broker is hosted |
| `token` | Empty | Token authentication |
| `user`, `password` | Empty | User/password authentication |
| `caCertificate` | Empty | Trusted CA certificate as PEM text, not a filename |
| `tlsFirst` | `true` | TLS-first handshake; false selects INFO-then-TLS |
| `maxVariables` | `32` | Stable name-reference capacity and separate current record capacity, including tombstones |
| `maxMemoryBytes` | `65536` | Shared JSON allocation budget |
| `maxValueBytes` | `8192` | Individual JSON value limit |
| `maxMessageBytes` | `16384` | NATS payload buffer limit |
| `healthInterval` | `5000` | Health report interval |
| `peerTimeout` | `2400` | Peer query timing |
| `syncInterval` | `15000` | Current-state repair interval |

> **Note:** `maxMessageBytes` must be at most 16,384 and at least `maxValueBytes + 1024`. Raising only the value limit will therefore fail configuration validation. `syncInterval` must be at least `peerTimeout`; capacities and intervals must be positive and supported. Keep the defaults until measurements justify changing them.

<a id="chapter-3"></a>
## 3. Variable methods

| Method | Result / meaning |
| --- | --- |
| `hub.var(name)` | Variable handle |
| `set(value)` | Boolean RAM write for ArduinoJson-compatible data |
| `setValue(JsonVariantConst)` | Write an owned snapshot from a JSON view |
| `setJson(text)` | Parse, validate and write JSON |
| `erase()` | Versioned deletion |
| `value()` / `get()` / `get(fallback)` | Owned local JSON snapshot |
| `exists()` / `pending()` | Presence / pending publication |
| `versionCounter()` / `versionWriter()` | Current version strings |
| `watch(callback)` / `watchValue(callback)` | Watch ID; zero on registration failure |
| `unwatch(id)` | Remove that watch |

### Value ownership

`set()` and `setValue()` retain an owned JSON snapshot. This includes nested strings that ArduinoJson linked to a caller's static array, so successful writes let the caller modify or release the input.

`value()` and `get()` return owned `JsonDocument` copies. `get(fallback)` uses its fallback only for an unknown or deleted value; null, false, zero and empty values remain values. The fallback is never stored or sent.

### Watches and errors

`watchValue([](JsonVariantConst value) { ... })` adapts the synchronous watch. It creates one owned snapshot per invocation and returns the same watch ID for `unwatch()`; its callback view lasts only for that invocation.

```cpp
auto battery = hub.var("battery");
if (!battery.set(80)) {
    Serial.println(hub.lastError().c_str());
}
auto id = battery.watch([](const kinopio::Variable &value) {
    if (value.exists()) Serial.println(value.value().as<int>());
});
// Call battery.unwatch(id) when this consumer is removed.
```

This fragment runs after initialization. Watch callbacks receive a variable reference and run synchronously when emitted, including an initial call at registration. Keep the callback short.

> **Note:** Unlike desktop SDKs, there is no variable `ready()` or tri-state `meta` object: `exists()==false` means no current local value and does not prove every peer is empty.

JSON null is present when `exists()` is true. Reading returns a copy; modifying it requires another explicit write.

> **Note:** A false result can include validation or allocation failure. Inspect `lastError()` when available, and do not assume a failed write was published.

<a id="chapter-4"></a>
## 4. Flush and status

`hub.flush(timeoutMs=5000)` returns a boolean transport result. It may block the caller while progressing transport, so do not call it for every high-frequency sensor sample or treat it as a real-time loop deadline. Normal `loop()` calls publish pending data and poll their own PONG receipts without a blocking flush. Authentication and subscription readiness also use loop-driven receipts; an older heartbeat PONG cannot confirm a newer write. Socket operations and application callbacks still have their own execution cost.

`hub.status()` returns a local `JsonDocument` snapshot. The basic client has no `instances()` API. `lastError()` returns a string representing the current transport or SDK error. Status snapshots and value copies also allocate memory; avoid retaining many large copies merely to display a few fields.

Pause/resume retains only the current RAM records, not every offline write. Reboot or a new lifetime loses them; an online peer is the only recovery source. See [Variables](variables.md).

<a id="chapter-5"></a>
## 5. TLS setup

Set `server` to a TCP TLS endpoint and fill `caCertificate` with trusted PEM text. The firmware must establish valid UTC time through its own SNTP or RTC setup before TLS; `CLOCK_REQUIRED` indicates the clock is not ready. The SDK does not configure global SNTP.

Keep certificate chain, hostname and date validation enabled. Configure `tlsFirst` to match the listener. There is no WS/WSS client transport or public client-certificate/key pair in this Config. Do not copy desktop filesystem certificate options into firmware configuration.

<a id="chapter-6"></a>
## 6. Memory and firmware acceptance

The state JSON budget includes incoming and merge temporaries. TLS, NATS buffers, maps, application data and Wi-Fi consume additional heap. The SDK also preserves a 32 KiB native heap reserve. Neither the JSON budget nor static RAM size describes total runtime memory use.

Measure firmware flash, static RAM, free heap and minimum free heap under reconnects, large messages and repeated synchronization. Prefer bounded variable names and small current values. Deletion retains a tombstone, so continuously creating and deleting unique names does not avoid the record limit.

Wi-Fi and TLS still account for a substantial part of the firmware. The default application partition is 1.25 MiB. Check the final firmware size after adding sensor drivers and application code. Choose a partition layout that fits the application and its OTA requirements; the larger test partition described in the hardware checks is not an OTA deployment layout.

Use the pinned [PlatformIO environment](https://github.com/skyboooox/KinopioHub.ino/blob/main/platformio.ini) and [hardware checks](development.md#esp32-hardware). Keep Wi-Fi credentials and test CA material in local configuration. Vendor provenance and patches remain in `src/vendor/espidf-nats/UPSTREAM.md`; the SDK has no mesh-host, persistence or live-control API.

## 7. Messages, requests and drain

The basic client provides exact-name messages on the stable `hub.var(name)` reference. Message operations do not change current values or versions. Names follow the shared UTF-8 hexadecimal encoding; business `*` and `>` patterns are rejected. State names still treat those characters literally.

| API | Result |
| --- | --- |
| `publish(data)` / `pub(data)` | Boolean acceptance by the bounded online transport |
| `subscribe(handler)` / `sub(handler)` | `Subscription`; callback receives JSON and optionally `MessageContext&` |
| `handle(handler)` | `Subscription`; handler returns `JsonDocument` and may receive `HandlerContext&` |
| `request(data, onReply, RequestOptions)` / `req(...)` | `Request`; callback receives `(JsonVariantConst data, const std::string& error)` |
| `req(onReply)` | Request with a JSON null body |
| `Request::cancel()` / `pending()` | Cancel locally / inspect progress |
| `Subscription::status()` / `unsubscribe()` | Inspect readiness and backlog / stop delivery and discard queued work |
| `Hub::drain(callback, timeout=5000)` | Finish accepted work and pending state, confirm transport and close within the total deadline |

### Readiness and requests

Keep calling `hub.loop()`. A returned subscription is not ready until `subscription.status().ready` becomes true; check this independently of Hub connectivity.

Initial registration closes on disconnect or readiness timeout. An established subscription keeps its handle through reconnects and becomes ready again after transport confirmation.

`RequestOptions` contains only `timeout`, default 3,000 milliseconds. An empty callback error means success, and the JSON view lasts only for that callback.

> **Note:** Late replies cannot revive completed requests. Cancellation and timeout do not undo remote actions, and the SDK does not retry automatically.

### Handler return and context

A normal `handle` return becomes its single response; a null document replies with JSON null. Events without a reply address do not invoke that handler.

For asynchronous work, call `auto completion = context.defer()`. Later call `completion.complete(data)` or `completion.fail()` from the same Arduino task; completion is accepted once and becomes invalid on disconnect or close.

Copy callback input into an owned document before retaining it. `MessageContext` has `topic`, single-use `reply(data)` and `defer()`; `HandlerContext` has `topic()` and `defer()`, with no manual reply.

### Unsupported message features

> **Note:** There is no public Headers, queue group, multi-response collection, detailed-result or subscription-drain API.

Native Headers are bounded and validated, including broker `NO_RESPONDERS` status; application metadata is discarded. Put device-required information in JSON. The device can call a desktop queue service and reply once to a desktop `requestMany` operation.

| `Config.messaging` field | Default | Maximum |
| --- | ---: | ---: |
| `subscriptions` | 16 | 16 |
| `requests` | 4 | 4 |
| `pendingMessages` | 16 | 32 |
| `pendingBytes` | 16384 | 32768 |
| `payloadBytes` | 1024 | 8192 |

### Queue budget

All capacities are positive. Each subscription admits at most two deliveries / 4,096 bytes, including its running or deferred handler.

The aggregate budget includes request replies. Subject, reply address and native Headers count toward bytes, and a larger payload setting does not bypass the subscription byte budget.

Native Headers are limited to 1,024 bytes / 16 entries. Three state subscriptions, sixteen business subscriptions and four inboxes fit the native subscription limit.

Full queues drop new deliveries, preserve accepted FIFO order, and report `SLOW_CONSUMER` with a drop count. Inbox overflow fails its request.

The loop dispatches at most four messages per turn with a ten-millisecond dispatch budget. Blocking application code can exceed that budget; retained JSON, TLS and native buffers use additional heap.

### Drain and reconnect

Use Hub drain from the application owner, not inside a managed handler. It rejects new writes, stops subscription interest, finishes accepted work and closes; timeout reports `DRAIN_TIMEOUT`. `close()` stops immediately.

Subscriptions are re-established after an ordinary reconnect, while old response handles are invalidated. There is no offline event queue, request replay or endpoint-to-endpoint exactly-once guarantee.

Local subscription status exposes readiness, backlog, active work, drops and errors. `hub.status().messaging` reports current aggregates without high-water statistics. The periodic remote heartbeat omits message diagnostics and traffic counters; it retains only instance ID, namespace, SDK/version, connection and health, plus `currentError` when present. Other SDKs can observe this heartbeat, while the ESP32 stores no peer-health list.
