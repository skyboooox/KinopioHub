# Server

[English](server.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/Kinopio-server)

**Kinopio-server 是可选组件。** SDK 可以使用普通 NATS Core，变量保存在 SDK RAM。

它基于 [nats-io/nats-server](https://github.com/nats-io/nats-server)，增加更严格的订阅策略；不提供变量存储、状态服务或历史服务。

本章目录

- [分支特有的订阅规则](#chapter-1)
- [构建与运行](#chapter-2)
- [客户端与 leaf 监听](#chapter-3)
- [维护分支](#chapter-4)

<a id="chapter-1"></a>
## 分支特有的订阅规则

在 NATS 配置中启用：

```conf
port: 4222
authorization {
  reject_first_wildcard: true
}
```

| 订阅 | 启用选项后的行为 |
| --- | --- |
| `>` / `*` / `*.battery` | 拒绝 |
| `devices.>` / `devices.*` / `devices.battery` | 此规则允许，仍需通过普通权限检查 |

| 选项行为 | 规则 |
| --- | --- |
| 默认值 | `false` |
| 范围 | 客户端订阅 |
| 应用修改 | 重启服务 |
| 权限 | 仍遵守普通 NATS 认证与主题权限 |

它不修改通配符语法；带前缀的 SDK 主题不依赖此 fork。

SDK 的消息模式保留固定的 `_msg.v1` 前缀，回复使用 `_INBOX`，因此 `hub.var('sensor.*').sub(...)` 等接口可以与该规则共用。仍需单独配置对应的发布、订阅与回复权限，队列组不会绕过权限。

<a id="chapter-2"></a>
## 构建与运行

在 `Kinopio-server` 中，使用 `go.mod` 声明的 Go 工具链：

```sh
go build -o nats-server .
./nats-server -t -c nats.conf
./nats-server -c nats.conf
```

启动可访问的 server 前，先创建并检查 `nats.conf`。此分支不同于 SDK 自动节点使用的固定可执行文件。

<a id="chapter-3"></a>
## 客户端与 leaf 监听

仅在本机实验时，配置独立入口：

```conf
host: 127.0.0.1
port: 4222
leafnodes { host: 127.0.0.1; port: 7422 }
websocket { host: 127.0.0.1; port: 9222; no_tls: true }
```

| 连接 | 本机入口 |
| --- | --- |
| 浏览器客户端 | `ws://127.0.0.1:9222` |
| 原生客户端 | `nats://127.0.0.1:4222` |
| 托管 leaf | `mesh.upstreams: ['nats://127.0.0.1:7422']` |

> **仅限本机的示例：** 这些监听不能从其他设备访问。客户端 URL 不能证明该端口接受 leaf 连接。

ESP32 与 ROS 使用 TCP/TLS，不使用 WS/WSS。远端部署须明确绑定地址、认证与可信 TLS。

完整部署选项见 [NATS 官方配置指南](https://docs.nats.io/running-a-nats-service/configuration)与 [leaf-node 指南](https://docs.nats.io/running-a-nats-service/configuration/leafnodes)。

<a id="chapter-4"></a>
## 维护分支

`origin` 是 Kinopio 分支，`upstream` 是 NATS。先获取并审查上游修改，再合并。保留通配符选项及测试、发布目标和手动工作流触发方式；上游修改打包时，一并审查分支的 release Dockerfile 配置。

| 发布字段 | 格式 |
| --- | --- |
| 二进制版本 | `<已合入的上游版本>+kinopio.<修订号>` |
| Git 标签 | 二进制版本前加 `v` |
| Docker 标签 | 将 Git 标签中的 `+` 替换为 `-` |

保留上游的 `dev`、`RC` 等预发布标识。Kinopio 后缀用于区分分支构建，不改变 [SemVer 版本优先级](https://semver.org/#spec-item-10)；SDK 版本及其固定的 NATS 执行文件分别维护。

针对性检查：

```sh
go test ./server -run 'Test.*FirstWildcard|TestQueueSubscribePermissions|TestClientSubscribeDenyWildcardOverlapBlocksDelivery' -count=1
```

更广检查使用 `go vet ./...`、`go test ./...` 和上游 CI 测试分组。部分测试写临时文件或需要 syslog，应使用可写的临时检出。分支保留上游 Apache-2.0 许可证与第三方声明，见 `LICENSE` 和 `DEPENDENCIES.md`。
