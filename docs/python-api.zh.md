# Python API 参考

[English](python-api.md) · [入门](python.zh.md) · [首页](wiki-home.md)

对应尚未发布的 3.0.0，使用 Python 3.10+ 与 asyncio。公开导出包含 `KinopioHub`、`Scope`、`Variable`、`KinopioError`、`UNSET`、`LiveChannel`、`LiveContext`、`__version__`。

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
    async with KinopioHub(namespace="workshop", name="monitor") as hub:
        await hub.connected()
        battery = hub.scope("devices").var("battery")
        await battery.ready()
        if battery.value is not UNSET:
            print(battery.value)

asyncio.run(main())
```

一个 Hub 及其操作应使用同一个 asyncio 事件循环。在运行中的循环内构造会启动初始化，否则延后到异步操作初始化时启动。进入上下文管理器等待本地初始化，不等待联网；退出时关闭 Hub。

`await hub.ready()`、`await hub.connected(timeout=None)` 返回 Hub；`await hub.flush(timeout=None)`、`await hub.close()` 不返回业务值。`hub.instance_id` 标识运行实例，`hub.state` 是本地连接状态。关闭不保存记录，也不隐含最后一次 flush。

<a id="chapter-2"></a>
## 2. 构造参数

签名为 `KinopioHub(namespace="default", servers=None, mesh=True, **options)`。Python 参数使用 snake_case，常规时长单位为**秒**，明确以 `_ms` 结尾的字段为毫秒。

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `namespace` | `"default"` | 共享数据命名空间 |
| `name` | SDK 默认值 | 显示名，与运行身份分开 |
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

没有显式超时覆盖时，自动模式 `connected()` 与 `flush()` 默认允许 60 秒。TLS 字典的证书配置接受 `ca_file`、`cert_file`、`key_file`、`handshake_first`。`mesh` 字典接受 `group`、`binary`、`upstreams`、`upstream_tls`，leaf TLS 使用同样的 snake_case 证书字段。Python 应用中的证书路径由应用使用；ROS 另行提供 YAML 相对路径解析。

<a id="chapter-3"></a>
## 3. 变量

| 成员 | 结果 |
| --- | --- |
| `hub.scope(name).var(name)` | 稳定引用 |
| `variable.value` | JSON 相容副本，或 `UNSET` 哨兵 |
| `variable.meta` | 初始化、存在性、版本、待发布与连接状态字典 |
| `await variable.set(value)` | 本地 RAM 写入 |
| `await variable.delete()` | 带版本删除 |
| `await variable.ready(timeout=None)` | 本地状态初始化后的变量 |
| `variable.watch(callback)` | 同步停止函数 |

用身份比较判断 `UNSET`。`None`、`False`、零、空容器都是有效值，不能用真假判断区分缺失。`meta["exists"]` 未知时为 `None`、缺失为 `False`、存在为 `True`。虽然构造参数使用 snake_case，元数据/报告中的 `instanceId`、`pendingVariables` 等仍保留共用协议字段名。

```python
battery = hub.scope("devices").var("battery")
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
    lambda items: print([(item["name"], item["online"]) for item in items])
)
reports = await hub.instances.list()
# Call stop() during cleanup.
```

`hub.status()` 为同步方法。回调保持简短，较长工作交给显式管理且限制并发的任务。关闭时除停止监听外，也应停止应用任务。`on_callback_error` 同样必须同步。

<a id="live"></a>
<a id="chapter-5"></a>
## 5. Live 通道

`hub.live(name)` 返回当前 Hub namespace 下的通道。收发两端使用相同名称；ROS live 路由通常是 `robot/variable`，例如 `robot01/control/command`。live 通道不会创建云变量。

| 方法 | 参数与结果 |
| --- | --- |
| `await channel.subscribe(callback, max_age_ms=300, with_context=False)` | 注册同步接收回调，返回异步停止函数 |
| `await channel.send(value, timeout=3)` | 通过有效连接发送一条命令，确认传输 |
| `context.is_valid()` | 延后执行的工作是否仍属于有效接收会话与租约 |
| `context.expires_at` | 本地单调时钟截止时间，不是 UTC 或另一台设备的时间 |

双方必须已连接。接收租约时长接受 1–60,000 毫秒。部署时每个通道只放一个接收者，不做跨进程所有权协调。同一通道对象并发发送可能返回 `BUSY`，应串行发送。无接收者、断连或租约过期都可能导致发送失败。

```python
channel = hub.live("robot01/control/command")
stop = await channel.subscribe(lambda value: print(value), max_age_ms=300)
try:
    await asyncio.Event().wait()
finally:
    await stop()
```

接收段在已连接的 Hub 中运行。第二个已连接 Hub 调用 `await hub.live("robot01/control/command").send({"data": "step"})`。两次相同 JSON 是两条命令，重连后不会重放。

设置 `with_context=True` 后，回调接受 `(value, context)`。如果将工作排入队列，真正动作前立即检查 `context.is_valid()`。不要用系统时钟比较代替接收者的单调时钟检查。发送成功不是完成回执，需要应用反馈，必要时使用本地控制器 watchdog。

<a id="chapter-6"></a>
## 6. 错误与集成

捕获 `KinopioError` 后读取 `.code`，后台连接和报告错误检查本地 `status()`。`TIMEOUT`、`DISCONNECTED`、`CLOSED` 对应不同生命周期状态，传输等待失败不清除本地值。限制重试并发，尤其是 live 操作。

先安装本地 3.0.0 Python SDK，再安装匹配的 ROS 桥接。不依赖 Node 运行时，不提供旧 CLI 或独立 leaf API。路由特有行为见 [ROS 配置](ros-config.zh.md)，源码测试和互通检查见[开发说明](development.zh.md)。
