# ESP32 Arduino

Manual: [Installation and quick start](arduino.md) · [API and configuration](arduino-api.md) · [Variables](variables.md) · [Networking and status](networking.md) · [Troubleshooting](troubleshooting.md)

[简体中文](arduino.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/KinopioHub.ino)

The unpublished v3 ESP32 client shares RAM variables over NATS Core. It uses ESP32 Wi-Fi/TLS, ArduinoJson and a pinned `debsahu/espidf-nats` client. It never votes or hosts a broker.

In this chapter

- [Build and run](#chapter-1)
- [Daily API](#chapter-2)
- [TLS and resource limits](#chapter-3)

<a id="chapter-1"></a>
## Build and run

In `KinopioHub.ino`, open `examples/Basic/Basic.ino` and supply your Wi-Fi settings locally. Use the pinned PlatformIO environment:

```sh
pio run
# Flash only when the intended ESP32 is connected:
pio run -t upload
pio device monitor
```

The included board target is `esp32dev`. For another board, choose its appropriate PlatformIO configuration. Keep device credentials out of Git.

```cpp
#include <WiFi.h>
#include <KinopioHub.h>

kinopio::Hub hub;

void setup() {
    WiFi.begin("YOUR_WIFI_SSID", "YOUR_WIFI_PASSWORD");
    kinopio::Config config;
    config.namespaceName = "demo";
    hub.begin(config);
    hub.scope("devices").var("battery").set(80);
}

void loop() {
    hub.loop();
    delay(1);
}
```

An empty `config.server` discovers a compatible LAN node. Set `config.group` and authentication to match its domain. Call `hub.loop()` frequently from one Arduino task; long callbacks or application delays also delay SDK communication. Check the boolean result of writes and `hub.lastError()` in application code.

<a id="chapter-2"></a>
## Daily API

| Operation | Meaning |
| --- | --- |
| `hub.begin(config)` / `hub.loop()` | Initialize / advance the SDK |
| `hub.scope(name).var(name)` | Handle to named current state |
| `variable.set(value)` / `setJson(text)` / `erase()` | Update RAM, including offline |
| `variable.value()` / `exists()` / `pending()` | Current JSON, presence and pending publication |
| `variable.watch(callback)` / `unwatch(id)` | Observe a `const kinopio::Variable&`; watch returns an ID |
| `hub.connected()` / `status()` / `instances()` | Current connection and SDK reports |
| `hub.flush(timeoutMs)` | Wait for NATS transport, not application execution |
| `hub.disconnect()` / `reconnect()` | Suspend/resume transport while retaining RAM |
| `hub.close()` | Release resources |

JSON null is a present value. Reboot creates a new identity and empty state; only an online peer can supply an earlier value. See [How it works](architecture.md). No live-channel API is available yet.

<a id="chapter-3"></a>
## TLS and resource limits

Set `config.server = "tls://nats.example.com:4222"` and supply trusted PEM CA text in `config.caCertificate`. `tlsFirst` defaults to true; explicitly set false only for a TLS-required INFO-then-TLS server. Direct WS/WSS is unsupported. Credentials use `token` or `user`/`password`.

The application must set a valid UTC system clock before TLS, for example through its own SNTP or RTC initialization. An unset clock returns `CLOCK_REQUIRED`; the SDK does not configure SNTP or change global time. Certificate chain, hostname and date checks stay enabled.

Defaults are 128 records, an 8 KiB JSON value, a 16 KiB NATS payload, a shared 64 KiB JSON allocation budget and 32 observed SDKs. Incoming/merge temporaries count toward the JSON budget; TLS and other structures use additional heap. The SDK also preserves a 32 KiB native heap reserve. Adjust limits to the application and measure actual free/minimum heap; these limits are not a firmware-wide memory cap.

All durations are milliseconds. Health defaults to 5 seconds and peer synchronization to 15 seconds. The Basic example and acceptance firmware have different resource footprints; see [Development](development.md#esp32-hardware) for board checks. Bundled client attribution and local patches remain in `src/vendor/espidf-nats/UPSTREAM.md` with its MIT license.
