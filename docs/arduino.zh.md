# ESP32 Arduino

本手册：[安装与入门](arduino.zh.md) · [API 与配置参考](arduino-api.zh.md) · [变量语义](variables.zh.md) · [组网与状态](networking.zh.md) · [排错与迁移](troubleshooting.zh.md)

[English](arduino.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/KinopioHub.ino)

尚未发布的 v3 ESP32 客户端通过 NATS Core 共享内存变量，复用 ESP32 Wi-Fi/TLS、ArduinoJson 和固定版本的 `debsahu/espidf-nats`。它不投票、不托管 broker。

本章目录

- [构建与运行](#chapter-1)
- [常用 API](#chapter-2)
- [TLS 与资源限制](#chapter-3)

<a id="chapter-1"></a>
## 构建与运行

在 `KinopioHub.ino` 打开 `examples/Basic/Basic.ino`，在本地提供 Wi-Fi 设置，使用固定依赖的 PlatformIO 环境：

```sh
pio run
# Flash only when the intended ESP32 is connected:
pio run -t upload
pio device monitor
```

自带目标为 `esp32dev`，其他板型需要选择相应 PlatformIO 配置。设备凭据不要加入 Git。

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

`config.server` 留空时发现兼容的局域网节点，`config.group` 和鉴权需匹配其组网域。由同一个 Arduino task 高频调用 `hub.loop()`；长回调或应用阻塞也会延迟 SDK 通信。实际应用应检查写操作返回的 bool 和 `hub.lastError()`。

<a id="chapter-2"></a>
## 常用 API

| 操作 | 含义 |
| --- | --- |
| `hub.begin(config)` / `hub.loop()` | 初始化 / 推进 SDK |
| `hub.scope(name).var(name)` | 命名当前状态的句柄 |
| `variable.set(value)` / `setJson(text)` / `erase()` | 更新内存，离线可用 |
| `variable.value()` / `exists()` / `pending()` | 当前 JSON、存在性和待发状态 |
| `variable.watch(callback)` / `unwatch(id)` | 回调接收 `const kinopio::Variable&`，watch 返回 ID |
| `hub.connected()` / `status()` / `instances()` | 当前连接和 SDK 报告 |
| `hub.flush(timeoutMs)` | 等待 NATS 传输，不确认应用执行 |
| `hub.disconnect()` / `reconnect()` | 暂停/恢复传输，保留内存 |
| `hub.close()` | 释放资源 |

JSON null 是存在的值。重启使用新身份和空状态，只有在线副本可以提供原值，详见[工作原理](architecture.zh.md)。当前尚无 live 通道 API。

<a id="chapter-3"></a>
## TLS 与资源限制

设置 `config.server = "tls://nats.example.com:4222"`，并在 `config.caCertificate` 提供可信 PEM CA 文本。`tlsFirst` 默认 true；仅在要求 TLS 的 INFO-then-TLS 服务器上显式设为 false。直连不支持 WS/WSS。鉴权使用 `token` 或 `user`/`password`。

应用必须在 TLS 前设置有效 UTC 系统时间，例如由自己的 SNTP 或 RTC 初始化。未设置时间返回 `CLOCK_REQUIRED`；SDK 不配置 SNTP、不修改全局时间，保持证书链、主机名和日期校验。

默认限制为 128 条记录、8 KiB JSON 值、16 KiB NATS 报文、共享 64 KiB JSON 分配预算和 32 个观察到的 SDK。接收/合并临时数据计入 JSON 预算；TLS 和其他结构额外占堆。SDK 还保留 32 KiB 原生堆余量。根据应用调整容量，并测量实际空闲堆和最低堆，这不是整个固件的内存上限。

时间单位均为毫秒。状态上报默认 5 秒，副本同步默认 15 秒。Basic 与验收固件的资源占用不同，真机检查见[开发说明](development.zh.md#esp32-hardware)。捆绑客户端的来源和本地修补说明保留在 `src/vendor/espidf-nats/UPSTREAM.md`，随附 MIT 许可证。
