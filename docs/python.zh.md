# Python

本手册：[安装与入门](python.zh.md) · [API 与配置参考](python-api.zh.md) · [变量语义](variables.zh.md) · [组网与状态](networking.zh.md) · [排错与迁移](troubleshooting.zh.md)

[English](python.md) · [首页](wiki-home.md) · [源码](https://github.com/skyboooox/KinopioHub.py)

使用 Python 3.10+、asyncio 和官方 NATS Python 客户端。尚未发布的 v3 重写版提供内存变量和自动局域网节点，无需 Node.js 运行时。

本章目录

- [从源码开始](#chapter-1)
- [常用 API](#chapter-2)
- [连接配置](#chapter-3)
- [live 通道](#chapter-4)

<a id="chapter-1"></a>
## 从源码开始

在 `KinopioHub.py` 中执行：

```sh
uv sync --extra dev
uv run python examples/watch.py
# In another terminal:
uv run python examples/basic.py
```

其他应用可在自身环境中用 `python -m pip install -e /path/to/KinopioHub.py` 安装当前源码。

```python
import asyncio
from kinopio_hub import KinopioHub

async def main():
    async with KinopioHub() as hub:
        battery = hub.scope("devices").var("battery")
        battery.watch(lambda value, meta: print(value))
        await battery.set(80)
        await hub.flush()

asyncio.run(main())
```

上下文管理器负责本地初始化和退出清理，进入时不等待网络连接。如果 Hub 持有某个值的唯一副本，需要保持它运行。

<a id="chapter-2"></a>
## 常用 API

| 操作 | 含义 |
| --- | --- |
| `hub.scope(name).var(name)` | 稳定引用 |
| `variable.value` / `variable.meta` | 当前值副本和元数据 |
| `await variable.set(value)` / `delete()` | 更新本地内存 |
| `variable.watch(callback)` | 同步 `(value, meta)` 回调，返回取消函数 |
| `await variable.ready()` | 等待已知状态，也可能是不存在 |
| `await hub.connected()` / `flush()` | 等待连接 / NATS 传输 |
| `hub.status()` / `hub.watch(callback)` | 本地 SDK 状态 |
| `await hub.instances.list()` / `hub.instances.watch(callback)` | 观察到的 SDK 报告 |
| `await hub.close()` | 释放资源 |

导入 `UNSET` 表示本地没有可用值，`None` 是 JSON null。`meta["exists"]` 区分未知、不存在和有值。回调必须同步且简短，可通过 `on_callback_error` 处理异常。内存生命周期、版本和状态语义见[工作原理](architecture.zh.md)。

<a id="chapter-3"></a>
## 连接配置

```python
hub = KinopioHub(
    namespace="demo",
    servers=["tls://nats.example.com:4222"],
    mesh=False,
    discovery=False,
    tls={"handshake_first": True},
)
```

仅对 TLS-first 服务器启用 `handshake_first`。客户端直连支持 TCP/TLS/WS/WSS；鉴权使用 `token` 或 `user`/`password`。自定义客户端 TLS 需要 `mesh=False`，CA 和主机名校验保持启用。

默认自动模式与 JS、C++ 共享选举域。`mesh={"group": "demo", "upstreams": ["nats://nats.example.com:7422"]}` 可将托管节点连接到真正的 leaf 入口。leaf TLS 使用 `mesh["upstream_tls"]`，字段为 `handshake_first`、`ca_file`、`cert_file`、`key_file`。`discovery=False` 只关闭旧式 UDP 提示，不关闭选举。Python 不读取 HTTP 发现清单。

公开选项使用 snake_case，时间单位为**秒**：`timeout=3`，`peer_timeout` 默认取其 80%，`health_interval=5`，`probe_interval=15`。自动模式的 `connected()` / `flush()` 默认允许 60 秒，显式设置优先。带 `_ms` 后缀的字段，包括 live 的 `max_age_ms`，仍为毫秒。默认数据限制为 10,000 个变量、16 MiB 记录数据和 1,024 个观察到的实例。

<a id="chapter-4"></a>
## live 通道

live 命令与变量分开。在已连接的 Hub 中创建接收者：

```python
channel = hub.live("robot01/control/command")
stop = await channel.subscribe(lambda value: print(value), max_age_ms=300)
# Keep this receiver running; later: await stop()
```

同一 namespace 内的另一个已连接 Hub 发送：`await hub.live("robot01/control/command").send({"data": "step"}, timeout=3)`。

整个部署中，**每个通道只配置一个接收者**，SDK 不进行跨进程所有权协调。相同值的每次发送都是独立命令。接收者签发的租约拒绝过期、重复、乱序和旧连接消息；断连后租约失效，不重放。发送成功仅确认传输，不确认执行。

如果需要延后执行，订阅时传入 `with_context=True`，回调接收 `(value, context)`；实际执行前检查 `context.is_valid()`，`expires_at` 使用本地单调时钟。[ROS 控制](ros.zh.md#反向控制)使用这条路径，其他 SDK 尚无对应 API。

还提供 `offline.py` 和 `sdk_status.py` 示例，接受 `KINOPIO_EXAMPLE_SERVERS`、`KINOPIO_TOKEN`、`KINOPIO_EXAMPLE_TLS_FIRST=1`、`KINOPIO_MESH=0`、`KINOPIO_LEAF_SERVERS`。测试命令见[开发说明](development.zh.md)。v3 移除了旧 CLI 和独立 leaf API。
