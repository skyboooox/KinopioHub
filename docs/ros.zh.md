# ROS 2

本手册：[安装与入门](ros.zh.md) · [API 与配置参考](ros-config.zh.md) · [变量语义](variables.zh.md) · [组网与状态](networking.zh.md) · [排错与迁移](troubleshooting.zh.md)

[English](ros.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/KinopioHub.ROS)

用一个 YAML 文件选择 ROS topic，通过 Python SDK 共享当前消息，反向控制按配置启用。尚未发布的 v3 桥接器需要 Python 3.10+，Docker 矩阵目标为 Humble、Jazzy、Kilted、Lyrical、Rolling。

本章目录

- [安装与运行](#chapter-1)
- [选择上行 topic](#chapter-2)
- [连接 TLS NATS](#chapter-3)
- [反向控制](#chapter-4)

<a id="chapter-1"></a>
## 安装与运行

将 `KinopioHub.py` 和 `KinopioHub.ROS` 放在同级目录。先 source ROS 环境和自定义消息工作区，再在 `KinopioHub.ROS` 执行：

```sh
python3 -m venv --system-site-packages .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ../KinopioHub.py -e .
cp config.example.yaml config.yaml
# Edit config.yaml before starting.
kinopio-hub-ros --config config.yaml --check-config
kinopio-hub-ros --config config.yaml
```

`rclpy`、`rosidl_runtime_py` 和消息包由 ROS 提供。YAML 在启动时读取，修改后需要重启。不支持 ROS 1、Service/Action 转发或 WS/WSS。

<a id="chapter-2"></a>
## 选择上行 topic

```yaml
robot: robot01
topics:
  - /battery
  - topic: /odom
    type: nav_msgs/msg/Odometry
    max_hz: 10
```

`robot` 选择 SDK scope，`/battery` 对应 `hub.scope("robot01").var("/battery")`。省略消息类型时从 ROS 自动发现，也能发现稍后启动的发布者。仅同步列表中的 topic。

| 路由可选字段 | 含义 |
| --- | --- |
| `type` | 显式指定 `package/msg/Message` 类型 |
| `variable` | 覆盖云变量名称 |
| `field` | 选择单个字段或点分隔的嵌套路径 |
| `max_hz` | 每个限频周期只保留最新样本，省略则不额外限频 |
| `qos` | `depth`、`reliability`（`best_effort` / `reliable`）、`durability`（`volatile` / `transient_local`） |

默认订阅兼容 best-effort 传感器发布者。每条路由只保留最新待发样本，不累积无限队列。

**YAML 负责配置桥接，不是数据来源。** 实际转换的是 ROS 消息到 JSON 值，例如 `std_msgs/msg/String` 变为 `{"data":"hello"}`。反向 JSON 控制会发布新的 ROS 消息，不会修改已经发布的消息。

<a id="chapter-3"></a>
## 连接 TLS NATS

在同一个 YAML 中加入：

```yaml
hub:
  namespace: robots
  servers: [tls://nats.example.com:4222]
  tls:
    ca_file: ./certs/ca.pem
    handshake_first: true
```

提供真实可信的 CA 文件，相对路径以 YAML 目录为基准。INFO-then-TLS 服务器设为 `handshake_first: false`。双向 TLS 使用 `cert_file` / `key_file`，鉴权使用 `token` 或 `user` / `password`。

显式 servers 默认纯客户端模式；省略 `hub` 则继承 Python 自动局域网节点行为。支持可信本地的 `nats://`，可通过布尔值 `hub.mesh` / `hub.discovery` 覆盖选择默认值。控制端必须使用相同 namespace，并接入互通的 NATS 拓扑。

<a id="chapter-4"></a>
## 反向控制

```yaml
controls:
  - topic: /target_mode
    type: std_msgs/msg/String
    mode: state
  - topic: /command
    type: std_msgs/msg/String
    mode: live
    timeout_ms: 300
```

控制必须指定消息类型并提供完整 JSON 消息。桥接器仅为这些配置的 topic 创建发布者，也可以创建原先不存在的 topic。远端 SDK 不能任意新增未配置 topic 或改变消息类型。原有 ROS 发布者独立存在，仍可能向同一 topic 发布。

**state** 表达期望值。在已连接的 Python Hub 中：

```python
robot = hub.scope("robot01")
status = robot.var("_bridge")
await status.ready()
if not isinstance(status.value, dict) or "control_session" not in status.value:
    raise RuntimeError("Bridge status is not available")
await robot.var("control/target_mode").set({
    "session": status.value["control_session"],
    "value": {"data": "manual"},
})
await hub.flush()
```

桥接连接变化会轮换 `control_session`。默认拒绝旧会话状态；当前会话的最新值等待匹配的 ROS 订阅者。state 没有 300 ms 有效期，也不接受 `timeout_ms`。只有可以安全恢复的期望状态才配置 `apply_existing: true`，它允许已有值并绕过会话检查。过期的状态报告可能导致写入被拒绝，是否重试应结合新报告和业务反馈判断。

**live** 使用独立的临时通道：`await hub.live("robot01/control/command").send({"data": "step"}, timeout=3)`。相同值的每次发送也是独立命令。租约拒绝旧连接、重复、乱序和过期命令，不缓存离线重放。每通道只部署一个接收者。`timeout_ms` 默认 300，live 路由必须使用 volatile 持久性。

桥接器最多支持 32 条 live 路由和 32 项命令队列，过载时丢弃较旧工作。单条负载上限 64 KiB。自定义/嵌套消息需安装相应 ROS 包；多余或缺失字段、非法范围、非有限数字和超出安全整数范围的整数值会被拒绝。

`_bridge` 报告路由计数、错误和控制会话，与 SDK 实例状态分开。`send()` / `flush()` 确认传输，不确认机器人执行。丢失命令时必须停止的机器人，需要本地控制器看护和明确的结果上报。

仓库的[配置](https://github.com/skyboooox/KinopioHub.ROS/blob/main/config.example.yaml)与[控制器示例](https://github.com/skyboooox/KinopioHub.ROS/blob/main/examples/controller.py)展示了对应路由。Docker 验证命令见[开发说明](development.zh.md#ros-docker)。
