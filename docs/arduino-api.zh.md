# ESP32 API 与资源参考

[English](arduino-api.md) · [入门](arduino.zh.md) · [首页](wiki-home.md)

对应尚未发布的 3.0.0。Arduino ESP32 SDK 仅作为客户端，Wi-Fi、时间初始化与应用循环由固件负责，不下载或运行 broker。

本章目录

- [1. 初始化与循环归属](#chapter-1)
- [2. 完整 Config 字段](#chapter-2)
- [3. 变量方法](#chapter-3)
- [4. Flush 与状态](#chapter-4)
- [5. TLS 设置](#chapter-5)
- [6. 内存与固件验收](#chapter-6)

<a id="chapter-1"></a>
## 1. 初始化与循环归属

创建长期存活的 `kinopio::Hub`，配置 Wi-Fi，然后调用 `hub.begin(config)`。在一个 Arduino 任务中频繁调用 `hub.loop()`。`begin()` 返回 `bool`；server 为空时启动发现，显式指定时尝试连接。发现初始化返回 true，不代表 broker 已连接。

连接状态另看 `hub.connected()`。不要反复 `begin()` 作为重连方式，它会开始一个记录为空的新生命周期。`disconnect()` 暂停传输并保留 RAM，`reconnect()` 恢复传输，`close()` 释放 SDK 状态。变量句柄不能比其 Hub 活得更久。

普通 Wi-Fi 断连通过之后的循环继续处理。长时间阻塞业务会延迟接收、待发布记录、对等修复和健康报告。没有应用归属设计时，不要从多个 FreeRTOS 任务并发操作 SDK。

<a id="chapter-2"></a>
## 2. 完整 Config 字段

所有时长为**毫秒**，未特别说明的大小单位为字节。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `namespaceName` | `"default"` | 数据命名空间 |
| `name` | `"esp32"` | SDK 显示名称 |
| `server` | 空 | 发现节点；否则为一个 `nats://` 或 `tls://` 客户端 URL |
| `group` | `"default"` | 发现域 group |
| `upstreams` | 空 vector | 匹配待发现 mesh 域的上游配置，不托管 broker |
| `token` | 空 | token 认证 |
| `user`、`password` | 空 | 用户名与密码 |
| `caCertificate` | 空 | 可信 CA 的 PEM 文本，不是文件名 |
| `tlsFirst` | `true` | TLS-first；false 为 INFO-then-TLS |
| `maxVariables` | `128` | 当前记录容量，包含删除标记 |
| `maxMemoryBytes` | `65536` | 共享 JSON 分配预算 |
| `maxValueBytes` | `8192` | 单个 JSON 值上限 |
| `maxMessageBytes` | `16384` | NATS payload 缓冲上限 |
| `maxInstances` | `32` | 观察 SDK 容量 |
| `healthInterval` | `5000` | 健康报告周期 |
| `peerTimeout` | `2400` | 对等查询计时 |
| `syncInterval` | `15000` | 当前状态修复周期 |

`maxMessageBytes` 不得超过 16,384，并且至少为 `maxValueBytes + 1024`，因此只增大值上限会导致配置验证失败。`syncInterval` 至少为 `peerTimeout`，容量和时长必须为支持范围内的正值。先保持默认值，再根据测量调整。

<a id="chapter-3"></a>
## 3. 变量方法

| 方法 | 结果与含义 |
| --- | --- |
| `hub.scope(name).var(name)` | 变量句柄 |
| `set(value)` | ArduinoJson 相容数据的布尔 RAM 写入结果 |
| `setValue(JsonVariantConst)` | 从现有 JSON 视图写入，返回布尔值 |
| `setJson(const std::string&)` | 解析 JSON 文本、验证并写入 |
| `erase()` | 带版本删除，返回布尔值 |
| `value()` | `JsonDocument` 副本 |
| `exists()` / `pending()` | 本地存在性与待发布标记 |
| `versionCounter()` / `versionWriter()` | 当前版本字符串，没有记录时为空 |
| `watch(callback)` | 监听 ID，注册失败为零 |
| `unwatch(id)` | 移除该监听 |

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

此片段在初始化后运行。watch 接受变量引用，触发时同步执行，包括注册时的初次调用，回调应保持简短。与桌面 SDK 不同，没有变量 `ready()` 或三态 `meta`；`exists()==false` 只说明本地当前无值，不证明所有副本都为空。

`exists()` 为 true 时，JSON null 也是存在的值。读取返回副本，修改后需显式写入。false 结果可能包括验证或分配失败；有错误时检查 `lastError()`，不要假定失败写入已经发布。

<a id="chapter-4"></a>
## 4. Flush 与状态

`hub.flush(timeoutMs=5000)` 返回布尔传输结果，可能在推进传输期间阻塞调用方。不要为每次高频传感器采样调用，也不要当作实时循环的时限保证。正常 `loop()` 会自动发布待发送数据。

`hub.status()`、`hub.instances()` 返回 `JsonDocument` 快照；`lastError()` 返回当前传输或 SDK 错误字符串。状态与值副本也会分配内存，不要为了显示少量字段而长期保留很多大快照。

暂停/恢复只保留当前 RAM 记录，不保存每一次离线写入。重启或开始新生命周期会丢失记录，在线副本是唯一恢复来源，详见[变量语义](variables.zh.md)。

<a id="chapter-5"></a>
## 5. TLS 设置

`server` 使用 TCP TLS 入口，`caCertificate` 填入可信 PEM 文本。固件必须通过自己的 SNTP 或 RTC 在 TLS 前建立有效 UTC 时间，`CLOCK_REQUIRED` 表示时钟未就绪。SDK 不配置全局 SNTP。

保持证书链、主机名与日期验证，`tlsFirst` 与监听模式匹配。Config 没有 WS/WSS 传输，也没有公开的客户端证书/私钥字段。不要把桌面的文件系统证书选项直接复制到固件配置中。

<a id="chapter-6"></a>
## 6. 内存与固件验收

共享 JSON 预算包含接收与合并临时对象。TLS、NATS 缓冲、map、应用数据和 Wi-Fi 还会消耗额外堆，SDK 同时保留 32 KiB 原生堆余量。JSON 预算和静态 RAM 都不等于总运行内存。

在重连、大消息与反复同步时测量 Flash、静态 RAM、空闲堆和最低空闲堆。优先使用数量有限的变量名和较小的当前值。删除保留标记，因此不断创建、删除唯一名称不能规避容量限制。

使用固定的 [PlatformIO 环境](https://github.com/skyboooox/KinopioHub.ino/blob/main/platformio.ini)与[实机检查](development.zh.md#esp32-hardware)。Wi-Fi 凭据和测试 CA 放在本地配置。第三方来源与补丁保留在 `src/vendor/espidf-nats/UPSTREAM.md`；SDK 没有 mesh 托管、持久化或 live 控制 API。
