# JavaScript API 参考

[English](javascript-api.md) · [入门](javascript.zh.md) · [首页](wiki-home.md)

对应尚未发布的 3.0.0。使用 Node.js 24+，或配合打包器的现代浏览器。包提供默认与具名 `KinopioHub` 导出、`KinopioError` 和 TypeScript 声明。本章只介绍公开 API，不将内部协议工具作为接口。

本章目录

- [1. 创建与关闭 Hub](#chapter-1)
- [2. 构造参数](#chapter-2)
- [3. Scope 与 Variable](#chapter-3)
- [4. 监听与清理](#chapter-4)
- [5. SDK 状态与实例观察](#chapter-5)
- [6. 错误与传输边界](#chapter-6)
- [7. 浏览器与当前边界](#chapter-7)

<a id="chapter-1"></a>
## 1. 创建与关闭 Hub

```js
import KinopioHub, { KinopioError } from 'kinopio-hub';

const hub = new KinopioHub({ namespace: 'workshop', name: 'monitor' });
try {
  await hub.connected();
  console.log(hub.status());
} finally {
  await hub.close();
}
```

构造时启动本地初始化与连接管理。`ready()` 返回 `Promise<this>`，等待本地初始化；`connected({ timeout })` 返回 `Promise<this>`，等待有效连接。`flush({ timeout })` 和 `close()` 返回 `Promise<void>`。只读 `instanceId` 标识本次生命周期，`state` 表示本地连接状态。

应用运行期间应保留 Hub。短示例发送后关闭，退出后不会继续保留在线副本。`close()` 只是资源清理，不隐含持久化，也不保证待发送值到达其他 SDK；需要传输确认时先调用 `flush()`。

<a id="chapter-2"></a>
## 2. 构造参数

时长单位为**毫秒**，常规计时与容量参数要求正整数。多数应用只需设置 namespace 和所选连接模式。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `namespace` | `"default"` | 共享数据命名空间 |
| `name` | 运行时生成的显示名称 | 便于识别的 SDK 名称，不是持久身份 |
| `servers` | 按运行环境与模式选择 | 客户端 URL 字符串或数组 |
| `mesh` | Node 中启用 | `false` 表示仅客户端；对象配置 group、执行文件与 leaf |
| `discovery` | 启用 | 入口提示；`{url}` 可指定 HTTP 发现清单 |
| `token` | 未设置 | token 认证 |
| `user`、`pass` | 未设置 | 用户名与密码 |
| `authenticator` | 未设置 | NATS 认证回调，Node 仅客户端模式 |
| `tls` | 未设置 | Node TCP TLS 参数，仅客户端模式 |
| `timeout` | `3000` | 常规等待超时；显式设置也会覆盖连接等待 |
| `peerTimeout` | `timeout` 的 80%，至少 1 | 初次对等发现等待 |
| `healthInterval` | `5000` | SDK 报告周期 |
| `probeInterval` | `15000` | 连接质量探测周期 |
| `maxVariables` | `10000` | 记录及引用容量 |
| `maxMemoryBytes` | `16777216` | 记录数据预算 |
| `maxInstances` | `1024` | 观察到的 SDK 报告容量 |
| `selection` | SDK 策略 | `improvementMs`、`improvementRatio`、`cooldownMs` 调整入口切换 |
| `onCallbackError` | 未设置 | 应用回调错误处理器 |

未设置 `timeout` 时，Node 自动模式的连接/flush 等待允许 60 秒。单次调用的超时覆盖适用默认值。`selection` 调整客户端入口切换，不是替换 mesh 投票逻辑的公开 API。

`mesh` 接受 `group`、`binary`、`upstreams`、`upstreamTls`。后者接受 `caFile`、`certFile`、`keyFile`、`handshakeFirst`。域匹配与 leaf 前提见[组网](networking.zh.md)。仅设置 `discovery: false` 不会关闭 mesh 选举。

<a id="chapter-3"></a>
## 3. Scope 与 Variable

`hub.scope(name)` 返回稳定的 Scope，具有只读 `name`；`scope.var(name)` 返回当前 Hub 内的稳定 Variable。TypeScript 可以使用 `scope.var<number>('battery')`；泛型表达预期类型，不会把收到的未知 JSON 自动验证为应用数据结构。

| 成员 | 返回 | 行为 |
| --- | --- | --- |
| `name`、`scopeName` | 字符串 | 引用名称 |
| `value` | JSON 或 `undefined` | 本地值副本 |
| `meta` | `VariableMeta` | 初始化、存在性、版本与发布状态 |
| `set(value)` | `Promise<void>` | 验证并更新 RAM |
| `delete()` | `Promise<void>` | 写入带版本的删除记录 |
| `watch(callback)` | 停止函数 | 观察 `(value, meta)` 快照 |
| `ready({timeout})` | `Promise<this>` | 等待此变量本地初始化 |

`meta` 包含 `initialized`、`exists`、`version`、`pending`、`connected`。`exists` 未知时为 `null`，缺失为 `false`，存在为 `true`；已有的 `version` 包含字符串 `counter` 与 `writer`。`pending` 跟踪发布，不表示设备完成。

```js
const battery = hub.scope('devices').var('battery');
await battery.ready();
if (battery.meta.exists === true) console.log(battery.value);
await battery.set(null);
console.log(battery.meta.exists); // true
await battery.delete();
```

JSON 验证拒绝非有限数、不安全整数值、循环引用、稀疏数组、getter 与非普通对象。类实例应显式转换为普通数据。设置默认值或处理并发更新前，先阅读[变量语义](variables.zh.md)。

<a id="chapter-4"></a>
## 4. 监听与清理

```js
const battery = hub.scope('devices').var('battery');
const stop = battery.watch((value, meta) => {
  console.log(value, meta.pending);
});
await battery.set(80);
stop();
```

变量已初始化时，注册 watch 会提供初始快照；否则等待初始化。之后的通知可能反映元数据变化，也可能反映值版本变化。回调保持简短，用 `onCallbackError` 处理失败；不要认为回调抛错会撤销已经完成的写入。UI 或消费者销毁时停止监听。

<a id="chapter-5"></a>
## 5. SDK 状态与实例观察

`hub.status()` 同步返回本地快照；`hub.watch(callback)` 观察本地 SDK 状态并返回停止函数。`await hub.instances.list()` 返回已观察到的报告，`hub.instances.watch(callback)` 观察当前报告列表并返回停止函数。

```js
const stop = hub.instances.watch(instances => {
  for (const instance of instances) {
    console.log(instance.name, instance.online, instance.health);
  }
});
// Call stop() during cleanup.
```

连接、新鲜度与错误字段的解释见 [SDK 状态](networking.zh.md#6-读取-sdk-状态)。实例报告不包含业务值，也不是永久设备注册表。

<a id="chapter-6"></a>
## 6. 错误与传输边界

捕获 `KinopioError` 后读取 `code`；也可能出现其他运行时或传输错误。常见 SDK 错误码有 `INVALID_OPTIONS`、`INVALID_NAME`、`INVALID_VALUE`、`MEMORY_FULL`、`MESSAGE_TOO_LARGE`、`TIMEOUT`、`DISCONNECTED`、`CLOSED`。后台错误检查 `status().currentError`，最近记录的错误检查 `lastError`。

`flush()` 失败不会撤销已成功的本地 `set()`，重试 `set()` 会生成新版本。超时与大数据问题见[排错](troubleshooting.zh.md)。

<a id="chapter-7"></a>
## 7. 浏览器与当前边界

通过打包器导入包，让 browser 条件导出选择 WebSocket 传输。提供 WS/WSS 客户端入口，浏览器不启动 broker。Node TLS 文件与进程选项不适用于浏览器传输。配置发现清单时，该 URL 必须实际提供清单；NATS Core 默认不提供。

v3 不提供旧 request/reply、节点 CLI、独立 leaf 导出、持久化或 `synced()`。JavaScript 暂无 live 通道 API；需要相容 live 控制器时使用 [Python live](python-api.zh.md#live)，不要假定 JS 存在同名方法。

准确导出类型见 [types/index.d.ts](https://github.com/skyboooox/KinopioHub.JS/blob/main/types/index.d.ts)，安装与可运行示例见[入门](javascript.zh.md)。
