# 变量与同步

[English](variables.md) · [首页](wiki-home.md) · [组网](networking.zh.md)

本章说明各 SDK 共用的行为。不同语言的返回类型和调用方式见各自 API 参考。

本章目录

- [1. 命名与引用](#chapter-1)
- [2. 值、缺失与初次加载](#chapter-2)
- [3. 读取、写入与监听](#chapter-3)
- [4. 并发写入与删除](#chapter-4)
- [5. 离线行为与生命周期](#chapter-5)
- [6. 期望状态与命令](#chapter-6)

<a id="chapter-1"></a>
## 1. 命名与引用

变量由 namespace 与变量名共同确定。设备间这两个名称必须一致；另一个 namespace 下的同名变量是不同变量。

```js
const hub = new KinopioHub('workshop');
const battery = hub.var('battery');
```

变量引用可以长期保存并重复使用；创建引用不会自动赋值。

| 命名规则 | 要求 |
| --- | --- |
| 长度 | 1–128 个合法 UTF-8 字节 |
| 禁用字符 | U+0000–U+001F、U+007F |
| 比较方式 | 区分大小写，不裁剪空格、不进行 Unicode 归一化 |
| 斜杠 | 名称的字面内容；ROS 的 `/battery` 合法 |

> **互通须显式使用相同 namespace。** 省略时，每个 Hub 生成独立 UUID，两个默认 Hub 相互隔离。

| 运行环境 | 读取 namespace |
| --- | --- |
| JS / Python | `hub.namespace` |
| C++ / ESP32 | `hub.namespaceName()` |

namespace 在 Hub 生命周期内不变；获取变量引用不会创建新 namespace。

状态名称按 UTF-8 字节编码为每字节两位小写十六进制，set/get/watch 中的空格、点号、`*` 和 `>` 均保持字面含义。消息方法采用独立的[层级与通配符规则](messaging.zh.md#chapter-2)。以 namespace `workshop`、变量 `battery` 为例：

| 流量 | NATS subject |
| --- | --- |
| 变量更新 | `776f726b73686f70.62617474657279` |
| 对等查询 | `_sys.v4.776f726b73686f70.sync` |
| 查询回复 | `_sys.v4.776f726b73686f70.inbox.<id>` |
| SDK 状态 | `_sys.v4.776f726b73686f70.health.<instanceId>` |
| Python live | `_sys.v4.776f726b73686f70.live.…` |

变量消息为 `{name, version: {counter, writer}, deleted, value?}`。

- 记录保留原始变量名，接收时与编码后的主题核对。
- 编码后的数据主题不会与内部控制主题冲突。
- NATS 权限须覆盖数据、查询、回复和健康消息。

[共用编码向量](../integration/fixtures/name-vectors.json)列出了合法及拒绝的名称。

namespace 用于组织数据，不提供权限隔离。设备还需要处于连通的 NATS 拓扑，并使用相容的认证配置。权限限制应通过 NATS account 或 subject 权限完成。

<a id="chapter-2"></a>
## 2. 值、缺失与初次加载

| 数据 | 可跨语言传输的表示 |
| --- | --- |
| JSON | null、布尔值、有限数值、字符串、数组和对象 |
| 整数值 | 位于 ±(2^53−1)，即使语言支持更大整数也不例外 |
| 更大的标识符 | 字符串 |
| 日期与二进制 | 明确转换为应用约定的 JSON 表示 |

SDK 会检查嵌套深度、复杂度和内存限制。桌面 SDK 能接受的值可能超过 ESP32 的较小限制；共享数据结构应以最小接收设备为准。

| 状态 | JS | Python | C++ | ESP32 |
| --- | --- | --- | --- | --- |
| 存在且值为 JSON null | `null` | `None` | 包含 `Json(nullptr)` 的 optional | `exists()` 为 true，JSON 为 null |
| 本地没有值 | `undefined` | `UNSET` | 空 optional | `exists()` 为 false |
| 初次查询尚未结束 | `meta.exists === null` | `meta["exists"] is None` | `meta()["exists"]` 为 null | 没有对应的三态元数据 API |

| 运行环境 | 初次查询 |
| --- | --- |
| JS / Python / C++ | `variable.ready()` 等待本地状态明确，包括已知不存在；等待后仍需检查存在性。 |
| ESP32 | 通过 `loop()` 与回调观察，没有变量 `ready()` API。 |

> **Ready 不等于有值，** 也不代表所有可能存在的设备都已响应。

不要把“读取到缺失，然后写入默认值”当作原子初始化。两个设备可能同时发现缺失并写入；最终由正常冲突规则选出一个结果，没有 compare-and-set 操作。

<a id="chapter-3"></a>
## 3. 读取、写入与监听

读取返回本地副本；反复访问时保留变量引用，修改值后调用 `set()` 才会发布。

**ESP32 所有权：** 保存的快照拥有嵌套 ArduinoJson 字符串，包括链接到调用者数组的字符串。读取返回自有 `JsonDocument`，详见[值所有权](arduino-api.zh.md#chapter-3)。

```js
const battery = hub.var('battery');
const stop = battery.watch((value, meta) => {
  if (meta.exists) console.log(value);
});
await battery.set(80);
// Call stop() when this view is no longer needed.
```

监听按各语言的调度方式提供初始状态和后续变化。待发布标记清除、连接变化等元数据变化也可能触发回调。应将监听理解为当前状态视图，不是持久事件流，也不保证每个业务动作恰好回调一次。

| 方法 | 行为 |
| --- | --- |
| `get(fallback)` | 本地缺失默认值，不替换 null/false/零，不发起网络查询 |
| `watchValue(handler)` / Python `watch_value` | 只传值，保留原来的观察时机 |
| `pub/sub/req/handle` | 独立消息操作；删除状态不会移除订阅 |

写入更新本地 RAM，断网时也可以成功。重复写入相同 JSON 仍会生成新的逻辑版本；传输去重只处理同一版本的重复消息。

| 等待或操作 | 成功的含义 |
| --- | --- |
| Hub `ready()`（JS/Python/C++） | 本地 SDK 初始化完成 |
| 变量 `ready()` | 此本地视图已有初始化结果 |
| Hub `connected()`（JS/Python/C++） | SDK 已有有效 NATS 连接 |
| `set()` / 删除 | 本地当前记录已更新 |
| Hub `flush()` | 当前记录已发送，并完成 NATS 传输确认 |
| 应用结果变量 | 应用自己定义并实现的完成条件 |

<a id="chapter-4"></a>
## 4. 并发写入与删除

每条记录携带 `{counter, writer}`。

1. counter 编码为十进制字符串，按数值比较。
2. counter 较大者胜出；相同时按 writer ID 排序。
3. 接收记录推进本地逻辑时钟，后续写入使用推进后的时钟。

系统时间不参与选值。

**合并选择整个 JSON 值，不逐属性合并。**

| 数据关系 | 建模方式 |
| --- | --- |
| 不同写入者独立维护的字段 | 多个变量 |
| 必须作为一个快照传输的字段 | 一个对象，并接受整值冲突规则 |

| 删除之后 | 结果 |
| --- | --- |
| RAM 记录 | 保留带版本的删除标记 |
| 同步收到旧值 | 不能恢复已删除的值 |
| 后续更高版本写入 | 可以重新创建值 |
| 容量 | 删除标记仍占记录槽位，不回收全部元数据 |

多个变量之间没有原子事务，读取方可能看到两次写入之间的中间状态。不可分割的字段应放进同一个值，或由应用增加关联序号。

<a id="chapter-5"></a>
## 5. 离线行为与生命周期

1. 新 Hub 从空内存和新身份开始。
2. 在线副本交换各自的当前记录。
3. 断网期间，仍在运行的 SDK 可以继续读取和更新本地 RAM。
4. 重连后，将保留的当前记录与在线副本合并。
5. 最后一个持有记录的进程退出后，该记录丢失。

- **只保留当前记录：** 同一变量的多次离线修改可能在发布前合并，不形成操作日志。
- **Broker 不是备份：** 重启不会恢复 SDK 数据，只保留 broker 在线也不保存变量。
- **存活副本修复状态：** 只要副本仍存活，周期同步就能修复遗漏更新。

<a id="chapter-6"></a>
## 6. 期望状态与命令

变量适合当前测量值、配置和期望状态。设备完成应用请求后，应另外发布报告值。如果调用方需要关联一次动作与结果，可以增加应用层请求 ID。

接收端支持时，可以使用 [Python live 通道](python-api.zh.md#live)发送会过期的命令。每次 live 发送是独立调用，不做离线重放，但仍不证明执行完成。[ROS 控制](ros-config.zh.md#controls)为期望状态增加会话检查，为 live 命令增加接收者租约。

瞬时通知与业务回复使用[事件与请求](messaging.zh.md)。当前值不适合充当事件日志或原子计数器；当前值和 Core NATS 队列组都不保证每一个中间操作得到处理。

下一章：[连接模式与 mesh](networking.zh.md)，然后查阅 [JS](javascript-api.zh.md)、[Python](python-api.zh.md)、[C++](cpp-api.zh.md) 或 [ESP32](arduino-api.zh.md) API。
