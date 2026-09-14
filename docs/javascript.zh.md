# JavaScript

本手册：[安装与入门](javascript.zh.md) · [API 与配置参考](javascript-api.zh.md) · [变量语义](variables.zh.md) · [组网与状态](networking.zh.md) · [排错与迁移](troubleshooting.zh.md)

[English](javascript.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/KinopioHub.JS)

支持 Node.js 24+ 和现代浏览器。

本章目录

- [从源码开始](#chapter-1)
- [常用 API](#chapter-2)
- [连接已有服务器](#chapter-3)
- [浏览器与示例](#chapter-4)

<a id="chapter-1"></a>
## 从源码开始

在 `KinopioHub.JS` 中运行 `npm install`。先启动 `node examples/watch.mjs`，再在另一终端执行 `node examples/basic.mjs`。保持观察者运行，才能保留在线副本。

在其他应用中，从应用目录执行 `npm install /path/to/KinopioHub.JS` 安装当前源码，然后：

```js
import KinopioHub from 'kinopio-hub';

const hub = new KinopioHub('workshop');
try {
  const battery = hub.var('battery');
  battery.watch(value => console.log(value));
  await battery.set(80);
  await hub.flush();
} finally {
  await hub.close();
}
```

Node 会自动选择或启动局域网节点。首次可能下载固定版本的 NATS 执行文件，自动模式默认允许等待连接 60 秒。

> **注意：** 仅导入包不会启动节点。

<a id="chapter-2"></a>
## 常用 API

| 操作 | 含义 |
| --- | --- |
| `hub.var(name)` | 当前 Hub 内的稳定引用 |
| `variable.value` / `variable.meta` | 本地当前值和元数据 |
| `await variable.set(value)` / `delete()` | 更新内存，离线可用 |
| `variable.watch((value, meta) => {})` | 初始视图和后续变化，返回取消函数 |
| `await variable.ready({ timeout })` | 等待已知状态，也可能是已知不存在 |
| `await hub.connected({ timeout })` | 等待 NATS 连接 |
| `await hub.flush({ timeout })` | 发送当前记录并等待 NATS 传输 |
| `hub.status()` / `hub.watch(callback)` | 本地 SDK 状态，watch 返回取消函数 |
| `await hub.instances.list()` / `hub.instances.watch(callback)` | 观察到的 SDK 报告 |
| `await hub.close()` | 释放资源 |

`undefined` 表示本地没有可用值，JSON `null` 是有效值。`meta.exists` 为 `null` 表示未知，`false` 表示不存在，`true` 表示有值。

> **注意：** `pending` 表示待发布，不表示等待设备执行。`hub.ready()` 只等待本地初始化。回调应简短，可通过 `onCallbackError` 处理回调异常。

重复写入相同 JSON 仍会产生新版本，不提供持久化或历史。将变量用于控制前，先阅读[工作原理](architecture.zh.md)。

<a id="chapter-3"></a>
## 连接已有服务器

```js
const hub = new KinopioHub('demo', { servers: ['tls://nats.example.com:4222'],
  mesh: false,
  discovery: false,
  tls: { handshakeFirst: true },
});
```

仅对 TLS-first 服务器启用 `handshakeFirst`。凭据通过 `token`、`user`/`pass` 或 `authenticator` 配置，不放入 URL。Node 支持 TCP/TLS/WS/WSS；自定义客户端 TLS 和 authenticator 需要纯客户端模式。WSS 使用普通 CA 信任，不使用 TCP TLS 的自定义选项。

自动节点需要连接远端时，设置 `mesh: { upstreams: ['nats://nats.example.com:7422'] }`，并确保它是真正的 leaf 入口。组网使用 `mesh.group`；leaf TLS 使用 `mesh.upstreamTls`，字段为 `handshakeFirst`、`caFile`、`certFile`、`keyFile`。`discovery: false` 只关闭旧式入口提示，不关闭选举。

选项采用 camelCase，时间单位为**毫秒**。

| 常用参数 | 默认值 |
| --- | --- |
| `timeout`、`healthInterval`、`probeInterval` | `3000`、`5000`、`15000` |
| `maxVariables`、`maxMemoryBytes`、`maxInstances` | `10000`、`16777216`、`1024` |

省略 `peerTimeout` 时取 `timeout` 的 80%。显式等待超时优先于自动模式默认值。完整选项见 [TypeScript 声明](https://github.com/skyboooox/KinopioHub.JS/blob/main/types/index.d.ts)。

<a id="chapter-4"></a>
## 浏览器与示例

通过打包器使用相同 import，条件导出会选择浏览器传输。提供 WS/WSS 客户端入口，例如 `new KinopioHub('workshop', { servers: ['ws://127.0.0.1:9222'], discovery: false })`。浏览器不选举或托管节点。可选用 HTTP 发现清单；普通 NATS 服务器不会发布这种清单。

按 [Server 指南](server.zh.md)开启本地 WebSocket 监听，然后在 JS 仓库运行 `node examples/browser/serve.mjs`，打开打印的地址。HTTPS 页面需要可信 WSS。刷新页面会清空本地变量内存。

其他示例为 `examples/offline.mjs` 和 `examples/sdk-status.mjs`。示例接受 `KINOPIO_EXAMPLE_SERVERS`、`KINOPIO_TOKEN`、`KINOPIO_EXAMPLE_TLS_FIRST=1`、`KINOPIO_MESH=0` 和 `KINOPIO_LEAF_SERVERS`。测试命令见[开发说明](development.zh.md)。JavaScript 不提供 live 通道 API。

## 事件与请求

稳定引用也提供独立消息接口；发布事件不会写入当前值。连接成功后：

```js
const battery = hub.var('battery');
console.log(battery.get(0));
const subscription = await battery.sub(value => console.log(value));
const responder = await battery.handle(() => battery.get(0));
await battery.pub(80);
console.log(await battery.req());
await hub.drain({ timeout: 5000 });
```

`pub/sub/req` 分别是 `publish/subscribe/request` 的短名；空请求发送 JSON null。`get(fallback)` 只在未知或删除时使用默认值；`watchValue` 保留状态 watch 的时机与取消方式。

> **注意：** 事件不离线缓存、不重放。Node 与浏览器支持通配符、队列组、Headers 和有界 `requestMany`。浏览器在任一处理回调运行时保守拒绝 drain；拥有者应停止生产消息，等回调完成后调用 drain。

详细选项见 JavaScript API 手册。
