# 事件与请求

[English](messaging.md) · [首页](wiki-home.md) · [云变量](variables.zh.md)

保留一个 `hub.var(name)` 引用，按数据用途选择方法。本章说明共通语义；各语言手册说明返回类型、回调形式和资源配置。

| 平台 | 消息 API |
| --- | --- |
| JS / Python / C++ | 下文全部操作 |
| [ESP32 基础客户端](arduino-api.zh.md#7-消息请求与-drain) | 精确名称事件、单响应请求、异步处理函数与 Hub drain |
| [ROS](ros-config.zh.md) | 通过 YAML 映射选定操作 |

> **ESP32 范围：** 不提供业务通配符、队列组、多响应收集、应用 Headers 或订阅级 drain。它可以调用桌面端队列服务，也可以回答桌面端的多响应收集。

本章内容

- [选择操作](#chapter-1)
- [名称、通配符与队列组](#chapter-2)
- [请求与多响应](#chapter-3)
- [Headers](#chapter-4)
- [容量、断线与关闭](#chapter-5)

<a id="chapter-1"></a>
## 选择操作

| 需求 | 写入或发送 | 接收或读取 |
| --- | --- | --- |
| 当前状态，允许离线更新 RAM | `set(value)` | `get(fallback)`、`watchValue(handler)` |
| 发给当前在线订阅者的事件 | `pub(data)` | `sub(handler)` |
| 等待一个业务响应 | `req(data)` | `handle(handler)` 返回响应 |
| 有界收集多个响应 | `requestMany(data, options)` | 多个处理者，或订阅上下文显式回复 |

`pub`、`sub`、`req` 分别是 `publish`、`subscribe`、`request` 的同义短名。Python 使用 `watch_value` 和 `request_many`。完整名称仍然可用；queue、超时和 Headers 放在可选设置中，不重复传话题名称。

| 便捷方法 | 行为 |
| --- | --- |
| `get(fallback)` | 立即读取本地 RAM；仅在没有当前值时返回默认值，不等待对等实例、不写入默认值。 |
| `watchValue(handler)` | 保留原有观察时机与取消规则；metadata 变化仍可能触发回调。 |

null、false、0、空字符串和空集合都是合法值，不会被默认值替换。

以下 Node/浏览器片段在 `await hub.connected()` 后运行：

```js
const notice = hub.var('notice');
const subscription = await notice.sub(data => console.log(data));
await notice.pub({ text: 'hello' });
// Later: await subscription.unsubscribe();
```

`pub()` 不修改 value、版本或变量 pending；`sub()` 不回放当前值。重复事件是独立消息，云变量则对重复版本去重。仅用于消息的稳定引用仍占用引用容量。

<a id="chapter-2"></a>
## 名称、通配符与队列组

状态方法把完整变量名作为字面名称；消息方法把点解释为层级分隔符。具体消息名称由非空段组成，不含 `*`、`>` 或 U+0000–U+001F/U+007F，总长为 1–128 UTF-8 字节。

| 订阅模式 | 匹配 | 不匹配 |
| --- | --- | --- |
| `sensor.*` | `sensor.temperature` | `sensor`、`sensor.room.temperature` |
| `sensor.>` | `sensor.temperature`、`sensor.room.temperature` | `sensor` |
| `>` | 本 namespace 的业务消息 | 其他 namespace、状态记录和 SDK 报告 |

- 仅 **`sub` 和 `handle`** 接受模式；通配符须独占一段，`>` 必须位于末尾。
- 向模式发布或请求会在本地失败。
- `hub.var('sensor.*').set(1)` 写入字面名称 `sensor.*` 的状态；同一引用的 `sub()` 则订阅消息模式。引用本身没有隐式模式切换。

### 队列组

为可互换的订阅者或处理者设置相同 `queue`。NATS 为每条消息选择该组的一个成员；其他组和普通订阅者也可分别收到消息。

> **只负责工作分配：** 队列组不保存任务、不重投失败处理、不保证业务完成。不同实体执行器不能当成可互换的工作者。

<details>
<summary>线上主题与权限</summary>

| 流量 | 主题或队列 |
| --- | --- |
| 状态 | `<hex(namespace)>.<hex(完整名称)>` |
| 消息 | `_msg.v1.<hex(namespace)>.<hex(段)>...` |
| 队列组 | `_q.v1.<hex(namespace)>.<hex(完整队列名)>` |
| 回复 | 原生 `_INBOX` |

编码采用未经归一化的 UTF-8 小写十六进制。应配置相应 NATS 权限；namespace 和编码不提供权限隔离。SDK 不提供原始 subject 模式。

</details>

<a id="chapter-3"></a>
## 请求与多响应

```js
const lamp = hub.var('lamp');
const responder = await lamp.handle(async setting => {
  await applyLamp(setting);
  return { ok: true };
});
const result = await lamp.req({ on: true });
console.log(result.ok);
```

`applyLamp` 是应用自己的操作。handler 返回 JSON，由 SDK 自动发送为响应。

| 省略的值 | 线上值 |
| --- | --- |
| JS handler 无返回值 / Python 返回 `None` | JSON null |
| `req()` 不传请求体 | JSON null |
| 只需设置、不需请求体 | 先显式传 null/None，再传设置 |

SDK 不猜测一个对象是业务数据还是配置。

| 请求结果 | 行为 |
| --- | --- |
| 首条合法响应 | 返回其数据；默认总超时 **3 秒** |
| 详细模式 | 同时返回响应 Headers |
| 业务失败 | 普通应用数据，例如 `{ok:false,error:'unavailable'}` |
| handler 异常 | 在本地记录，调用方可能超时；不自动发送远端错误对象。 |

| 接收方式 | 接收内容 | 回复行为 |
| --- | --- | --- |
| `sub` | 匹配的事件与请求 | 不使用回调返回值；高级上下文通过 `reply(data, options)` 显式回复 |
| `handle` | 带回复地址的请求 | 根据返回值自动回复一次；上下文可设置回复 Headers |

`handle` 忽略没有回复地址的普通发布。

### 收集多个响应

`requestMany` / `request_many` 在有限窗口内收集响应消息。

| 设置或结果 | 含义 |
| --- | --- |
| 默认窗口 | **3 秒**、最多 **16 条**，同时受字节预算限制 |
| 详细结果 `reason` | `deadline` 或 `maxReplies` |
| 计数对象 | 消息数，不是唯一设备数 |
| 正常结束的空窗口 | 合法空结果，不证明所有设备均已回答 |

- **失败：** 超时、取消、断线和权限错误与业务响应分别处理；多响应失败按语言 API 保留有界的部分结果。
- **非法与迟到回复：** 首条响应格式非法会使请求失败；迟到回复不会重新开启请求。
- **`NO_RESPONDERS`：** broker 没有匹配订阅兴趣。不回复的监视订阅也会产生兴趣，因此没有该错误不代表处理者健康。

> **不自动重试。** 超时或取消无法撤销远端工作。重试有副作用的操作时，应用须提供操作编号和去重规则；响应只确认 handler 实现的完成条件。

<a id="chapter-4"></a>
## Headers

消息使用原生 NATS Headers。JS、Python、C++ 每个键接受一个字符串或多个字符串值。

| 操作 | 规则 |
| --- | --- |
| 发送 | 名称小写；保留同一逻辑键的值顺序，包括混合大小写的输入 |
| `get` | 不区分大小写，返回第一项 |
| `getAll` / Python `get_all` | 按顺序返回全部匹配值 |
| 枚举 | 使用收到的线上名称；不同键间的顺序不跨 SDK 保证 |
| ESP32 | 有界校验 Headers 以处理传输状态，丢弃应用元数据；设备业务数据放入 JSON |

```js
await hub.var('notice').pub('ready', {
  headers: { 'X-Trace': 'operation-42', 'X-Tag': ['device', 'status'] }
});
```

| 内容 | 约束 |
| --- | --- |
| Header 名称 | ASCII token |
| Header 值 | 可见 ASCII；去除首尾 ASCII 空格，保留内部空格 |
| 控制字符 | 拒绝 CR、LF、NUL 等控制字符 |
| Unicode 或须保留首尾空格的文本 | 放在 JSON 中 |
| 大小 | Headers + payload 满足 broker 和 SDK 限制 |
| 响应 Headers | 通过请求详细结果读取，不插入业务 JSON |

<a id="chapter-5"></a>
## 容量、断线与关闭

消息操作需要活动连接。断线或 draining 时拒绝新消息；SDK 不保存离线事件，也不在重连后重放请求。订阅在新连接上重新建立；云变量继续采用独立的离线 RAM 语义。

### 慢消费者与容量限制

订阅、请求、消息队列、响应收集和待发送字节都有上限。

| 情况 | 结果 |
| --- | --- |
| handler 队列满 | 丢弃新到消息，保持已接受消息的 FIFO 顺序，报告 `SLOW_CONSUMER` 与计数 |
| 请求 inbox 溢出 | 使该请求失败 |
| 查看积压与丢弃 | 读取订阅状态和 `hub.status().messaging`，查看排队、执行中工作、限制及已知丢弃 |

这些计数不能证明网络其他位置没有丢失。

回调应简短。可等待 handler 默认在每个订阅内串行执行；ESP32 通过 `loop()` 推进工作。同步回调阻塞执行线程时，增大超时无法恢复响应能力。

| 操作 | 含义 |
| --- | --- |
| `pub` 完成 | 本地有界传输已接受消息 |
| `flush` 完成 | NATS 确认此前传输写入，不代表远端执行 |
| `unsubscribe` | 停止新投递并丢弃本地等待工作；已进入 handler 的工作仍可能完成 |
| 订阅 `drain` | 在期限内完成该订阅已接受工作及回复 |
| Hub `drain` | 停止新操作，结束已接受工作和请求，确认传输并关闭 |
| `close` | 立即清理，不隐式等待 drain |

### Drain 期限

| 规则 | 行为 |
| --- | --- |
| 期限 | 默认整个过程共 **5 秒** |
| 超时 | 清理 SDK 可控制的资源，报告 `DRAIN_TIMEOUT` |
| 调用方 | 应用拥有者，位于受管 handler 之外 |
| Node / Python | 识别 handler 上下文 |
| 浏览器 | 相关 handler 未结束时保守拒绝，包括外部调用；须先等待这些 handler 完成 |

Node/Python 自有节点的清理可能在 `DRAIN_TIMEOUT` 后继续，此后 `await hub.close()` 可以等待清理完成；传输订阅兴趣和新操作已停止。

计划切换节点时，先撤销旧业务订阅，再激活新连接；执行中的请求失败，不自动重发。交接可以丢失事件，故障也可能让远端是否执行变得不确定。SDK 不提供端到端 exactly-once 保证。

语言细节：[JavaScript](javascript-api.zh.md)、[Python](python-api.zh.md)、[C++](cpp-api.zh.md)、[ESP32](arduino-api.zh.md)、[ROS YAML](ros-config.zh.md)。
