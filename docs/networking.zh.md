# 连接、mesh 与 SDK 状态

[English](networking.md) · [首页](wiki-home.md) · [排错](troubleshooting.zh.md)

本章目录

- [1. 选择连接模式](#chapter-1)
- [2. 直接连接](#chapter-2)
- [3. 自动局域网节点的生命周期](#chapter-3)
- [4. 将局域网节点接到远端系统](#chapter-4)
- [5. 下载、启动与关闭](#chapter-5)
- [6. 读取 SDK 状态](#chapter-6)

<a id="chapter-1"></a>
## 1. 选择连接模式

| 场景 | 配置 | 谁运行 broker |
| --- | --- | --- |
| 可信的小型局域网 | 默认 Node/Python/C++ Hub | SDK 选出的主机 |
| 已有 NATS 服务 | 显式 `servers`，关闭 mesh 与 discovery | 自己部署的 NATS |
| 局域网接入远端 NATS 系统 | 自动 mesh，加真实 leaf `upstreams` | 选出的本地主机与远端服务 |
| 浏览器或 ESP32 | 可达的客户端入口或支持的发现方式 | 其他主机；这两类 SDK 不托管节点 |

一个应用通常只需一个长期存活的 Hub。不同 namespace 或连接域可以使用不同 Hub，不必为每个变量创建一个 Hub。

<a id="chapter-2"></a>
## 2. 直接连接

JS、C++ 配置使用 camelCase，Python 使用 snake_case。JS/C++ 超时单位为毫秒，Python 为秒。

```js
const hub = new KinopioHub({
  namespace: 'workshop',
  servers: ['tls://nats.example.com:4222'],
  mesh: false,
  discovery: false,
  tls: { handshakeFirst: true },
});
await hub.connected();
```

`servers` 是**客户端入口**列表，备选入口应连向同一个逻辑 NATS 系统。在互不连接的 broker 之间切换，不会将它们连接起来，也不会让两边客户端自动交换记录。

TLS-first 表示先进行 TLS 握手，再接收 NATS INFO；INFO-then-TLS 是另一种服务端设置，必须使用匹配的握手选项。认证使用 `token` 或用户名/密码字段，不把凭据嵌入 URL。自定义 CA 和客户端证书选项与传输实现有关，应查阅对应 SDK 参考，不要直接复制其他语言的字段名。

| 运行环境 | 直连传输 | 说明 |
| --- | --- | --- |
| Node.js | TCP / TLS / WS / WSS | 自定义 TCP TLS 与 authenticator 要求仅客户端模式 |
| Python | TCP / TLS / WS / WSS | 自定义 TLS 要求仅客户端模式 |
| C++ | TCP / TLS | 使用官方 nats.c |
| 浏览器 | WS / WSS | HTTPS 页面需要可信 WSS |
| ESP32 | TCP / TLS | 提供 CA PEM 与有效 UTC 时间 |
| ROS | TCP / TLS | TLS YAML 必须有 `ca_file`；显式 servers 默认仅客户端 |

<a id="chapter-3"></a>
## 3. 自动局域网节点的生命周期

创建 Node/Python/C++ Hub 会启动自动模式，仅导入包不会启动。成员通过 IPv4 组播发现彼此并探测可达性，选举考虑网络质量和主机负载，通过连续检查与最短任期减少无意义切换。

当选主机启动普通 NATS Core 子进程，其他 SDK 使用该节点。相容 Hub 在一个进程内共享管理器，一台物理主机贡献一票。此模式面向小型局域网，每个管理器最多跟踪另外 32 个候选者。

主节点消失后，互相可达的参与者可以选择替代者。网络分区时，不同可达区域可以分别保持可用；恢复连通后收敛为一个主节点，允许短暂重叠。应用应能接受连接切换，并在恢复期间使用保留的 RAM 状态。

选举域由 group、认证和上游设置决定，namespace 不会拆分节点。需要共享节点的设备应使用等价的域设置。ESP32 虽然不投票，其发现配置也必须匹配该域。

托管节点的局域网客户端监听为明文，假设局域网可信。需要明确 TLS 策略时，应自行部署 broker 并使用仅客户端模式。SDK 不安装证书，也不修改防火墙。

<a id="chapter-4"></a>
## 4. 将局域网节点接到远端系统

```js
const hub = new KinopioHub({
  mesh: {
    group: 'workshop',
    upstreams: ['nats://nats.example.com:7422'],
  },
});
```

上游必须开放真实 NATS **leaf 监听**，普通客户端端口不能替代 leaf 端口。TLS 与 WSS leaf 模式同样需要上游提供对应支持。C++ 可以在这里使用 WS/WSS，因为 leaf 连接由托管的 NATS 执行文件处理。

JS/C++ 使用 `mesh.upstreamTls`，Python 使用 `mesh["upstream_tls"]` 配置 leaf 证书和握手模式。这些配置属于托管 broker 的上游连接，不是 SDK 自身的直连 TLS 配置。备选上游应属于同一系统，并采用相容的传输模式。

SDK 在应用带上游连接的本地节点前会检查真实 leaf 连通性，仅 TCP 端口可连接还不够。没有可用路径时，应检查状态和错误，不能假定本地与远端变量已经同步。监听示例见 [Server 章节](server.zh.md)。

<a id="chapter-5"></a>
## 5. 下载、启动与关闭

首次当选启动可能下载固定版本的 NATS 执行文件，并验证完整性。本地缓存只保存执行文件，不保存变量历史、当前值或 writer 身份。

不适合自动下载时，可用 `mesh.binary` 指向相容的本地执行文件。Node/Python/C++ 自动模式的连接等待默认允许 60 秒，显式参数可以覆盖。显式设置过短的超时可能在下载或选举结束前就返回超时。

`close()` 释放 SDK 资源及其共享节点管理器参与关系。SDK 只管理自己启动的进程，不终止外部管理的 NATS 服务。最后一个持有值的 SDK 关闭后，值仍会丢失，与 broker 是否继续运行无关。

<a id="chapter-6"></a>
## 6. 读取 SDK 状态

| 字段组 | 含义 |
| --- | --- |
| `instanceId`、`name`、`sdk`、`version`、`runtime` | 运行实例身份；重启后 `instanceId` 改变 |
| `connection`、`server`、`rttMs`、`reconnects` | SDK 传输状态与观察到的连接行为 |
| `variables`、`pendingVariables`、`pendingBytes` | 当前记录数量及待发布数据 |
| `sentMessages`、`receivedMessages`、`sentBytes`、`receivedBytes` | SDK 协议流量，不仅是业务流量，也不包含网络帧开销 |
| `health`、`currentError`、`lastError` | 当前健康评估与错误信息 |
| `mesh.role`、`leaderId`、`members`、`reason`、`upstreamConnected` | 支持自动节点时提供的组网状态 |

先用本地 `status()` 检查观察者自身。实例报告通常每五秒发送一次：远端 `online` 表示近期观察到报告，`offline` 表示报告过期，`unknown` 表示观察者自身断连，暂时无法判断。`fresh` 和 `lastSeen` 用于解释观察结果；报告不是永久设备注册表。

SDK 健康不测量电池、温度、机器人控制器就绪状态或命令执行结果。这些业务信息应作为变量上报。面板应同时显示观察者连接状态，避免面板断连时误认为所有设备都已断电。
