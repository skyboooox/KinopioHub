# JavaScript API 参考

[English](javascript-api.md) · [入门](javascript.zh.md) · [首页](wiki-home.md)

使用 Node.js 24+，或配合打包器的现代浏览器。包提供默认与具名 `KinopioHub` 导出、`KinopioError` 和 TypeScript 声明。本章只介绍公开 API，不将内部协议工具作为接口。

本章目录

- [1. 创建与关闭 Hub](#chapter-1)
- [2. 构造参数](#chapter-2)
- [3. Variable](#chapter-3)
- [4. 监听与清理](#chapter-4)
- [5. SDK 状态与实例观察](#chapter-5)
- [6. 错误与传输边界](#chapter-6)
- [7. 浏览器与当前边界](#chapter-7)

<a id="chapter-1"></a>
## 1. 创建与关闭 Hub

```js
import KinopioHub, { KinopioError } from 'kinopio-hub';

const hub = new KinopioHub('workshop');
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

时长单位为**毫秒**，常规计时与容量参数要求正整数。构造签名为 `new KinopioHub(namespace?, options?)`，namespace 是第一参数；省略时生成 UUID，读取只读 `hub.namespace`。仅传高级配置时使用 `new KinopioHub(undefined, options)`。options 不接受 namespace 或 name。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
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
## 3. Variable

`hub.var(name)` 返回当前 Hub 内的稳定 Variable；重复调用取得同一个引用。TypeScript 使用 `hub.var<number>('battery')` 描述预期类型；泛型不会验证远端 JSON 的业务结构。

| 成员 | 返回 | 行为 |
| --- | --- | --- |
| `name` | 字符串 | 引用名称 |
| `value` | JSON 或 `undefined` | 本地值副本 |
| `meta` | `VariableMeta` | 初始化、存在性、版本与发布状态 |
| `set(value)` | `Promise<void>` | 验证并更新 RAM |
| `delete()` | `Promise<void>` | 写入带版本的删除记录 |
| `watch(callback)` | 停止函数 | 观察 `(value, meta)` 快照 |
| `ready({timeout})` | `Promise<this>` | 等待此变量本地初始化 |

`meta` 包含 `initialized`、`exists`、`version`、`pending`、`connected`。`exists` 未知时为 `null`，缺失为 `false`，存在为 `true`；已有的 `version` 包含字符串 `counter` 与 `writer`。`pending` 跟踪发布，不表示设备完成。

名称为 1–128 个 UTF-8 字节，不能含控制字符。协议 4 将 namespace 和变量名各自编码为 UTF-8 十六进制 token；状态记录主题为 `<namespace-token>.<variable-token>`，SDK 控制主题为 `_sys.v4.<namespace-token>`。这些是内部协议细节，应用仍应通过 `hub.var(name)` 访问变量。

```js
const battery = hub.var('battery');
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
const battery = hub.var('battery');
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
    console.log(instance.instanceId, instance.online, instance.health);
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

JavaScript 不提供 live 通道 API；需要相容 live 控制器时使用 [Python live](python-api.zh.md#live)。变量仅存 RAM，不提供持久化或历史。

准确导出类型见 [types/index.d.ts](https://github.com/skyboooox/KinopioHub.JS/blob/main/types/index.d.ts)，安装与可运行示例见[入门](javascript.zh.md)。

## 8. 事件、请求与 drain

消息方法统一放在 `hub.var(name)` 上。纯消息引用计入 `maxVariables`，不创建状态记录；`delete()` 只删除状态，不删除订阅。

`get()` 返回与 value 相同的本地副本，`get(fallback)` 仅在不存在时选择默认值，保留 null、false、0 和空值。`watchValue(callback)` 只传 value，返回既有 stop 函数，metadata 变化仍可能触发。

| 引用方法 | 返回 |
| --- | --- |
| `publish(data, {headers})`、`pub` | Promise，接受一条 JSON 事件到有界传输 |
| `subscribe(handler, options)`、`sub` | 已就绪 Subscription，回调参数 `(data, context)` |
| `handle(handler, options)` | 已就绪 Subscription，等待返回值后自动回复，undefined 回复 null |
| `request(data = null, options)`、`req` | 首条响应数据；details:true 返回 `{data, headers}` |
| `requestMany(data = null, options)` | 响应数组；details:true 返回 `{replies, reason}` |

消息名称按点分段，总长 1–128 UTF-8 字节，无空段或控制字符。订阅允许整段 `*` 和结尾 `>`（至少一段）；publish/request 拒绝通配符（`INVALID_TOPIC`）。

> **注意：** 状态名如 sensor.* 在 set/watch 中仍按字面处理。新消息使用 `_msg.v1.<hex(namespace)>.<hex(segment)>...`，状态协议 4 不变。

订阅选项：`queue`、`pendingMessages`、`pendingBytes`、注册 `timeout`（默认 3000 毫秒）。队列名按完整 UTF-8 名称编码，禁止通配符；同队列等价处理者分摊请求。普通订阅、重叠模式和不同队列可能各自收到请求。SUB 经协议同步后才返回；重连恢复订阅但不重放事件。

### 上下文与 Headers

`context.topic` 为实际业务主题，`context.headers` 为可枚举 `MessageHeaders`；输入接受字符串/字符串数组对象、MessageHeaders 或键值迭代器。

| 规则 | 行为 |
| --- | --- |
| 查询 | `get(name)` 大小写不敏感地取首值；`getAll(name)` 按线上顺序取同名全部值 |
| 出站 | 键为 ASCII token，值为可见 ASCII；键名小写，去除值首尾 ASCII 空格 |
| 重复值 | 同名值顺序保留；枚举反映收到的键名，不保证不同键之间顺序 |

Unicode 放 JSON。

subscribe 回调存活期间可多次 `await context.reply(data, {headers})`，没有回复主题报 `NO_REPLY_SUBJECT`；返回值不自动发送。handle 改用可设置的 `context.replyHeaders`，没有手动 reply，忽略无回复主题的事件。异常或非法结果记本地 `HANDLER_ERROR`，不发送虚构成功或泄露异常文本。

请求选项：`timeout`（3000 毫秒）、`headers`、`details`、`signal: AbortSignal`。只传选项时请求体显式传 null。requestMany 另有 `maxReplies`（16）、`maxBytes`（1 MiB，也接受 maxReplyBytes），不能超过 Hub 上限。

总期限或数量上限分别返回 reason 为 deadline、maxReplies；到期可成功返回空数组。503 报 `NO_RESPONDERS`；有订阅但不回复可能 TIMEOUT，取消报 CANCELLED，首条非法响应立即失败。

> **注意：** 收集异常的 `partialReplies` 始终保留有界详细响应。超时/取消不撤销远端副作用，请求不会自动重发。

### Drain 与连接代次

`hub.drain({timeout:5000})` 使用总期限，拒绝新消息、订阅和状态写入（`DRAINING`），等待已接受回调/回复及已有请求，确认传输后关闭。单订阅 drain 只影响该订阅；超时报 `DRAIN_TIMEOUT` 并清理可控资源，立即 close 可中断。

| 场景 | 行为 |
| --- | --- |
| Node 受管 handler 内 drain | `DRAIN_IN_HANDLER` |
| 浏览器任一 handler 运行 | 保守拒绝 drain，包括外层调用；先停产消息并等待回调 |
| 过期或旧代次回复 | 不能走新连接 |
| 计划交接 | 撤销旧订阅，最多等五秒后激活新订阅；当前请求失败、间隙可丢事件 |

不能强制停止用户代码或外部动作。

### 状态与过载

`hub.status().messaging` 和 `subscription.status()` 提供积压、字节、运行回调、丢弃、高水位和有效限制。Hub 预算包含回调与收集结果。

原生/网络丢弃不可观测时为 null；使用原生 callback 路径，不叠加迭代器队列。订阅满时丢新消息并报 SLOW_CONSUMER，恢复清除当前告警但保留计数；请求溢出报 BUFFER_OVERFLOW。

### Hub 消息默认值

| 选项 | 默认值 |
| --- | --- |
| `maxSubscriptions`、`maxRequests` | 128、64 |
| `pendingMessages`、`pendingBytes` | 每订阅 256、1 MiB，包含运行回调 |
| `maxPendingMessages`、`maxPendingBytes` | Hub 4096、8 MiB |
| `maxPayloadBytes` | 64 KiB |
| `maxHeaderBytes`、`maxHeaderEntries` | 4 KiB、32 |
| `maxReplies`、`maxReplyBytes` | 16、1 MiB |
| `maxOutboundBytes` | 8 MiB |

字节包含 payload、Headers、subject，不等于堆上限。JSON 保留深度和节点检查；payload 加 Headers 还受 broker `max_payload` 限制。publish/reply 不逐条 PING/PONG；flush 覆盖此前消息并保留状态传输语义。无连接立即 `DISCONNECTED`，不缓存离线事件。

如果自有节点清理超过 drain 期限，会先停止传输与新操作并返回 `DRAIN_TIMEOUT`，清理继续进行；此后 `await hub.close()` 可以等待清理完成。

[跨 SDK 消息语义](messaging.zh.md)
