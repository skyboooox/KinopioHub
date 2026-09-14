# Python API 参考

[English](python-api.md) · [入门](python.zh.md) · [首页](wiki-home.md)

使用 Python 3.10+ 与 asyncio。公开导出包含 `KinopioHub`、`Variable`、`KinopioError`、`UNSET`、`LiveChannel`、`LiveContext`、`Headers`、`Reply`、`ManyResult`、`Subscription`、`MessageContext`、`HandleContext`、`MessageError` 和 `__version__`。

本章目录

- [1. 事件循环与生命周期](#chapter-1)
- [2. 构造参数](#chapter-2)
- [3. 变量](#chapter-3)
- [4. 回调与实例报告](#chapter-4)
- [5. Live 通道](#chapter-5)
- [6. 错误与集成](#chapter-6)

<a id="chapter-1"></a>
## 1. 事件循环与生命周期

```python
import asyncio
from kinopio_hub import KinopioHub, UNSET

async def main():
    async with KinopioHub("workshop") as hub:
        await hub.connected()
        battery = hub.var("battery")
        await battery.ready()
        if battery.value is not UNSET:
            print(battery.value)

asyncio.run(main())
```

一个 Hub 及其操作应使用同一个 asyncio 事件循环。在运行中的循环内构造会启动初始化，否则延后到异步操作初始化时启动。进入上下文管理器等待本地初始化，不等待联网；退出时关闭 Hub。

`await hub.ready()`、`await hub.connected(timeout=None)` 返回 Hub；`await hub.flush(timeout=None)`、`await hub.close()` 不返回业务值。`hub.instance_id` 标识运行实例，`hub.state` 是本地连接状态。关闭不保存记录，也不隐含最后一次 flush。

<a id="chapter-2"></a>
## 2. 构造参数

namespace 是唯一的位置参数，其余配置使用关键字。省略或传 `None` 时生成 UUID，通过只读 `hub.namespace` 读取；不接受显示 name。

签名为 `KinopioHub(namespace=None, *, servers=None, mesh=True, **options)`。Python 参数使用 snake_case，常规时长单位为**秒**，明确以 `_ms` 结尾的字段为毫秒。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `namespace` | 随机 UUID | 共享数据命名空间 |
| `servers` | 按连接模式选择 | 客户端 URL 字符串或列表 |
| `mesh` | `True` | 自动节点，`False` 表示仅客户端 |
| `discovery` | 启用 | 旧 UDP 入口提示，不获取 HTTP 清单 |
| `token` | 未设置 | token 认证 |
| `user`、`password` | 未设置 | 用户名与密码 |
| `tls` | 未设置 | 客户端 TLS，配合 `mesh=False` |
| `timeout` | `3` | 常规超时，显式设置也会影响连接等待 |
| `peer_timeout` | `timeout` 的 80% | 对等发现等待 |
| `health_interval` | `5` | SDK 报告周期 |
| `probe_interval` | `15` | 连接探测周期 |
| `max_variables` | `10000` | 记录及引用容量 |
| `max_memory_bytes` | `16777216` | 记录数据预算 |
| `max_instances` | `1024` | 观察实例容量 |
| `selection` | SDK 策略 | `improvement_ms`、`improvement_ratio`、`cooldown` 调整客户端切换 |
| `on_callback_error` | 未设置 | 同步回调错误处理器 |

没有显式超时覆盖时，自动模式 `connected()` 与 `flush()` 默认允许 60 秒。`tls` 接受 `ssl.SSLContext`，也接受包含 `ca_file`、`cert_file`、`key_file`、`handshake_first` 的字典；字典路径由 Python 应用解析。`mesh` 字典接受 `group`、`binary`、`upstreams`、`upstream_tls`，leaf TLS 使用同样的 snake_case 证书字段。ROS 另行提供 YAML 相对路径解析。

<a id="chapter-3"></a>
## 3. 变量

| 成员 | 结果 |
| --- | --- |
| `hub.var(name)` | 稳定引用 |
| `variable.value` | JSON 相容副本，或 `UNSET` 哨兵 |
| `variable.meta` | 初始化、存在性、版本、待发布与连接状态字典 |
| `await variable.set(value)` | 本地 RAM 写入 |
| `await variable.delete()` | 带版本删除 |
| `await variable.ready(timeout=None)` | 本地状态初始化后的变量 |
| `variable.watch(callback)` | 同步停止函数 |

用身份比较判断 `UNSET`。`None`、`False`、零、空容器都是有效值，不能用真假判断区分缺失。`meta["exists"]` 未知时为 `None`、缺失为 `False`、存在为 `True`。虽然构造参数使用 snake_case，元数据/报告中的 `instanceId`、`pendingVariables` 等仍保留共用协议字段名。

名称为 1–128 个 UTF-8 字节，不能含控制字符。协议 4 将 namespace 和变量名各自编码为 UTF-8 十六进制 token；状态记录主题为 `<namespace-token>.<variable-token>`，SDK 控制主题为 `_sys.v4.<namespace-token>`。这些是内部协议细节，应用仍应通过 `hub.var(name)` 访问变量。

```python
battery = hub.var("battery")
await battery.set(None)
assert battery.value is None
await battery.delete()
assert battery.value is UNSET
```

JSON 相容值不包含 bytes、set、自定义对象、非有限数和不安全整数值。应用类型需要显式序列化，Python 任意精度整数不能取消跨语言数值限制。读取不提供操作历史，详见[变量语义](variables.zh.md)。

<a id="chapter-4"></a>
## 4. 回调与实例报告

变量 watch 接受 `(value, meta)`，Hub watch 接受本地状态，实例 watch 接受报告列表。这些回调都必须同步；不支持 `async def` watcher，返回 awaitable 也会按回调错误处理。

```python
stop = hub.instances.watch(
    lambda items: print([(item["instanceId"], item["online"]) for item in items])
)
reports = await hub.instances.list()
# Call stop() during cleanup.
```

`hub.status()` 为同步方法。回调保持简短，较长工作交给显式管理且限制并发的任务。关闭时除停止监听外，也应停止应用任务。`on_callback_error` 同样必须同步。

<a id="live"></a>
<a id="chapter-5"></a>
## 5. Live 通道

`hub.live(name)` 返回当前 Hub namespace 下的通道。收发两端使用相同名称；ROS live 路由通常是 路由变量名，例如 `control/command`。live 通道不会创建云变量。

| 方法 | 参数与结果 |
| --- | --- |
| `await channel.subscribe(callback, max_age_ms=300, with_context=False)` | 注册同步接收回调，返回异步停止函数 |
| `await channel.send(value, timeout=3)` | 通过有效连接发送一条命令，确认传输 |
| `context.is_valid()` | 延后执行的工作是否仍属于有效接收会话与租约 |
| `context.expires_at` | 本地单调时钟截止时间，不是 UTC 或另一台设备的时间 |

双方必须已连接。接收租约时长接受 1–60,000 毫秒。部署时每个通道只放一个接收者，不做跨进程所有权协调。同一通道对象并发发送可能返回 `BUSY`，应串行发送。无接收者、断连或租约过期都可能导致发送失败。

```python
channel = hub.live("control/command")
stop = await channel.subscribe(lambda value: print(value), max_age_ms=300)
try:
    await asyncio.Event().wait()
finally:
    await stop()
```

接收段在已连接的 Hub 中运行。第二个已连接 Hub 调用 `await hub.live("control/command").send({"data": "step"})`。两次相同 JSON 是两条命令，重连后不会重放。

设置 `with_context=True` 后，回调接受 `(value, context)`。如果将工作排入队列，真正动作前立即检查 `context.is_valid()`。不要用系统时钟比较代替接收者的单调时钟检查。发送成功不是完成回执，需要应用反馈，必要时使用本地控制器 watchdog。

<a id="chapter-6"></a>
## 6. 错误与集成

捕获 `KinopioError` 后读取 `.code`，后台连接和报告错误检查本地 `status()`。`TIMEOUT`、`DISCONNECTED`、`CLOSED` 对应不同生命周期状态，传输等待失败不清除本地值。限制重试并发，尤其是 live 操作。

先安装匹配的 Python SDK，再安装 ROS 桥接。不依赖 Node 运行时。路由特有行为见 [ROS 配置](ros-config.zh.md)，源码测试和互通检查见[开发说明](development.zh.md)。


<a id="messaging"></a>
## 事件与请求

消息方法位于 `hub.var(name)` 的稳定引用上，不创建或修改状态记录。`set/watch/value/ready` 保留状态含义，删除状态也不取消订阅。

同步 `get(fallback=UNSET)` 只在未知或删除时采用默认值，不写入它；合法的 `None`、`False`、零和空值均保留。同步 `watch_value(callback)` 只传当前值，保留原有触发时机、元数据变化通知和 stop 函数。

| 方法 | 关键字选项与结果 |
| --- | --- |
| `await ref.publish(data)` / `ref.pub(data)` | `headers=None`；将独立 JSON 事件交给有界传输 |
| `await ref.subscribe(handler)` / `ref.sub(handler)` | `queue=None`、`with_context=False`、`pending_messages=256`、`pending_bytes=1048576`；SUB/PONG 就绪屏障后返回 `Subscription` |
| `await ref.handle(handler)` | 同订阅选项；自动回复同步或异步返回值，`None` 回复 JSON null |
| `await ref.request(data=None)` / `ref.req(data=None)` | `timeout=3`、`headers=None`、`details=False`；首条数据，详细模式为 `Reply(data, headers)` |
| `await ref.request_many(data=None)` | 同请求选项，另有 `max_replies=16`、`max_bytes=1048576`；数据列表，详细模式为 `ManyResult(replies, reason)` |
| `await subscription.unsubscribe()` | 撤销兴趣并丢弃队列，已运行回调仍可完成 |
| `await subscription.drain(timeout=5)` | 撤销兴趣，完成已接受回调、回复并确认传输 |
| `await hub.drain(timeout=5)` | 在一个总期限内完成回调、已有请求、传输确认并关闭 |
| `subscription.status()` | 本地积压、处理中数量、丢弃、高水位和有效限制 |

以上超时单位为秒。短名直接使用完整方法的实现、错误和取消行为。不会将数据对象误判成选项；只有选项时写 `await ref.req(None, timeout=1)`。

| 请求规则 | 行为 |
| --- | --- |
| `request_many` | 只发送一次，统计回复条数，不统计设备数 |
| 截止时间 | 空列表也可成功；详细终止原因为 `deadline` 或 `maxReplies` |
| 收集上限 | 可降低，但不得超过 16 条或 1 MiB |

### 回调上下文

消息回调每订阅串行，默认只接收数据，可同步或异步。`with_context=True` 增加第二个参数，提供实际 `topic` 和 `headers`。

| 上下文 | 回复方式 |
| --- | --- |
| subscribe | 回调运行期间可多次 `await context.reply(data, headers=None)` |
| handle | 返回前设置 `reply_headers` 为 Headers 或映射；没有手动 reply |
| 回调外后台任务 | 不保留可用的回复上下文 |

handle 忽略没有 reply subject 的普通事件；subscribe 返回值不回复。

```python
from kinopio_hub import Headers

async def respond(data, context):
    context.reply_headers = Headers({"X-Worker": ["device-a", "primary"]})
    return {"ok": True, "input": data}

responder = await hub.var("robot.reset").handle(
    respond, queue="reset-workers", with_context=True
)
reply = await hub.var("robot.reset").req(details=True)
print(reply.data, reply.headers.get_all("x-worker"))
await responder.drain()
```

消息名称为 1–128 UTF-8 字节，以点分段，不允许空段及 C0/DEL 控制字符。subscribe/handle 支持整段 `*` 和末段 `>`，后者至少匹配一个额外段；发布或请求通配符返回 `INVALID_TOPIC`。状态方法仍按字面名称处理。`_msg.v1` 编码主题独立于协议 4 状态；namespace 不提供权限隔离。队列名按完整名称编码，不允许通配符；同组成员应为等价处理者，队列不保证业务恰好执行一次。

### Headers

`Headers` 接收字符串/字符串列表映射，或有序 `(key, value)` 列表。`items()` 保留本地条目。

| 规则 | 行为 |
| --- | --- |
| 出站规范化 | 键名小写，去除值首尾 ASCII 空格，保留同名重复值顺序 |
| 查询 | `get/get_all` 不区分大小写；`get` 返回首项 |
| 编辑 | `add`、下标赋值和 `update` 追加；删除移除所有大小写变体 |
| 枚举 | 反映线上键名，不保证不同键的顺序 |
| 限制 | ASCII token 键、可见 ASCII 值、32 项 / 4 KiB Headers / 64 KiB JSON |

Headers 与 payload 合计仍检查 broker 限制。Unicode 和首尾空格有意义的数据放 JSON；回复使用原生 NATS Headers，不引入业务信封。

离线新消息操作立即返回 `DISCONNECTED`，不会等待 connected、缓存重放或自动重试请求。`NO_RESPONDERS` 只表示没有匹配兴趣；不回复的订阅者使请求超时。回调异常或非法返回值在本地报告 `HANDLER_ERROR`，不向远端泄露异常文本；业务失败可返回 `{"ok": False}` 等普通 JSON。超时、取消和断线不撤销远端已产生的副作用。

### 类型与取消

公开消息类型包括 `Headers`、`Reply`、`ManyResult`、`Subscription`、`MessageContext`、`HandleContext` 和 `MessageError`。

| 项目 | 含义 |
| --- | --- |
| `MessageError` | 继承 `KinopioError`，`.partial_replies` 保存有界 `Reply` 列表 |
| 收集错误 | `BUFFER_OVERFLOW`、非法回复、权限错误和断线 |
| 原生取消 | 保留 asyncio 任务取消 |
| 取消后的部分结果 | 保留 task；捕获 `asyncio.CancelledError` 后读取 `getattr(task, "partial_replies", [])` |

较旧 Python Task 不保留传播的取消异常上的自定义属性。

### 容量与状态

| Hub `messaging` 默认项 | 值 |
| --- | --- |
| `subscriptions`、`requests` | 128、64 |
| `pending_messages`、`pending_bytes` | 4096、8388608 |
| `outbound_bytes` | 8388608 |
| 每订阅 | 256 条、1 MiB、一个运行中回调 |

接收预算包含待处理、运行中的回调及收集响应，Headers、subject 和 reply 均计入字节。满队列丢弃新消息，保留已接受 FIFO，报告 `SLOW_CONSUMER`；恢复后清除当前慢告警，但保留累计丢弃。

`hub.status()["messaging"]` 提供汇总、阶段和上限，原生库丢弃另计。这些指标无法测量 broker/网络丢失，字节预算也不等于 Python 堆或 TLS 内存上限。

Python 复用固定版本 nats-py 的帧解析、连接和消息构建，以有界接收入口替代第二份原生业务队列。主动交接先撤销旧业务兴趣，最多等待五秒完成已接受回调，再绑定新连接代次；间隙可能丢事件。请求和回复上下文始终绑定原连接，不在新连接重发。

### Drain 与所有权

Drain 期间新消息操作及状态写入返回 `DRAINING`，已接受回调仍可回复。

| 场景 | 行为 |
| --- | --- |
| Hub 受管回调内调用 Hub drain | `DRAIN_IN_HANDLER`；通知外层拥有者 |
| 订阅自身回调内 drain | `DRAIN_IN_HANDLER`；通知外层拥有者 |
| `close()` | 立即清理，可中断 drain |
| 总期限超时 | 强制清理并报告 `DRAIN_TIMEOUT` |

不能强制撤销任意同步阻塞代码和已执行设备动作。原有 live 租约语义保持独立。

跨 SDK 的主题、队列和生命周期约定见[消息语义](messaging.zh.md)。

若自管 mesh 清理超过 drain 总期限，立即返回 `DRAIN_TIMEOUT`，清理继续运行；通过 `await hub.close()` 等待清理完成。
