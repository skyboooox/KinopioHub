# C++ API 参考

[English](cpp-api.md) · [入门](cpp.zh.md) · [首页](wiki-home.md)

对应尚未发布的 3.0.0。包含 `<kinopio/kinopio.hpp>`，链接 `KinopioHub::kinopiohub`。`kinopio::Json` 是 `nlohmann::ordered_json`，`kinopio::VERSION` 提供 SDK 版本。内部使用官方 NATS C 客户端。

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

也可安装 SDK，将安装前缀加入 `CMAKE_PREFIX_PATH`，使用 `find_package(KinopioHub CONFIG REQUIRED)`。CMake 传递公开的 C++20 与 JSON 要求；OpenSSL、libcurl、nats.c 仍是构建/链接依赖。Linux 是待运行验收的源码目标，Windows 尚未实现。构建命令见[入门](cpp.zh.md)。

<a id="chapter-2"></a>
## 2. Hub 与所有权

| 方法 | 结果 |
| --- | --- |
| `Hub(Json options = Json::object())` | 启动 SDK 与后台工作线程 |
| `ready()` | `Hub&`，本地就绪 |
| `connected(int timeout_ms = 0)` | `Hub&`，等待连接 |
| `flush(int timeout_ms = 0)` | `void`，等待 NATS 传输 |
| `scope(const std::string&)` | Scope 句柄 |
| `status()` | JSON 快照 |
| `watch(std::function<void(Json)>)` | 本地状态的 `Stop` 函数 |
| `close()` | 显式清理 |

Hub 不可复制、不可移动，析构时自动关闭。Scope、Variable 句柄可以复制，引用 Hub 的共享状态；保留句柄不会让已经关闭的 Hub 继续工作。需要时应先显式 flush，RAII 清理不是执行确认。

等待方法同步阻塞调用线程。超时为零表示选择配置默认值，不是无限等待。自动连接/flush 默认 60,000 毫秒，仅客户端模式默认 3,000 毫秒；构造或单次调用中的显式超时覆盖适用默认值。

<a id="chapter-3"></a>
## 3. 参数与 TLS

配置为 JSON 对象，使用 camelCase 与**毫秒**。常规计时/容量必须是实现支持范围内的正整数。

| 参数 | 默认值与含义 |
| --- | --- |
| `namespace`、`name` | namespace 默认 `"default"`，name 为显示标签 |
| `servers` | TCP/TLS 客户端 URL 字符串或数组 |
| `mesh` | 默认启用，接受 `false` 或 mesh 对象 |
| `discovery` | false 关闭入口提示，不关闭 mesh |
| `token`、`user`、`pass` | 客户端认证 |
| `tls` | `caFile`、`certFile`、`keyFile`、`handshakeFirst`，仅客户端模式 |
| `timeout`、`peerTimeout` | `3000`；对等等待默认为 timeout 的 80% |
| `healthInterval`、`probeInterval` | `5000`、`15000` |
| `maxVariables`、`maxMemoryBytes`、`maxInstances` | `10000`、`16777216`、`1024` |
| `selection` | `improvementMs`、`improvementRatio`、`cooldownMs` 调整客户端切换 |
| `mesh.group`、`mesh.binary`、`mesh.upstreams` | 域、可选执行文件、真实 leaf 备选入口 |
| `mesh.upstreamTls` | leaf 的 `caFile`、`certFile`、`keyFile`、`handshakeFirst` |

```cpp
kinopio::Hub hub({
    {"namespace", "workshop"},
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
| `scope.var(name)` | Variable 句柄 |
| `set(const Json&)` | `void`，验证并更新 RAM |
| `erase()` | `void`，带版本删除 |
| `value()` | 按值返回 `std::optional<Json>` |
| `meta()` | 初始化、存在性、版本、待发布和连接元数据 JSON |
| `ready(int timeout_ms = 0)` | `Variable&`，等待本地状态初始化 |
| `watch(callback)` | `Stop`，回调接受 `std::optional<Json>, Json` |

```cpp
auto battery = hub.scope("devices").var("battery");
battery.ready();
if (auto value = battery.value()) {
    std::cout << value->dump() << '\n';
}
battery.set(nullptr);
battery.erase();
```

片段假设已包含 `<iostream>` 并有存活的 Hub。空 optional 表示本地无值，JSON null 则是非空 optional 中的值。检查 `meta()["exists"]` 可区分初次查询未完成与缺失。读取或编辑返回快照不会写回变量。

<a id="chapter-5"></a>
## 5. 回调线程与清理

`kinopio::Stop` 是 `std::function<void()>`，调用后注销监听。同一个 Hub 的回调串行执行，但可能运行于发起操作的线程或后台网络线程。应用共享数据必须同步，不能假定回调位于 UI 主线程。

回调保持简短，将阻塞业务工作交给其他执行位置。停止监听不会取消已经派发的回调。在回调中 `close()` 会请求关闭，但不等待工作线程结束；正常关闭应由应用的所有者上下文完成。

捕获应用对象时应明确其生命周期，把停止函数与订阅消费者一起保存。如果回调需要应用锁，不要在持有同一把锁时跨 SDK 操作，以免互相等待。

<a id="chapter-6"></a>
## 6. 状态与错误

`hub.instances.list()` 同步返回 JSON 报告列表，`hub.instances.watch(std::function<void(Json)>)` 返回停止函数。本地 `status()` 与远端报告遵循 [SDK 状态语义](networking.zh.md#6-读取-sdk-状态)。

`kinopio::Error` 继承 `std::runtime_error`，通过 `.code` 获取错误码，通过 `what()` 获取消息。常见情况包括参数/值无效、容量耗尽、超时、Hub 已关闭、不支持的传输。也可能出现其他 C++/JSON 异常，应使用正常应用异常处理。

C++ 没有 live API、持久化、历史或独立 leaf runtime API。多写入者与离线行为见[变量章节](variables.zh.md)，连接诊断见[排错](troubleshooting.zh.md)。
