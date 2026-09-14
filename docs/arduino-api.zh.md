# ESP32 API 与资源参考

[English](arduino-api.md) · [入门](arduino.zh.md) · [首页](wiki-home.md)

Arduino ESP32 SDK 仅作为客户端，Wi-Fi、时间初始化与应用循环由固件负责，不下载或运行 broker。

本章目录

- [1. 初始化与循环归属](#chapter-1)
- [2. 完整 Config 字段](#chapter-2)
- [3. 变量方法](#chapter-3)
- [4. Flush 与状态](#chapter-4)
- [5. TLS 设置](#chapter-5)
- [6. 内存与固件验收](#chapter-6)
- [7. 消息、请求与 drain](#7-消息请求与-drain)

<a id="chapter-1"></a>
## 1. 初始化与循环归属

### Hub 生命周期

使用 `kinopio::Hub hub("workshop")`，或使用 `Hub()` 生成 UUID；通过 `namespaceName()` 读取不可变的 namespace。

默认 UUID 在首次读取或调用 `begin()` 时生成，后续 `begin()` 不改变该 namespace。Config 不包含 namespace 或显示 name。

### 启动与循环

配置 Wi-Fi 后调用 `hub.begin(config)`，并在一个 Arduino 任务中频繁调用 `hub.loop()`。`begin()` 返回 `bool`。

server 为空时启动发现，显式指定时尝试连接。发现初始化返回 true，不代表 broker 已连接。

> **注意：** 连接状态另看 `hub.connected()`。不要反复 `begin()` 作为重连方式，它会开始一个记录为空的新生命周期。`disconnect()` 暂停传输并保留 RAM，`reconnect()` 恢复传输，`close()` 释放 SDK 状态。变量句柄不能比其 Hub 活得更久。

普通 Wi-Fi 断连通过之后的循环继续处理。长时间阻塞业务会延迟接收、待发布记录、对等修复和健康报告。没有应用归属设计时，不要从多个 FreeRTOS 任务并发操作 SDK。

<a id="chapter-2"></a>
## 2. 完整 Config 字段

所有时长为**毫秒**，未特别说明的大小单位为字节。

| 字段 | 默认值 | 用途 |
| --- | --- | --- |
| `server` | 空 | 发现节点；否则为一个 `nats://` 或 `tls://` 客户端 URL |
| `group` | `"default"` | 发现域 group |
| `upstreams` | 空 vector | 匹配待发现 mesh 域的上游配置，不托管 broker |
| `token` | 空 | token 认证 |
| `user`、`password` | 空 | 用户名与密码 |
| `caCertificate` | 空 | 可信 CA 的 PEM 文本，不是文件名 |
| `tlsFirst` | `true` | TLS-first；false 为 INFO-then-TLS |
| `maxVariables` | `32` | 稳定名称引用容量，以及单独核算的当前记录容量（包含删除标记） |
| `maxMemoryBytes` | `65536` | 共享 JSON 分配预算 |
| `maxValueBytes` | `8192` | 单个 JSON 值上限 |
| `maxMessageBytes` | `16384` | NATS payload 缓冲上限 |
| `healthInterval` | `5000` | 健康报告周期 |
| `peerTimeout` | `2400` | 对等查询计时 |
| `syncInterval` | `15000` | 当前状态修复周期 |

> **注意：** `maxMessageBytes` 不得超过 16,384，并且至少为 `maxValueBytes + 1024`，因此只增大值上限会导致配置验证失败。`syncInterval` 至少为 `peerTimeout`，容量和时长必须为支持范围内的正值。先保持默认值，再根据测量调整。

<a id="chapter-3"></a>
## 3. 变量方法

| 方法 | 结果与含义 |
| --- | --- |
| `hub.var(name)` | 变量句柄 |
| `set(value)` | ArduinoJson 相容数据的布尔 RAM 写入结果 |
| `setValue(JsonVariantConst)` | 从 JSON 视图写入自有快照 |
| `setJson(text)` | 解析、验证并写入 JSON |
| `erase()` | 带版本删除 |
| `value()` / `get()` / `get(fallback)` | 自有本地 JSON 快照 |
| `exists()` / `pending()` | 存在性 / 待发布标记 |
| `versionCounter()` / `versionWriter()` | 当前版本字符串 |
| `watch(callback)` / `watchValue(callback)` | 监听 ID，注册失败为零 |
| `unwatch(id)` | 移除该监听 |

### 值的所有权

`set()` 与 `setValue()` 保留自有 JSON 快照，包括 ArduinoJson 链接到调用方静态数组的嵌套字符串。成功写入后，输入可以修改或释放。

`value()`、`get()` 返回自有 `JsonDocument` 副本。`get(fallback)` 仅在未知或删除、没有当前值时使用默认值；null、false、零和空值仍是有效值，默认值不会写入或发送。

### 监听与错误

`watchValue([](JsonVariantConst value) { ... })` 适配同步 watch。它每次调用读取一个自有快照，返回的监听 ID 仍用 `unwatch()` 取消；回调视图只在本次调用有效。

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

此片段在初始化后运行。watch 接受变量引用，触发时同步执行，包括注册时的初次调用，回调应保持简短。

> **注意：** 与桌面 SDK 不同，没有变量 `ready()` 或三态 `meta`；`exists()==false` 只说明本地当前无值，不证明所有副本都为空。

`exists()` 为 true 时，JSON null 也是存在的值。读取返回副本，修改后需显式写入。

> **注意：** false 结果可能包括验证或分配失败；有错误时检查 `lastError()`，不要假定失败写入已经发布。

<a id="chapter-4"></a>
## 4. Flush 与状态

`hub.flush(timeoutMs=5000)` 返回布尔传输结果，可能在推进传输期间阻塞调用方。不要为每次高频传感器采样调用，也不要当作实时循环的时限保证。正常 `loop()` 自动发布待发送数据，并查询自身 PONG 回执，不执行阻塞 flush。认证与订阅就绪也由 loop 查询回执，旧心跳 PONG 不能确认新写入。底层套接字操作和业务回调仍有各自的执行耗时。

`hub.status()` 返回本地 `JsonDocument` 快照，基础客户端没有 `instances()` API；`lastError()` 返回当前传输或 SDK 错误字符串。状态与值副本也会分配内存，不要为了显示少量字段而长期保留很多大快照。

暂停/恢复只保留当前 RAM 记录，不保存每一次离线写入。重启或开始新生命周期会丢失记录，在线副本是唯一恢复来源，详见[变量语义](variables.zh.md)。

<a id="chapter-5"></a>
## 5. TLS 设置

`server` 使用 TCP TLS 入口，`caCertificate` 填入可信 PEM 文本。固件必须通过自己的 SNTP 或 RTC 在 TLS 前建立有效 UTC 时间，`CLOCK_REQUIRED` 表示时钟未就绪。SDK 不配置全局 SNTP。

保持证书链、主机名与日期验证，`tlsFirst` 与监听模式匹配。Config 没有 WS/WSS 传输，也没有公开的客户端证书/私钥字段。不要把桌面的文件系统证书选项直接复制到固件配置中。

<a id="chapter-6"></a>
## 6. 内存与固件验收

共享 JSON 预算包含接收与合并临时对象。TLS、NATS 缓冲、map、应用数据和 Wi-Fi 还会消耗额外堆，SDK 同时保留 32 KiB 原生堆余量。JSON 预算和静态 RAM 都不等于总运行内存。

在重连、大消息与反复同步时测量 Flash、静态 RAM、空闲堆和最低空闲堆。优先使用数量有限的变量名和较小的当前值。删除保留标记，因此不断创建、删除唯一名称不能规避容量限制。

Wi-Fi 与 TLS 仍占固件的较大部分，默认应用分区为 1.25 MiB。加入传感器驱动和应用逻辑后，应检查最终固件大小，并按应用容量与 OTA 需求选择分区。实机检查使用的较大测试分区不适合作为 OTA 部署分区。

使用固定的 [PlatformIO 环境](https://github.com/skyboooox/KinopioHub.ino/blob/main/platformio.ini)与[实机检查](development.zh.md#esp32-hardware)。Wi-Fi 凭据和测试 CA 放在本地配置。第三方来源与补丁保留在 `src/vendor/espidf-nats/UPSTREAM.md`；SDK 没有 mesh 托管、持久化或 live 控制 API。

## 7. 消息、请求与 drain

基础客户端在稳定的 `hub.var(name)` 引用上提供精确话题消息，不修改当前值或版本。名称使用共通的 UTF-8 十六进制编码；业务订阅不接受 `*`、`>` 模式。状态名称仍将这些字符作为字面内容。

| API | 结果 |
| --- | --- |
| `publish(data)` / `pub(data)` | 在线有界传输接受结果，返回 bool |
| `subscribe(handler)` / `sub(handler)` | 返回 `Subscription`；回调收到 JSON，可选第二参数 `MessageContext&` |
| `handle(handler)` | 返回 `Subscription`；处理函数返回 `JsonDocument`，可选第二参数 `HandlerContext&` |
| `request(data, onReply, RequestOptions)` / `req(...)` | 返回 `Request`；回调收到 `(JsonVariantConst data, const std::string& error)` |
| `req(onReply)` | 省略正文时发送 JSON null |
| `Request::cancel()` / `pending()` | 本地取消 / 查询进度 |
| `Subscription::status()` / `unsubscribe()` | 查看就绪与积压 / 停止投递并丢弃排队工作 |
| `Hub::drain(callback, timeout=5000)` | 在总期限内结束已接受工作与待发送状态、确认传输并关闭 |

### 就绪与请求

持续调用 `hub.loop()`。返回订阅句柄后，需等 `subscription.status().ready` 为 true；订阅就绪应与 Hub 连接状态分别检查。

首次注册遇到断连或就绪超时会关闭。已建立的订阅在重连期间保留句柄，收到传输确认后重新就绪。

`RequestOptions` 只有 `timeout`，默认 3,000 毫秒。空错误字符串表示成功，JSON 视图只在本次回调有效。

> **注意：** 迟到回复不能复活已结束请求；取消和超时不撤销远端操作，SDK 不自动重试。

### 处理函数返回与上下文

普通 `handle` 返回值成为唯一响应，空文档回复 JSON null；没有回复地址的事件不会调用该处理函数。

异步操作通过 `auto completion = context.defer()` 获取句柄。稍后在同一 Arduino 任务调用 `completion.complete(data)` 或 `completion.fail()`；完成只接受一次，断线或关闭后失效。

跨回调保留输入时复制到自有文档。`MessageContext` 提供 `topic`、单次 `reply(data)` 和 `defer()`；`HandlerContext` 提供 `topic()` 与 `defer()`，没有手动回复。

### 不支持的消息功能

> **注意：** 不提供公开 Headers、队列组、多响应收集、详细结果或订阅级 drain。

底层有界校验原生 Headers，包括 broker 的 `NO_RESPONDERS` 状态，丢弃应用元数据；设备所需信息放入 JSON。设备可调用桌面端队列服务，也可向桌面端的 `requestMany` 回复一次。

| `Config.messaging` 字段 | 默认 | 上限 |
| --- | ---: | ---: |
| `subscriptions` | 16 | 16 |
| `requests` | 4 | 4 |
| `pendingMessages` | 16 | 32 |
| `pendingBytes` | 16384 | 32768 |
| `payloadBytes` | 1024 | 8192 |

### 队列预算

容量必须为正数。每订阅最多接受两条投递 / 4,096 字节，包含执行中或延迟完成的处理函数。

总预算还包括请求回复。subject、回复地址和原生 Headers 均计入字节，提高 payload 设置不能突破订阅字节预算。

原生 Headers 限制为 1,024 字节 / 16 项。三个状态订阅、十六个业务订阅和四个 inbox 在原生订阅限制内。

队列满时丢弃新投递，保留已接受的 FIFO 顺序，报告 `SLOW_CONSUMER` 和丢弃计数；inbox 溢出使该请求失败。

每轮最多派发四条消息，派发预算十毫秒。阻塞的应用代码仍可能超出该预算；保留的 JSON、TLS 与原生缓冲另外占用堆。

### Drain 与重连

由应用拥有者调用 Hub drain，不在受管处理函数内调用。它拒绝新写入、停止订阅兴趣、结束已接受工作并关闭；超时报告 `DRAIN_TIMEOUT`。`close()` 立即停止。

普通重连会重新建立订阅，旧响应句柄失效。没有离线事件队列、请求重放或端到端 exactly-once 保证。

本地订阅状态包含就绪、积压、执行中工作、丢弃和错误；`hub.status().messaging` 提供当前聚合值，不含高水位。定期远端心跳不发送消息诊断或流量统计，只保留实例 ID、namespace、SDK/版本、连接与健康，有错误时附带 `currentError`。其他 SDK 可以观察该心跳，ESP32 自身不保存其他设备的健康列表。
