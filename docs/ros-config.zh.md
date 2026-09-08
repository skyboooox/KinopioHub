# ROS YAML 与控制参考

[English](ros-config.md) · [入门](ros.zh.md) · [首页](wiki-home.md)

对应尚未发布的 3.0.0。一个 YAML 选择上行 topic、反向发布与连接配置，桥接使用匹配的 Python SDK。配置的 Docker 矩阵覆盖 Humble、Jazzy、Kilted、Lyrical、Rolling，执行与验证边界见[开发说明](development.zh.md#ros-docker)。

本章目录

- [1. 配置生命周期](#chapter-1)
- [2. NATS 连接字段](#chapter-2)
- [3. 上行 topic 字段](#chapter-3)
- [4. 反向控制字段](#chapter-4)
- [5. State 会话与订阅者就绪](#chapter-5)
- [6. Live 命令有效期](#chapter-6)
- [7. QoS 与可观察性](#chapter-7)

<a id="chapter-1"></a>
## 1. 配置生命周期

```sh
kinopio-hub-ros --config config.yaml --check-config
kinopio-hub-ros --config config.yaml
```

第一条命令解析并验证配置，不证明 TLS 连通、消息包可用、DDS 匹配或机器人行为。启动前 source ROS 与自定义消息工作区。配置只加载一次，修改后重启桥接。

| 顶层字段 | 默认值 | 含义 |
| --- | --- | --- |
| `robot` | `robot01` | 此桥接的 SDK 变量 scope |
| `hub` | Python SDK 默认行为 | 连接配置 |
| `topics` | 空列表 | ROS 到变量的上行白名单，最多 256 条 |
| `controls` | 空列表 | 变量/live 到 ROS 白名单，最多 256 条，其中 live 最多 32 条 |
| `health_variable` | `_bridge` | robot scope 下的桥接报告变量 |

未知配置字段会被拒绝。topic 必须是绝对 ROS 名称，不接受替换或通配符。云名称遵循 SDK 的 UTF-8 长度与控制字符规则。两方向全部路由的 topic 和云变量名都必须唯一，变量也不能占用桥接健康变量名。

<a id="chapter-2"></a>
## 2. NATS 连接字段

`hub` 接受 `namespace`、`name`、`servers`、`tls`、`token`、`user`、`password`、`mesh`、`discovery`。这里的 `mesh`、`discovery` 是布尔值，不是完整 Python mesh 字典。

```yaml
robot: robot01
hub:
  namespace: robots
  servers: [tls://nats.example.com:4222]
  tls:
    ca_file: ./certs/ca.pem
    handshake_first: true
topics:
  - /battery
```

显式 `servers` 包含 1–32 个 TCP/TLS 客户端 URL，不接受 WS/WSS 或 URL 内嵌凭据。指定 servers 后，`mesh`、`discovery` 默认 false；省略 `hub` 则继承 Python 自动局域网模式。可信本地场景也支持 `nats://`。

TLS 必须提供 `ca_file`；双向 TLS 同时提供 `cert_file` 与 `key_file`。路径相对 YAML 所在目录解析。`handshake_first` 默认 true，仅 INFO-then-TLS 监听设置 false。桥接配置不允许关闭证书验证。

<a id="chapter-3"></a>
## 3. 上行 topic 字段

`- /battery` 这种字符串条目自动发现消息类型。需要控制云名称、频率与字段时使用映射。

| 字段 | 必填与默认 | 含义 |
| --- | --- | --- |
| `topic` | 必填 | 绝对 ROS topic |
| `type` | 可选 | `package/msg/Message`，未填则从 ROS 图发现 |
| `variable` | topic 名，包含开头斜杠 | `robot` scope 内的云变量名 |
| `field` | 完整消息 | 一个字段或点分隔的嵌套路径 |
| `max_hz` | 不额外限速 | `(0, 1000]` 范围内的有限频率 |
| `qos` | 运行时相容默认值 | 深度、可靠性、持久性 |

```yaml
topics:
  - topic: /temperature
    type: sensor_msgs/msg/Temperature
    variable: temperature
    field: temperature
    max_hz: 2
```

示例将一个数值写入 `hub.scope("robot01").var("temperature")`。没有 `field` 时写入完整消息对象。改变 `variable` 不会重命名 ROS topic。限频只保留最新待发送采样，不保留中间每一条消息。

YAML 只配置路由，数据来自 ROS 消息并转为 JSON。例如 `std_msgs/msg/String` 对应 `{"data":"hello"}`，只有 `field: data` 才取出字符串 `"hello"`。嵌套消息与数组保留对应结构。二进制/图像可能超过 64 KiB payload 边界，桥接不是大体积媒体传输通道。

<a id="controls"></a>
<a id="chapter-4"></a>
## 4. 反向控制字段

| 字段 | 必填与默认 | 含义 |
| --- | --- | --- |
| `topic` | 必填 | 要发布的 ROS topic |
| `type` | 必填 | 完整 ROS 消息类型 |
| `variable` | `control` 加 topic | 云状态名称，或 live 通道名的一部分 |
| `mode` | `state` | `state` 或 `live` |
| `apply_existing` | `false` | 仅 state：允许恢复已有期望值并绕过会话检查 |
| `timeout_ms` | live 为 `300` | 仅 live，1–60,000 毫秒整数 |
| `qos` | 发布者默认值 | live 必须使用 volatile durability |

controls 不接受 `field` 或 `max_hz`。值必须是完整类型 ROS 消息，不能缺少字段、包含未知字段、超出类型范围或使用不支持的数值。自定义消息包必须在本地安装并 source。

配置控制路由会创建 ROS publisher，即使该 topic 之前不存在。它发布新消息，不能编辑已发布消息、改变另一发布者的类型，或由远端请求任意创建 topic。

<a id="chapter-5"></a>
## 5. State 会话与订阅者就绪

```yaml
controls:
  - topic: /target_mode
    type: std_msgs/msg/String
    mode: state
```

默认向 robot scope 下的 `control/target_mode` 写入 `{"session":"...","value":{"data":"manual"}}`。session 从桥接报告的 `control_session` 取得，Python 调用见[入门示例](ros.zh.md#chapter-4)。

连接变化会轮换 session，旧会话的值被拒绝。同一当前会话内，最新期望值可以等待匹配的 ROS 订阅者。state 没有 300 毫秒过期，不能配置 `timeout_ms`。

`apply_existing: true` 会明确绕过会话检查，允许恢复已有期望值。只用于恢复后仍安全的状态，不要用来掩盖旧会话错误。此选项不会增加持久化存储。

<a id="chapter-6"></a>
## 6. Live 命令有效期

```yaml
controls:
  - topic: /command
    type: std_msgs/msg/String
    mode: live
    timeout_ms: 300
```

已连接 Python SDK 调用 `await hub.live("robot01/control/command").send({"data": "step"})`，namespace 与桥接一致。发送端 timeout 是传输等待，路由 `timeout_ms` 是接收租约有效期，二者不是同一设置。

live 拒绝旧会话、过期租约、重复和乱序命令，重连后不重放。桥接最多缓存 32 条 live 命令，过载时丢弃较旧工作，不是可靠任务队列。部署时每个通道仅一个接收者，durability 使用 volatile，避免 DDS 重放。

如果运动必须在命令中断时停止，应在机器人本地控制器实现停止/watchdog。传输超时或桥接命令过期都不会自动发布停止消息。

<a id="chapter-7"></a>
## 7. QoS 与可观察性

`qos.depth` 为 1–10,000，默认上行订阅为 1、控制为 10。reliability 接受 `best_effort` 或 `reliable`，控制默认 reliable，上行根据已发现发布者调整并兼容 best-effort 传感器。durability 接受 `volatile` 或 `transient_local`，默认 volatile。

显式指定 QoS 时应验证实际发布/订阅端相容性。发现成功和配置合法不证明 DDS 已交付。桥接运行中处理迟到发布者与类型发现，但缺失类型包仍需本地安装。

`_bridge` 报告路由数量/计数、错误与 `control_session`，SDK 实例健康另行报告底层连接。两者都不证明执行器完成，应通过上行 topic 发布应用结果。当前不提供 ROS 1、Service/Action 转发、配置热加载或 WSS。
