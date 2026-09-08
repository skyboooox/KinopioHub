# KinopioHub

除 Web 外，项目版本统一为 **3.0.0**，尚未发布。Web 不在本次版本调整范围，仍依赖 2.x SDK。第三方依赖保留各自版本。

[English](wiki-home.en.md) · [GitHub](https://github.com/skyboooox/KinopioHub)

让不同语言和设备像使用本地变量一样，共享同一个当前值。

```js
const battery = hub.scope('devices').var('battery');
battery.watch(value => console.log(value));
await battery.set(80);
```

KinopioHub 是一个个人维护的云变量项目。变量在 SDK 内存中保存，经 NATS Core 与在线设备同步。Node.js、Python 和 C++ 可以自动发现、选举并启动局域网节点；浏览器和 ESP32 只需接入。

## 从你的平台开始

| 项目 | 用途 | 当前状态 |
| --- | --- | --- |
| [JavaScript](javascript.zh.md) | Node.js、浏览器 | v3 源码重写 |
| [Python](python.zh.md) | asyncio 应用 | v3 源码重写 |
| [C++](cpp.zh.md) | 原生 C++20 应用 | v3 源码重写 |
| [ESP32 Arduino](arduino.zh.md) | 嵌入式客户端 | v3 源码重写 |
| [ROS 2](ros.zh.md) | YAML 选择 topic，双向控制 | v3 源码重写 |
| [Web](web.zh.md) | subject 调试控制台 | 仍使用 v2，待迁移 |
| [Server](server.zh.md) | 可选的 NATS 通配符策略 | 上游分支定制 |

这里的 v3 重写尚未发布，请使用包含重写代码的本地源码；安装现有公开包不会取得这些改动。v3 不兼容旧版 API 和消息协议。Python 提供的 live 控制通道目前没有对应的 JS、C++、ESP32 API。

## 手册章节与阅读顺序

第一次使用，先选择下面的语言入门页，运行两个实例；再阅读变量语义与连接模式。开发时按 API/配置参考查参数，遇到问题看排错。

1. [变量与同步](variables.zh.md)：命名、JSON、读写监听、并发覆盖、删除与离线生命周期。
2. [连接、mesh 与 SDK 状态](networking.zh.md)：直连、自动节点、leaf 上游、状态字段与在线判断。
3. 各语言手册：

| SDK | 入门章节 | 参考章节 |
| --- | --- | --- |
| JavaScript | [安装与入门](javascript.zh.md) | [API 与配置](javascript-api.zh.md) |
| Python | [安装与入门](python.zh.md) | [API 与配置](python-api.zh.md) |
| C++ | [安装与入门](cpp.zh.md) | [API 与配置](cpp-api.zh.md) |
| ESP32 | [安装与入门](arduino.zh.md) | [API 与配置](arduino-api.zh.md) |
| ROS 2 | [安装与入门](ros.zh.md) | [API 与配置](ros-config.zh.md) |

4. [故障排查与迁移](troubleshooting.zh.md)：连接、TLS、容量、回调和旧版本迁移。
5. [Server](server.zh.md) 与[开发说明](development.zh.md)：broker 配置、源码构建、互通/设备验收及 Wiki 维护。

每章顶部有页内目录，中英文页面使用对应章节。API 片段默认已有本章说明的 Hub、导入和运行环境，完整入口示例在各语言入门页。

## 先了解这三点

- **只共享当前值。** 断网时，仍在运行的 SDK 可以继续读写，重连后合并；全部副本退出后，状态消失。
- **写入不是执行确认。** `set()` 完成本地内存更新，`flush()` 确认 NATS 传输。设备是否完成操作，应由设备另行报告。
- **自动节点面向小型局域网。** 网络分区可以各自运行，恢复通信后收敛为一个节点。跨网络通信需要配置真正互通的 NATS 拓扑。

详见[工作原理](architecture.zh.md)。代码和文档的维护方式、测试命令见[开发说明](development.zh.md)。

## 反馈

欢迎小而明确的问题和改进。SDK 问题请到对应仓库提 Issue；跨语言或文档问题请到 [KinopioHub Issues](https://github.com/skyboooox/KinopioHub/issues)，附上版本、最小示例和实际结果。
