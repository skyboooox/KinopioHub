# Server

[English](server.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/Kinopio-server)

v3 SDK 使用普通 NATS Core 即可。`Kinopio-server` 是 [nats-io/nats-server](https://github.com/nats-io/nats-server) 的可选分支，用于更严格的订阅策略，不是变量存储或必须部署的状态服务。

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

该选项默认 false，作用于客户端订阅，不改变 NATS 通配符语法，也不能替代鉴权和 subject 权限。v3 已有前缀的 subject 不依赖此分支。运行中修改策略应通过受控重启应用；目前不声明这个自定义选项支持热重载。

<a id="chapter-2"></a>
## 构建与运行

在 `Kinopio-server` 中，使用 `go.mod` 声明的 Go 工具链：

```sh
go build -o nats-server .
./nats-server -t -c nats.conf
./nats-server -c nats.conf
```

先根据示例创建 `nats.conf`。当前源码跟随上游 `main`，使用 Kinopio 项目版本 `3.0.0`，上游基线为 `2.15.0-dev`；此项目版本不是上游 NATS 发行版本号，也不同于 SDK 自动节点固定使用的稳定版执行文件。

<a id="chapter-3"></a>
## 客户端与 leaf 监听

仅在本机实验时，普通 NATS 可以设置独立入口：

```conf
host: 127.0.0.1
port: 4222
leafnodes { host: 127.0.0.1; port: 7422 }
websocket { host: 127.0.0.1; port: 9222; no_tls: true }
```

客户端使用 `nats://127.0.0.1:4222` 或 `ws://127.0.0.1:9222`；SDK 托管的 leaf 可设置 `mesh.upstreams: ['nats://127.0.0.1:7422']`。回环地址只允许本机访问。远程部署需要合适的监听地址、鉴权和受信任的 TLS；WebSocket leaf 还要求该入口支持 leaf 协议。

完整部署选项见 [NATS 官方配置指南](https://docs.nats.io/running-a-nats-service/configuration)与 [leaf-node 指南](https://docs.nats.io/running-a-nats-service/configuration/leafnodes)。不能由客户端连接成功推断该端口也支持 leaf。

<a id="chapter-4"></a>
## 维护分支

`origin` 是 Kinopio 分支，`upstream` 是 NATS。先获取并审查上游，再合并。保留通配符选项及测试、Kinopio 项目版本、发布目标和手动工作流触发方式。上游修改打包时，也要保留定制发布镜像依赖的配置文件。

针对性检查：

```sh
go test ./server -run 'Test.*FirstWildcard|TestQueueSubscribePermissions|TestClientSubscribeDenyWildcardOverlapBlocksDelivery' -count=1
```

更广检查使用 `go vet ./...`、`go test ./...` 和上游 CI 测试分组。部分测试会在工作目录写临时文件或使用 syslog，应使用可写的临时源码副本。发布配置为 `.goreleaser.yml` 和 `docker/Dockerfile.release`。

贡献说明应包含具体改动和验证，并使用签署提交（`git commit -s`）。分支保留上游 Apache-2.0 许可证与第三方声明，见仓库的 `LICENSE` 和 `DEPENDENCIES.md`。上游设计资料仍在 [nats-architecture-and-design](https://github.com/nats-io/nats-architecture-and-design)。

Windows 证书存储测试的维护步骤见[上游 PKCS12 fixture 说明](https://github.com/nats-io/nats-server/blob/622457b6dfd5649fdc882cacb287528424762948/test/configs/certs/tlsauth/certstore/pkcs12.md)。通用 MQTT 行为仍参考 [NATS 官方 MQTT 指南](https://docs.nats.io/running-a-nats-service/configuration/mqtt)。
