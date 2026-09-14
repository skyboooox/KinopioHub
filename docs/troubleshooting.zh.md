# 故障排查与迁移

[English](troubleshooting.md) · [首页](wiki-home.md) · [组网](networking.zh.md)

本章目录

- [1. 从单条连接开始排查](#chapter-1)
- [2. TLS 与认证](#chapter-2)
- [3. 超时与重试](#chapter-3)
- [4. 内存与回调](#chapter-4)
- [5. ROS 路由与控制](#chapter-5)
- [6. 从旧 SDK 迁移](#chapter-6)
- [7. 提交可复现的问题](#chapter-7)

<a id="chapter-1"></a>
## 1. 从单条连接开始排查

1. 使用两个 SDK 进程、一个小 JSON 值和一个已知可达的 broker。
2. 保持 namespace 与变量名完全一致，检查两端本地状态。
3. 直连互通后，再逐项加入发现、自动节点或远端 leaf 链路。

| 现象 | 检查内容 | 下一步 |
| --- | --- | --- |
| `set()` 成功，另一台设备没有值 | 连接、namespace、名称和 broker 拓扑 | 等待连接，尝试 `flush()`，检查接收端错误 |
| `ready()` 返回，但没有值 | 是否存在的元数据 | 已知缺失也是有效结果，需要实际写入者 |
| 重启后值消失 | 是否还有 SDK 副本存活 | RAM 模式的正常行为；从存活副本恢复或重新初始化 |
| 较大数据无法同步 | 接收端限制与 broker payload 限制 | 缩小记录，或调整所有接收方适用的限制 |
| JSON 没变化仍回调 | 版本和元数据 | 同值写入和元数据变化都可能通知 |
| 多个自动节点长期存在 | group、认证、上游、组播和直接探测 | 统一域设置，恢复双向可达性 |
| 值已到达，但 `flush()` 超时或 pending 未清除 | 传输错误、PING/PONG 响应与 SDK 循环进度 | 继续处理 SDK 循环，保留错误并验证后续 flush；不能用值到达替代传输确认 |
| 所有设备都是 unknown | 观察者连接 | 先恢复观察者连接，再判断远端在线情况 |
| 节点已运行，远端值却不过来 | 真实 leaf 连接和权限 | 使用 leaf 监听，不能拿客户端端口替代 |

<a id="chapter-2"></a>
## 2. TLS 与认证

| 检查项 | 重点 |
| --- | --- |
| 证书 | 主机名、证书链、日期与握手模式 |
| 域名与 IP | 域名证书不一定能验证 IP 地址 |
| ESP32 时钟 | TLS 前建立有效 UTC 时间 |
| ROS CA 路径 | 相对 YAML 文件解析 |
| ROS `--check-config` | 检查配置，不证明服务器可达 |

认证成功不代表 SDK 所有消息都有权限。状态更新、对等查询、回复和健康流量都需要相应 NATS 权限。应根据报告的 subject 权限错误定位问题，不要通过直接取消认证来掩盖问题。

浏览器应检查页面协议和 WebSocket 入口。HTTPS 页面需要 WSS，并遵循浏览器正常证书信任规则。C++、ESP32、ROS 应使用 TCP/TLS 客户端入口，而不是 WSS URL。

<a id="chapter-3"></a>
## 3. 超时与重试

超时限制的是等待时间，不一定撤回此前的 RAM 写入，也无法收回已经传输的消息。决定重试前，应检查值、版本、连接与应用反馈。

重试 `set()` 即使 JSON 相同也会创建新版本，再次 live 发送则是另一条命令。业务上要求去重时，应携带应用自己的请求 ID 并上报结果状态。

自动启动可能包含执行文件下载和选举，不要无意中把直连用的短超时应用到这个阶段。JS/C++ 使用毫秒，Python 使用秒，明确以 `_ms` 结尾的字段除外。

### 消息失败

| 错误或现象 | 下一步 |
| --- | --- |
| `NO_RESPONDERS` | 在相同 namespace 启动匹配的 `handle` 或能够回复的订阅者。 |
| 请求超时 | 重试前检查处理者与应用结果；远端可能已经开始执行。 |
| `INVALID_TOPIC` | 发布/请求使用具体名称；只有支持模式的 `sub`/`handle` 接受通配符。 |
| `SLOW_CONSUMER` | 缩短 handler 或降低输入速率；调整限额前先看积压与丢弃。 |
| `BUFFER_OVERFLOW` | 检查请求/收集与字节预算；接口提供时查看有界部分结果。 |
| `DISCONNECTED` / `DRAINING` | 新消息需要有效连接，不排队等待重放。 |
| `DRAIN_TIMEOUT` | 检查仍在处理的工作；关闭结果不保证设备执行完成。 |

详见[消息语义与限制](messaging.zh.md#chapter-5)。

<a id="chapter-4"></a>
## 4. 内存与回调

记录限制包括删除元数据。不断创建新的唯一变量名，最终会耗尽容量；当前状态应尽量使用数量有限的变量引用。JSON 数据预算不是整个进程或固件的堆上限。

**回调保持简短。**

| 运行环境 | 回调规则 |
| --- | --- |
| Python | 状态 watch 要求同步回调；自行安排后台工作并限制积压 |
| C++ | 回调可能运行在工作线程，须保护共享数据 |
| ESP32 | 频繁调用 `loop()`；长任务、阻塞等待和大量串口输出都会延迟同步 |

<a id="chapter-5"></a>
## 5. ROS 路由与控制

上行数据缺失时，检查 topic 是否存在、类型包是否安装并 source、QoS 是否匹配。`field` 从 ROS 消息选取字段，不是把 YAML 文件当作遥测发送。修改云变量名称不会重命名 ROS topic。

| 被拒绝的操作 | 检查内容 |
| --- | --- |
| state 控制 | 新鲜的 `_bridge.control_session`、完整类型的 `{session, value}` 消息，以及匹配的 ROS 订阅者 |
| live 控制 | 接收者在线、租约有效期和队列压力 |

> **执行证据：** NATS 发送成功不能证明 ROS 已发布或机器人已经动作。

同一个 topic 不能同时出现在上行和控制路由中，变量重名或占用桥接健康变量名也会被拒绝。这些检查用于避免映射歧义与反馈环路。

<a id="chapter-6"></a>
## 6. 从旧 SDK 迁移

**当前 SDK 使用状态协议 4、业务消息协议 1。** 旧 SDK 或带 `scope` 的协议记录不兼容。

1. 一起升级所有 SDK，包括固件、ROS 的 Python 依赖、Web 的 JavaScript 依赖。
2. 更新 NATS 权限，覆盖两段数据主题、`_sys.v4` 控制、`_msg.v1` 消息及原生回复 inbox 主题。
3. 停止旧实例，由应用初始化当前 RAM 状态；没有磁盘数据需要迁移。

| 旧用法或假设 | 当前方式 |
| --- | --- |
| `getScope()` / `getVariable()` | `hub.var(name)` |
| `new KinopioHub({namespace, name})` | `new KinopioHub(namespace, options)`；状态使用 instanceId、namespace |
| `scope(s).var(v)` | 选择一个扁平变量名；需要防止冲突时显式使用 `s/v` 等前缀 |
| 省略 namespace 共享 default | 省略时生成独立 UUID，互通须显式共享 namespace |
| 独立 leaf runtime 或节点 CLI | 在 Hub 上配置自动节点 |
| 重启后恢复持久值和原 writer | 新身份、空 RAM，只能从在线副本恢复 |
| `synced()` 或外部状态服务 | 本地写入，加可选的传输 `flush()` |
| 将 request/reply 当作 live 控制 | 使用 Python live 或明确配置的 ROS 控制 |
| 使用 scope 和原始 subject 的 Web 配置 | 使用浏览器 SDK，显式配置共享 namespace 和变量名；区分 RAM 状态与事件、请求 |

<a id="chapter-7"></a>
## 7. 提交可复现的问题

| 提供内容 | 示例 |
| --- | --- |
| 环境 | SDK/运行时版本、操作系统、ESP32 板型或 ROS 发行版 |
| 连接 | 直连、自动局域网节点或 leaf 上游，以及脱敏配置 |
| 复现 | 准确变量名和最小程序 |
| 结果 | 预期行为、实际状态与错误 |

删除凭据与私有入口。实现问题提交到对应 SDK 仓库，跨语言问题提交到 [KinopioHub](https://github.com/skyboooox/KinopioHub/issues)。测试命令见[开发说明](development.zh.md)。
