# C++

本手册：[安装与入门](cpp.zh.md) · [API 与配置参考](cpp-api.zh.md) · [变量语义](variables.zh.md) · [组网与状态](networking.zh.md) · [排错与迁移](troubleshooting.zh.md)

[English](cpp.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/KinopioHub.cpp)

C++20 SDK 使用官方 NATS C 客户端处理 TCP/TLS，提供自动局域网节点和 RAII 清理。

> **注意：** 可在 macOS 或 Linux 上构建；不支持 Windows。

本章目录

- [从源码构建](#chapter-1)
- [常用 API](#chapter-2)
- [连接与选项](#chapter-3)

<a id="chapter-1"></a>
## 从源码构建

需要 CMake 3.24+、C++20 编译器、OpenSSL 和 libcurl。CMake 优先使用已安装且兼容的 NATS C 客户端与 nlohmann JSON，否则获取固定版本源码。

在 `KinopioHub.cpp` 中执行：

```sh
cmake -S . -B build-v3 -DBUILD_TESTING=ON
cmake --build build-v3 -j
./build-v3/kinopio_example_watch
# In another terminal:
./build-v3/kinopio_example_basic
```

应用可通过 `add_subdirectory()` 引入源码并链接 `KinopioHub::kinopiohub`。也可用 `cmake --install build-v3 --prefix /path/to/prefix` 安装，然后使用 `find_package(KinopioHub CONFIG REQUIRED)`。使用新的构建目录。

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
## 常用 API

| 操作 | 含义 |
| --- | --- |
| `hub.var(name)` | 可复制、指向稳定状态的句柄 |
| `variable.set(value)` / `erase()` | 更新内存，断网可用 |
| `variable.value()` | 返回 `std::optional<kinopio::Json>` 值副本 |
| `variable.meta()` | 初始化、存在性、版本和传输元数据 |
| `variable.watch(callback)` | `(std::optional<Json>, Json)` 快照，返回取消函数 |
| `variable.ready(timeout_ms)` | 等待已知状态，也可能是不存在 |
| `hub.connected(timeout_ms)` / `flush(timeout_ms)` | 等待连接 / 传输 |
| `hub.status()` / `hub.watch(callback)` | 本地 SDK 状态 |
| `hub.instances.list()` / `watch(callback)` | 观察到的 SDK 报告 |
| `hub.close()` | 显式清理，析构时也会关闭 |

空 optional 表示本地没有可用值；包含 `Json(nullptr)` 的 optional 是 JSON null。`Hub` 不可复制或移动，变量句柄不会让已关闭的 Hub 继续工作。

> **注意：** [内存和版本规则](architecture.zh.md)与其他 SDK 相同。

回调在产生事件的线程执行，包括网络后台线程，同一 Hub 内串行。回调应简短，应用共享数据需要自行同步。取消 watch 后，已经派发的回调仍可能完成一次。在回调内调用 `close()` 只请求关闭，不阻塞等待工作线程退出。

<a id="chapter-3"></a>
## 连接与选项

```cpp
kinopio::Hub hub("demo", {
    {"servers", {"tls://nats.example.com:4222"}},
    {"mesh", false},
    {"discovery", false},
    {"tls", {{"handshakeFirst", true}}}
});
```

仅对 TLS-first 服务器启用 `handshakeFirst`。直连支持 TCP/TLS，不支持 WS/WSS。鉴权使用独立的 `token` 或 `user`/`pass`，不放入 URL。自定义客户端 TLS 需要纯客户端模式，证书和主机名校验保持启用。

默认自动模式可通过托管 NATS Server 连接 WS/WSS **leaf** 上游：将真正的 leaf 入口写入 `mesh.upstreams`。

| 配置 | 用途 |
| --- | --- |
| `mesh.group` | 组网域 |
| `mesh.upstreamTls` | leaf TLS：`handshakeFirst`、`caFile`、`certFile`、`keyFile` |

详见 [Server 指南](server.zh.md)。

选项采用 camelCase，时间单位为**毫秒**。自动模式的 `connected()` 和 `flush()` 默认允许 60 秒，否则默认超时为 3 秒，显式超时优先。记录默认最多 10,000 个变量、16 MiB，观察到的实例最多 1,024 个。这些是数据容量，不是进程内存上限。

其他示例为 `kinopio_example_offline` 和 `kinopio_example_sdk_status`，接受 `KINOPIO_EXAMPLE_SERVERS`、`KINOPIO_TOKEN`、`KINOPIO_EXAMPLE_TLS_FIRST=1`、`KINOPIO_MESH=0`、`KINOPIO_LEAF_SERVERS`。测试见[开发说明](development.zh.md)。C++ 不提供 live 通道 API。

## 消息

状态与消息共用稳定变量句柄。`battery.pub(81)` 发送事件，不改变 `battery.get()`；`battery.sub(callback)` 接收业务数据，`battery.handle(callback)` 自动回复回调返回的 JSON。`battery.req().get()` 发送 JSON null 并等待一条 JSON 响应。

> **注意：** 请保留返回的 `Subscription`；最后一份句柄销毁时取消订阅，不隐式 drain。

`requestMany()` 有界收集多响应；`requestDetails()` / `requestManyDetails()` 返回类型明确的回复元数据。设备异步操作使用受 SDK 跟踪的 `handleDeferred()`。阻塞等待及 drain 须从 SDK 回调之外调用。消息回调不在 nats.c 投递线程执行，每个订阅串行，不同订阅可以并行。详见 [C++ API](cpp-api.zh.md#messages)与[共通消息语义](messaging.zh.md)。

构建并运行 `kinopio_example_messaging` 可查看状态、事件与请求的简短示例。消息操作需要活动连接，采用消息协议 1，RAM 状态协议 4 保持不变。
