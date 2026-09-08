# 变量与同步

[English](variables.md) · [首页](wiki-home.md) · [组网](networking.zh.md)

本章说明 3.0.0 各 SDK 共用的行为。不同语言的返回类型和调用方式见各自 API 参考。

本章目录

- [1. 命名与引用](#chapter-1)
- [2. 值、缺失与初次加载](#chapter-2)
- [3. 读取、写入与监听](#chapter-3)
- [4. 并发写入与删除](#chapter-4)
- [5. 离线行为与生命周期](#chapter-5)
- [6. 期望状态与命令](#chapter-6)

<a id="chapter-1"></a>
## 1. 命名与引用

变量由 namespace、scope、变量名共同确定。设备间这三个名称必须一致；另一个 namespace 下的同名变量是不同变量。

```js
const hub = new KinopioHub({ namespace: 'workshop' });
const battery = hub.scope('devices').var('battery');
```

可以用 scope 表示一个设备或一组相关数据。变量引用可以长期保存并重复使用，创建引用不会自动赋值。名称允许 1–128 个 UTF-8 字节，不能包含控制字符。变量名中的斜杠只是名称的一部分，因此 ROS 的 `/battery` 也是合法变量名。

namespace 用于组织数据，不提供权限隔离。设备还需要处于连通的 NATS 拓扑，并使用相容的认证配置。权限限制应通过 NATS account 或 subject 权限完成。

<a id="chapter-2"></a>
## 2. 值、缺失与初次加载

变量使用可跨语言传输的 JSON 子集：null、布尔值、有限数值、字符串、数组和对象。整数值必须位于 ±(2^53−1)，即使当前语言支持更大的整数也是如此。较大的标识符应存为字符串，日期与二进制应明确转换为应用约定的 JSON 表示。

SDK 会检查嵌套深度、复杂度和内存限制。桌面 SDK 能接受的值可能超过 ESP32 的较小限制；共享数据结构应以最小接收设备为准。

| 状态 | JS | Python | C++ | ESP32 |
| --- | --- | --- | --- | --- |
| 存在且值为 JSON null | `null` | `None` | 包含 `Json(nullptr)` 的 optional | `exists()` 为 true，JSON 为 null |
| 本地没有值 | `undefined` | `UNSET` | 空 optional | `exists()` 为 false |
| 初次查询尚未结束 | `meta.exists === null` | `meta["exists"] is None` | `meta()["exists"]` 为 null | 没有对应的三态元数据 API |

JS、Python、C++ 的 `variable.ready()` 等待本地状态明确，包括“已知不存在”。它不保证一定有值，也不保证所有可能存在的设备都已响应。等待后仍需检查是否存在。ESP32 通过 `loop()` 与回调观察值，没有变量 `ready()` API。

不要把“读取到缺失，然后写入默认值”当作原子初始化。两个设备可能同时发现缺失并写入；最终由正常冲突规则选出一个结果，没有 compare-and-set 操作。

<a id="chapter-3"></a>
## 3. 读取、写入与监听

读取返回本地快照。修改返回的对象不会自动发布，需要将修改后的值交给 `set()`。保留变量引用即可重复使用，不必反复建立应用监听关系。

```js
const battery = hub.scope('devices').var('battery');
const stop = battery.watch((value, meta) => {
  if (meta.exists) console.log(value);
});
await battery.set(80);
// Call stop() when this view is no longer needed.
```

监听按各语言的调度方式提供初始状态和后续变化。待发布标记清除、连接变化等元数据变化也可能触发回调。应将监听理解为当前状态视图，不是持久事件流，也不保证每个业务动作恰好回调一次。

写入更新本地 RAM，断网时也可以成功。重复写入相同 JSON 仍会生成新的逻辑版本；传输去重只处理同一版本的重复消息。

| 等待或操作 | 成功的含义 |
| --- | --- |
| Hub `ready()` | 本地 SDK 初始化完成 |
| 变量 `ready()` | 此本地视图已有初始化结果 |
| Hub `connected()` | SDK 已有有效 NATS 连接 |
| `set()` / 删除 | 本地当前记录已更新 |
| Hub `flush()` | 当前记录已发送，并完成 NATS 传输确认 |
| 应用结果变量 | 应用自己定义并实现的完成条件 |

<a id="chapter-4"></a>
## 4. 并发写入与删除

每条记录携带 `{counter, writer}`。counter 是十进制字符串，按数值比较；counter 较大者胜出，相同则按 writer ID 顺序选择。系统时间不参与选值。接收记录会推进本地逻辑时钟，之后的本地写入使用推进后的时钟。

规则选择的是整个 JSON 值，不会逐属性合并同一个对象的并发修改。如果不同写入者独立维护不同字段，可拆成多个变量；如果多个字段必须作为一个快照传输，可放在一个对象中，并接受整值冲突规则。

删除会在 RAM 中保留带版本号的删除标记，防止同步时旧值重新出现。之后更高版本的写入仍能重新创建值。删除标记占用记录容量，因此删除不是清除所有版本信息或回收全部槽位的方法。

多个变量之间没有原子事务，读取方可能看到两次写入之间的中间状态。不可分割的字段应放进同一个值，或由应用增加关联序号。

<a id="chapter-5"></a>
## 5. 离线行为与生命周期

1. 新 Hub 从空内存和新身份开始。
2. 在线副本交换各自的当前记录。
3. 断网期间，仍在运行的 SDK 可以继续读取和更新本地 RAM。
4. 重连后，将保留的当前记录与在线副本合并。
5. 最后一个持有记录的进程退出后，该记录丢失。

离线写入不会形成操作日志。同一个变量的多次修改可能在发布前合并为一条当前记录。重启 broker 不会恢复 SDK 数据，只保留 broker 在线也不会保存变量。只要副本仍存活，周期同步就可以修复遗漏的当前状态更新。

<a id="chapter-6"></a>
## 6. 期望状态与命令

变量适合当前测量值、配置和期望状态。设备完成应用请求后，应另外发布报告值。如果调用方需要关联一次动作与结果，可以增加应用层请求 ID。

接收端支持时，可以使用 [Python live 通道](python-api.zh.md#live)发送会过期的命令。每次 live 发送是独立调用，不做离线重放，但仍不证明执行完成。[ROS 控制](ros-config.zh.md#controls)为期望状态增加会话检查，为 live 命令增加接收者租约。

变量不适合充当事件日志、原子计数器或要求处理中间每一个值的队列；当前 SDK 不提供这些保证。

下一章：[连接模式与 mesh](networking.zh.md)，然后查阅 [JS](javascript-api.zh.md)、[Python](python-api.zh.md)、[C++](cpp-api.zh.md) 或 [ESP32](arduino-api.zh.md) API。
