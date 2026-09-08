# ESP32 API and resource reference

[简体中文](arduino-api.zh.md) · [Getting started](arduino.md) · [Home](wiki-home.en.md)

Version 3.0.0, currently unpublished. The Arduino ESP32 SDK is a client only. Wi-Fi, time initialization and the application loop remain under firmware control; it never downloads or runs a broker.

In this chapter

- [1. Initialization and loop ownership](#chapter-1)
- [2. Complete Config fields](#chapter-2)
- [3. Variable methods](#chapter-3)
- [4. Flush and status](#chapter-4)
- [5. TLS setup](#chapter-5)
- [6. Memory and firmware acceptance](#chapter-6)

<a id="chapter-1"></a>
## 1. Initialization and loop ownership

Create a long-lived `kinopio::Hub`, configure Wi-Fi, then call `hub.begin(config)`. Call `hub.loop()` frequently from one Arduino task. `begin()` returns `bool`; an empty server starts discovery, while an explicit server attempts that connection. A true return from discovery initialization does not mean a broker is already connected.

Inspect `hub.connected()` separately. Do not call `begin()` repeatedly as a reconnect strategy: it starts a new lifetime with empty records. `disconnect()` pauses transport while retaining RAM, `reconnect()` resumes it, and `close()` releases SDK state. Variable handles must not outlive their owning Hub.

Ordinary Wi-Fi loss is handled through subsequent loop progress. Long blocking application work delays network receive, pending publication, peer repair and health reports. Avoid concurrently calling the SDK from several FreeRTOS tasks without an application ownership scheme.

<a id="chapter-2"></a>
## 2. Complete Config fields

All durations are **milliseconds**; sizes are bytes unless noted.

| Field | Default | Purpose |
| --- | --- | --- |
| `namespaceName` | `"default"` | Data namespace |
| `name` | `"esp32"` | SDK display name |
| `server` | Empty | Discover a node; otherwise one `nats://` or `tls://` client URL |
| `group` | `"default"` | Discovery domain group |
| `upstreams` | Empty vector | Match the discovered mesh domain's upstream configuration; no broker is hosted |
| `token` | Empty | Token authentication |
| `user`, `password` | Empty | User/password authentication |
| `caCertificate` | Empty | Trusted CA certificate as PEM text, not a filename |
| `tlsFirst` | `true` | TLS-first handshake; false selects INFO-then-TLS |
| `maxVariables` | `128` | Current record capacity, including tombstones |
| `maxMemoryBytes` | `65536` | Shared JSON allocation budget |
| `maxValueBytes` | `8192` | Individual JSON value limit |
| `maxMessageBytes` | `16384` | NATS payload buffer limit |
| `maxInstances` | `32` | Observed SDK capacity |
| `healthInterval` | `5000` | Health report interval |
| `peerTimeout` | `2400` | Peer query timing |
| `syncInterval` | `15000` | Current-state repair interval |

`maxMessageBytes` must be at most 16,384 and at least `maxValueBytes + 1024`. Raising only the value limit will therefore fail configuration validation. `syncInterval` must be at least `peerTimeout`; capacities and intervals must be positive and supported. Keep the defaults until measurements justify changing them.

<a id="chapter-3"></a>
## 3. Variable methods

| Method | Result / meaning |
| --- | --- |
| `hub.scope(name).var(name)` | Variable handle |
| `set(value)` | Boolean RAM write for ArduinoJson-compatible data |
| `setValue(JsonVariantConst)` | Boolean write from an existing JSON view |
| `setJson(const std::string&)` | Parse JSON text, validate, then write |
| `erase()` | Boolean versioned deletion |
| `value()` | `JsonDocument` copy |
| `exists()` / `pending()` | Local presence / pending publication |
| `versionCounter()` / `versionWriter()` | Current version strings, or empty strings without a record |
| `watch(callback)` | Watch ID; zero on registration failure |
| `unwatch(id)` | Remove that watch |

```cpp
auto battery = hub.scope("devices").var("battery");
if (!battery.set(80)) {
    Serial.println(hub.lastError().c_str());
}
auto id = battery.watch([](const kinopio::Variable &value) {
    if (value.exists()) Serial.println(value.value().as<int>());
});
// Call battery.unwatch(id) when this consumer is removed.
```

This fragment runs after initialization. Watch callbacks receive a variable reference and run synchronously when emitted, including an initial call at registration. Keep the callback short. Unlike desktop SDKs, there is no variable `ready()` or tri-state `meta` object: `exists()==false` means no current local value and does not prove every peer is empty.

JSON null is present when `exists()` is true. Reading returns a copy; modifying it requires another explicit write. A false result can include validation or allocation failure; inspect `lastError()` when available and do not assume a failed write was published.

<a id="chapter-4"></a>
## 4. Flush and status

`hub.flush(timeoutMs=5000)` returns a boolean transport result. It may block the caller while progressing transport, so do not call it for every high-frequency sensor sample or treat it as a real-time loop deadline. Normal `loop()` calls publish pending data automatically.

`hub.status()` and `hub.instances()` return `JsonDocument` snapshots. `lastError()` returns a string representing the current transport or SDK error. Status snapshots and value copies also allocate memory; avoid retaining many large copies merely to display a few fields.

Pause/resume retains only the current RAM records, not every offline write. Reboot or a new lifetime loses them; an online peer is the only recovery source. See [Variables](variables.md).

<a id="chapter-5"></a>
## 5. TLS setup

Set `server` to a TCP TLS endpoint and fill `caCertificate` with trusted PEM text. The firmware must establish valid UTC time through its own SNTP or RTC setup before TLS; `CLOCK_REQUIRED` indicates the clock is not ready. The SDK does not configure global SNTP.

Keep certificate chain, hostname and date validation enabled. Configure `tlsFirst` to match the listener. There is no WS/WSS client transport or public client-certificate/key pair in this Config. Do not copy desktop filesystem certificate options into firmware configuration.

<a id="chapter-6"></a>
## 6. Memory and firmware acceptance

The shared JSON budget includes incoming and merge temporaries. TLS, NATS buffers, maps, application data and Wi-Fi consume additional heap. The SDK also preserves a 32 KiB native heap reserve. Neither the JSON budget nor static RAM size describes total runtime memory use.

Measure firmware flash, static RAM, free heap and minimum free heap under reconnects, large messages and repeated synchronization. Prefer bounded variable names and small current values. Deletion retains a tombstone, so continuously creating and deleting unique names does not avoid the record limit.

Use the pinned [PlatformIO environment](https://github.com/skyboooox/KinopioHub.ino/blob/main/platformio.ini) and [hardware checks](development.md#esp32-hardware). Keep Wi-Fi credentials and test CA material in local configuration. Vendor provenance and patches remain in `src/vendor/espidf-nats/UPSTREAM.md`; the SDK has no mesh-host, persistence or live-control API.
