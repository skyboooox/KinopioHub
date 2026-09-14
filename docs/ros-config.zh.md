# ROS YAML 与控制参考

[English](ros-config.md) · [入门](ros.zh.md) · [首页](wiki-home.md)

一个 YAML 选择上行 topic、反向发布与连接配置，桥接使用匹配的 Python SDK。容器配置覆盖 `linux/arm64`、`linux/amd64` 上的 Humble、Jazzy、Kilted、Lyrical、Rolling；可用验证命令及其原生或模拟执行方式见[开发说明](development.zh.md#ros-docker)。

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
| `hub` | Python SDK 默认行为 | 连接配置 |
| `topics` | 空列表 | ROS 到变量的上行白名单，最多 256 条 |
| `controls` | 空列表 | 变量/live 到 ROS 白名单，最多 256 条，其中 live 最多 32 条 |
| `health_variable` | `_bridge` | Hub namespace 下的桥接报告变量 |

> **注意：** 未知配置字段会被拒绝。topic 必须是绝对 ROS 名称，不接受替换或通配符。云名称遵循 SDK 的 UTF-8 长度与控制字符规则。两方向全部路由的 topic 和云变量名都必须唯一，变量也不能占用桥接健康变量名。

<a id="chapter-2"></a>
## 2. NATS 连接字段

namespace 仅在 `hub.namespace` 配置，省略时生成 UUID；旧 robot/name 字段被拒绝。不同机器人使用不同 namespace，或显式指定不重复的变量名。

`hub` 接受 `namespace`、`servers`、`tls`、`token`、`user`、`password`、`mesh`、`discovery`。这里的 `mesh`、`discovery` 是布尔值，不是完整 Python mesh 字典。

```yaml
hub:
  namespace: robot01
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
| `variable` | topic 名，包含开头斜杠 | Hub namespace 内的云变量名 |
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

示例将一个数值写入 `hub.var("temperature")`。没有 `field` 时写入完整消息对象。改变 `variable` 不会重命名 ROS topic。限频只保留最新待发送采样，不保留中间每一条消息。

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

默认向 Hub namespace 下的 `control/target_mode` 写入 `{"session":"...","value":{"data":"manual"}}`。session 从桥接报告的 `control_session` 取得，Python 调用见[入门示例](ros.zh.md#chapter-4)。

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

已连接 Python SDK 调用 `await hub.live("control/command").send({"data": "step"})`，namespace 与桥接一致。发送端 timeout 是传输等待，路由 `timeout_ms` 是接收租约有效期，二者不是同一设置。

> **注意：** live 拒绝旧会话、过期租约、重复和乱序命令，重连后不重放。桥接最多缓存 32 条 live 命令，过载时丢弃较旧工作，不是可靠任务队列。部署时每个通道仅一个接收者，durability 使用 volatile，避免 DDS 重放。

如果运动必须在命令中断时停止，应在机器人本地控制器实现停止/watchdog。传输超时或桥接命令过期都不会自动发布停止消息。

<a id="chapter-7"></a>
## 7. QoS 与可观察性

`qos.depth` 为 1–10,000，默认上行订阅为 1、控制为 10。reliability 接受 `best_effort` 或 `reliable`，控制默认 reliable，上行根据已发现发布者调整并兼容 best-effort 传感器。durability 接受 `volatile` 或 `transient_local`，默认 volatile。

显式指定 QoS 时应验证实际发布/订阅端相容性。发现成功和配置合法不证明 DDS 已交付。桥接运行中处理迟到发布者与类型发现，但缺失类型包仍需本地安装。

`_bridge` 报告路由数量/计数、错误与 `control_session`，SDK 实例健康另行报告底层连接。两者都不证明执行器完成，应通过上行 topic 发布应用结果。当前不提供 ROS 1、Action 转发、配置热加载或 WSS。

## 事件与服务

`topics`、`controls` 保留当前值与 live 语义。独立的 `events`、`services` 路由调用 Python SDK 稳定引用上的消息方法，不经过最新值合并队列、不写云变量、不重放离线事件。参见[消息语义](messaging.zh.md)。

```yaml
events:
  - ros_topic: /diagnostics_event
    channel: robot.diagnostics
  - ros_topic: /remote_notice
    type: std_msgs/msg/String
    channel: robot.notices.*
    direction: nats_to_ros
services:
  - ros_service: /enable_sensor
    type: std_srvs/srv/SetBool
    channel: robot.sensor.enable
    direction: nats_to_ros
  - ros_service: /remote_enable
    type: std_srvs/srv/SetBool
    channel: backend.enable
    direction: ros_to_nats
```

| 事件字段 | 含义 |
| --- | --- |
| `ros_topic`、`channel` | 必填，固定 ROS 端点与消息 channel |
| `direction` | 默认 `ros_to_nats`；入站必须显式 `nats_to_ros` |
| `type` | `package/msg/Message`；出站可从 ROS graph 发现唯一类型，入站必填 |
| `queue` | 可选入站 NATS 队列组，队列名称不允许通配符 |
| `headers` | 固定出站 ASCII Header 映射，值为字符串或非空字符串列表 |
| `pending_messages`、`pending_bytes` | 单路由已接受 FIFO 预算，默认 32 / 262,144，上限 256 / 1,048,576 |
| `qos` | `depth` 默认 32、上限 256；可靠性沿用现有 graph 感知策略，durability 只能为 `volatile` |

出站 channel 必须为具体名称；入站事件允许完整段 `*` 或末尾 `>`，始终投递到 YAML 指定的 ROS 类型和 topic。未发现或发现多个类型时报告路由错误，随后重试发现。JSON 事件必须包含完整且类型正确的 ROS 字段，未知字段、不安全整数与嵌套类型按现有反向控制转换规则验证。

重复的相同事件仍按 FIFO 投递，满载时丢弃新消息。每个方向另有 256 条 / 1 MiB 总预算，已取出但尚未完成的派发仍占预算。

> **注意：** channel、Header 计入桥接预算，SDK 与 DDS 队列另有各自上限。入站事件只发布一次，不等待 DDS 订阅者，QoS 为 volatile。断线或计划更换连接会丢弃旧代次排队事件，已经发生的副作用无法撤回。

| 服务字段 | 含义 |
| --- | --- |
| `ros_service`、`type`、`channel`、`direction` | 必填，绝对 service 名、`package/srv/Service`、具体 channel 与显式方向 |
| `direction: nats_to_ros` | 消息请求调用本地原生 ROS service，将完整响应作为 JSON 回复 |
| `direction: ros_to_nats` | 暴露原生 ROS service，调用远端 SDK responder 并验证完整响应类型 |
| `timeout_ms` | 本地操作总时限，默认 3,000 毫秒，范围 1–60,000 |
| `concurrency` | ROS-to-NATS 默认 4、范围 1–32；NATS-to-ROS 必须为 1，与 SDK 串行 handler 一致 |
| `queue` | 可选 NATS-to-ROS 队列组，用于等价桥接工作者，不自动添加 |
| `headers` | ROS-to-NATS 的固定请求头，或 NATS-to-ROS 的固定响应头 |

### 服务预算与就绪

入站服务的 SDK 订阅另限制每路由 32 条 / 256 KiB 已接受工作。最多 128 条消息路由，配置合计最多 64 个服务并发槽。

最多 64 个活动服务操作 / 1 MiB 请求数据和元信息。响应解析和 ROS 生成对象仍需要额外内存。

本地 service 在派发时必须就绪，否则本地失败且不编造响应。请求和响应都验证完整字段与嵌套类型。

executor 不阻塞等待 asyncio：原生 `call_async` 完成回调通知 asyncio Future；出站异步 ROS 回调等待由 SDK 线程完成的原生 `rclpy` Future。对公开 `Service.send_response` 的薄适配只消费本地失败标记，合法响应交回原生方法发送。

### 服务失败

> **注意：** 任意 ROS 类型没有统一错误通道，因此类型错误、无 responder、超时或断线只产生本地错误，**不发送 ROS 响应**。ROS 调用方应设置自己的有限等待时限。

后端失败不会终止 executor，也不会返回默认响应；后续请求仍可成功。合法的 `{success: false, ...}` 仍是普通业务响应。

超时或取消不撤销已开始的远端动作。

### Header 与路由隔离

操作等待期间保留内部 Header 元数据，固定出站名称统一小写，同一键的重复值保持顺序。

> **注意：** Header 不会自动映射到 ROS 字段。topic/service 名称与类型只来自 YAML，不由远端字段创建。

重复的 ROS topic（含状态、控制、事件组合）、重复 service 端点及方向相反的重叠 channel 会被拒绝，防止反馈循环；允许同方向事件汇入相同 channel。

### 启动与重连

启动不要求 broker 已可用。尚未建立的入站订阅由工作循环每秒最多重试一次；成功建立的订阅沿用 SDK 重连路径。

离线启动与关闭仍可响应，离线收到的事件会丢弃。

### 关闭与报告

关闭时先停止新操作，在持续运行 ROS executor 的同时，以统一五秒预算结束已接受的消息回调、服务、事件队列与 SDK 状态。

超时强制清理本地可控资源并报告失败，不能停止任意应用代码或远端动作。

`_bridge.messaging` 分别报告 FIFO 积压、字节、高水位、丢弃、活动服务、操作字节与聚合计数。`_bridge.errors` 最多包含 32 项，`errorCount` 给出总数；不从本地计数推断 DDS/broker/network 丢失。

[SDK 消息端示例](https://github.com/skyboooox/KinopioHub.ROS/blob/main/examples/messaging.py) 演示事件与双向 service。通用 `request_many` 留在 Python SDK，不把多个响应塞入单个 ROS 服务响应，不支持 ROS Actions。
