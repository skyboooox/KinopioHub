# C++ API 参考

[English](cpp-api.md) · [入门](cpp.zh.md) · [首页](wiki-home.md)

包含 `<kinopio/kinopio.hpp>`，链接 `KinopioHub::kinopiohub`。`kinopio::Json` 是 `nlohmann::ordered_json`，`kinopio::VERSION` 提供 SDK 版本。内部使用官方 NATS C 客户端。

本章目录

- [1. 接入 CMake](#chapter-1)
- [2. Hub 与所有权](#chapter-2)
- [3. 参数与 TLS](#chapter-3)
- [4. 变量与快照](#chapter-4)
- [5. 回调线程与清理](#chapter-5)
- [6. 状态与错误](#chapter-6)

<a id="chapter-1"></a>
## 1. 接入 CMake

使用相邻的源码目录：

```cmake
cmake_minimum_required(VERSION 3.24)
project(my_device LANGUAGES C CXX)
add_subdirectory(../KinopioHub.cpp kinopio-build)
add_executable(my_device main.cpp)
target_link_libraries(my_device PRIVATE KinopioHub::kinopiohub)
```

也可安装 SDK，将安装前缀加入 `CMAKE_PREFIX_PATH`，使用 `find_package(KinopioHub CONFIG REQUIRED)`。CMake 传递公开的 C++20 与 JSON 要求；OpenSSL、libcurl、nats.c 仍是构建/链接依赖。可在 macOS 或 Linux 上构建；不支持 Windows。构建命令见[入门](cpp.zh.md)。

<a id="chapter-2"></a>
## 2. Hub 与所有权

| 方法 | 结果 |
| --- | --- |
| `Hub()` / `Hub(namespace, Json options = Json::object())` | 启动 SDK 与后台工作线程 |
| `ready()` | `Hub&`，本地就绪 |
| `connected(int timeout_ms = 0)` | `Hub&`，等待连接 |
| `flush(int timeout_ms = 0)` | `void`，等待 NATS 传输 |
| `var(const std::string&)` | Variable 句柄 |
| `status()` | JSON 快照 |
| `watch(std::function<void(Json)>)` | 本地状态的 `Stop` 函数 |
| `close()` | 显式清理 |

省略 namespace 的 `Hub()` 生成 UUID；`namespaceName()` 返回只读实际 namespace，生成 namespace 并传高级配置时用 `Hub(std::nullopt, options)`；options 不接受 namespace 或 name。Hub 不可复制、不可移动，析构时自动关闭。Variable 句柄可以复制，引用 Hub 的共享状态；保留句柄不会让已经关闭的 Hub 继续工作。需要时应先显式 flush，RAII 清理不是执行确认。

等待方法同步阻塞调用线程。超时为零表示选择配置默认值，不是无限等待。自动连接/flush 默认 60,000 毫秒，仅客户端模式默认 3,000 毫秒；构造或单次调用中的显式超时覆盖适用默认值。

<a id="chapter-3"></a>
## 3. 参数与 TLS

配置为 JSON 对象，使用 camelCase 与**毫秒**。常规计时/容量必须是实现支持范围内的正整数。

| 参数 | 默认值与含义 |
| --- | --- |
| `servers` | TCP/TLS 客户端 URL 字符串或数组 |
| `mesh` | 默认启用，接受 `false` 或 mesh 对象 |
| `discovery` | false 关闭入口提示，不关闭 mesh |
| `token`、`user`、`pass` | 客户端认证 |
| `tls` | `caFile`、`certFile`、`keyFile`、`handshakeFirst`，仅客户端模式 |
| `timeout`、`peerTimeout` | `3000`；对等等待默认为 timeout 的 80%（`2400`） |
| `healthInterval`、`probeInterval` | `5000`、`15000` |
| `maxVariables`、`maxMemoryBytes`、`maxInstances` | `10000`、`16777216`、`1024` |
| `selection` | `improvementMs`、`improvementRatio`、`cooldownMs` 调整客户端切换 |
| `mesh.group`、`mesh.binary`、`mesh.upstreams` | 域、可选执行文件、真实 leaf 备选入口 |
| `mesh.upstreamTls` | leaf 的 `caFile`、`certFile`、`keyFile`、`handshakeFirst` |

```cpp
kinopio::Hub hub("workshop", {
    {"mesh", false},
    {"discovery", false},
    {"servers", {"tls://nats.example.com:4222"}},
    {"tls", {{"caFile", "ca.pem"}, {"handshakeFirst", true}}}
});
```

CA 文件是本地路径，双向 TLS 需同时提供客户端证书和私钥。直连 WS/WSS 会被拒绝；WS/WSS leaf 上游由托管的 NATS 执行文件处理。配置远端上游前阅读[组网](networking.zh.md)。

<a id="chapter-4"></a>
## 4. 变量与快照

| 方法 | 返回与含义 |
| --- | --- |
| `hub.var(name)` | Variable 句柄 |
| `set(const Json&)` | `void`，验证并更新 RAM |
| `erase()` | `void`，带版本删除 |
| `value()` | 按值返回 `std::optional<Json>` |
| `meta()` | 初始化、存在性、版本、待发布和连接元数据 JSON |
| `ready(int timeout_ms = 0)` | `Variable&`，等待本地状态初始化 |
| `watch(callback)` | `Stop`，回调接受 `std::optional<Json>, Json` |

```cpp
auto battery = hub.var("battery");
battery.ready();
if (auto value = battery.value()) {
    std::cout << value->dump() << '\n';
}
battery.set(nullptr);
battery.erase();
```

片段假设已包含 `<iostream>` 并有存活的 Hub。空 optional 表示本地无值，JSON null 则是非空 optional 中的值。检查 `meta()["exists"]` 可区分初次查询未完成与缺失。读取或编辑返回快照不会写回变量。

名称为 1–128 个 UTF-8 字节，不能含控制字符。协议 4 将 namespace 和变量名各自编码为 UTF-8 十六进制 token；状态记录主题为 `<namespace-token>.<variable-token>`，SDK 控制主题为 `_sys.v4.<namespace-token>`。这些是内部协议细节，应用仍应通过 `hub.var(name)` 访问变量。

<a id="chapter-5"></a>
## 5. 回调线程与清理

`kinopio::Stop` 是 `std::function<void()>`，调用后注销监听。同一个 Hub 的回调串行执行，但可能运行于发起操作的线程或后台网络线程。应用共享数据必须同步，不能假定回调位于 UI 主线程。

回调保持简短，将阻塞业务工作交给其他执行位置。停止监听不会取消已经派发的回调。在回调中 `close()` 会请求关闭，但不等待工作线程结束；正常关闭应由应用的所有者上下文完成。

捕获应用对象时应明确其生命周期，把停止函数与订阅消费者一起保存。如果回调需要应用锁，不要在持有同一把锁时跨 SDK 操作，以免互相等待。

<a id="chapter-6"></a>
## 6. 状态与错误

`hub.instances.list()` 同步返回 JSON 报告列表，`hub.instances.watch(std::function<void(Json)>)` 返回停止函数。本地 `status()` 与远端报告遵循 [SDK 状态语义](networking.zh.md#6-读取-sdk-状态)。

`kinopio::Error` 继承 `std::runtime_error`，通过 `.code` 获取错误码，通过 `what()` 获取消息。常见情况包括参数/值无效、容量耗尽、超时、Hub 已关闭、不支持的传输。也可能出现其他 C++/JSON 异常，应使用正常应用异常处理。

C++ 没有 live API、持久化或历史。多写入者与离线行为见[变量章节](variables.zh.md)，连接诊断见[排错](troubleshooting.zh.md)。

<a id="messages"></a>
## 消息、类型明确的结果与关闭

完整名称与短名复用同一实现：`publish/pub` 返回 `void`；`subscribe/sub` 与 `handle` 返回可复制的 `Subscription`。它们均由 `hub.var(name)` 调用，不创建或修改 RAM 状态。

`get()` 返回 `std::optional<Json>`，`get(fallback)` 用同一个加锁快照判断缺失；null、false、0 与空值不会使用默认值。`watchValue(callback)` 只传 optional JSON，保留原 watch 的触发时机与停止函数。

| 请求方法 | 操作句柄中的结果类型 |
| --- | --- |
| `request(data = nullptr, RequestOptions = {})` / `req(...)` | `Json` |
| `requestDetails(...)` | `Reply {data, headers}` |
| `requestMany(data = nullptr, RequestOptions = {})` | `std::vector<Json>` |
| `requestManyDetails(...)` | `Replies {std::vector<Reply> replies, reason}` |

操作句柄提供非阻塞 `ready()`、`cancel()`、`partialReplies()` 以及阻塞的 `get()`。失败抛出 `RequestError`，其 `partialReplies` 保存有界的已收回复。`RequestOptions.timeout` 默认总期限 3000 毫秒，`maxReplies` 默认 16，`maxBytes` 默认 1 MiB；后两项可减小。

> **注意：** 单答超时为 `TIMEOUT`；多答到期可成功返回空数组，结束原因是 `deadline` 或 `maxReplies`。无兴趣的原生 503 为 `NO_RESPONDERS`；首答 JSON 非法立即失败。请求不自动重发，取消本地等待不撤销远端副作用。

事件回调可写 `(const Json&)` 或 `(const Json&, const MessageContext&)`。上下文自有 `topic` 与 `headers`，`reply(data, MessageOptions)` 可在回调运行期间显式回复多次；没有回复主题时为 `NO_REPLY_SUBJECT`。回调返回后保留的上下文不可继续回复。

`handle` 使用 `(const Json&) -> Json` 或 `(const Json&, HandleContext&) -> Json`，返回的 JSON 自动回复。`return nullptr` 表示 JSON null；设置 `context.replyHeaders` 可附带响应头。上下文不提供手动 reply。回调异常只记录本地 `HANDLER_ERROR`，不将异常文本发送给请求方；普通无回复主题的事件不会调用 handle。

```cpp
kinopio::SubscribeOptions options;
options.queue = "equivalent-workers";
auto responder = hub.var("lamp").handle(
    [](const kinopio::Json &data, kinopio::HandleContext &context) {
        context.replyHeaders = kinopio::Headers{{"X-Service", "lamp"}};
        return kinopio::Json{{"ok", true}, {"on", data.at("on")}};
    }, options);
auto response = hub.var("lamp").requestDetails({{"on", true}}).get();
auto service = response.headers.get("x-service");
```

### Headers

`Headers` 接受键值对初始化列表或字符串/字符串数组组成的 JSON 对象。

| 规则 | 行为 |
| --- | --- |
| 查询 | `get()` 返回首值，`getAll()` 返回全部值，均大小写无关 |
| 条目 | `add()` 保留重复值；`entries()` 展示保存的键名拼写 |
| 出站规范化 | 键名小写，值两端 ASCII 空格去除；内部空格和同键值顺序保留 |
| 限制 | ASCII token 键、可见 ASCII 值、4096 编码字节、32 项、64 KiB 结构合法 JSON |

依赖首尾空格的数据放 JSON。Headers 与 payload 还共同受 broker `max_payload` 限制。

### 延迟回复

异步设备操作使用 `handleDeferred`，回调签名为 `(const Json&, const HandleContext&, DeferredReply)`。应用保留该句柄后调用一次 `complete(data, MessageOptions)` 或 `cancel()`。

| 条件 | 结果 |
| --- | --- |
| 已完成或连接代次失效 | `complete()`、`cancel()` 返回 false |
| 最后一份句柄销毁 | 取消未完成回复 |
| 回调和延迟操作均结束 | SDK 停止跟踪完成状态 |

SDK 不隐式等待脱离的外部操作。应用仍须管理设备任务的线程与生命周期，旧句柄不能转用新连接。

请保留订阅句柄；最后一份 `Subscription` 销毁时取消订阅，不隐式 drain。临时 Variable 句柄结束不影响保留的订阅。注册会在有界的 SUB/flush 完成后返回，默认上限 3000 毫秒，`ready()` 可读取状态。`unsubscribe()` 丢弃未派发消息，仍在运行的回调继续计入容量。`subscription.drain(timeout_ms = 5000)` 在同一期限内先清空原生投递，再处理 SDK 已接收工作。

### 容量

| 范围 | 限制 |
| --- | --- |
| 单个订阅 | 一个受管回调或延迟操作；默认 256 条 / 1 MiB |
| 可降低的订阅限制 | `SubscribeOptions.maxPendingMessages` / `.maxPendingBytes`，最小 2 条 / 3 字节 |
| 原生预留 | 最多 16 条 / 72 KiB，另有有界接收复制空间 |
| Hub | 4096 条 / 8 MiB；128 个订阅；64 个请求 |
| 出站缓冲 | 1 MiB |

原生预留可能使混合分配在达到数量上限前失败。回复收集和运行中回调共享总预算；这些是原始数据核算限制，不是进程堆上限。

`subscription.status()` 提供积压、进行中回调、SDK/原生丢弃、高水位、当前 `slow` 与有效限制。`hub.status().messaging` 和健康报告仅带阶段与聚合计数。`SLOW_CONSUMER` 表示本地过载，网络或 broker 丢失不能由这些计数推断。

### 回调与关闭

消息回调不在 nats.c 投递线程执行，每订阅串行、跨订阅可并行。共享应用对象需要同步。

| 场景 | 行为 |
| --- | --- |
| 回调内 `get()`、连接等待、flush 或 drain | `BLOCKING_IN_HANDLER` |
| 回调内 drain | `DRAIN_IN_HANDLER` |
| `hub.drain(timeout_ms = 5000)` | 拒绝新消息和状态写入（`DRAINING`），保留已接受回复至截止；超时关闭传输并抛出 `DRAIN_TIMEOUT` |
| 计划交接 | 旧业务兴趣先撤销，旧代次工作最多 5000 毫秒；超时回复失效，随后激活新连接且不重放事件 |

它无法强制停止任意业务代码。`close()` / 析构 join 自有后台资源，不无限等待非 SDK 拥有的业务回调。

主题模式、queue、命名空间、权限及投递边界见[共通消息指南](messaging.zh.md)。RAM 状态协议仍为 4，独立消息协议为 1。
