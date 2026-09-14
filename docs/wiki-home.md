# KinopioHub

[English](wiki-home.en.md) · [GitHub](https://github.com/skyboooox/KinopioHub) · [快速上手](javascript.zh.md) · [API](javascript-api.zh.md)

**让不同语言和设备共享变量、发布事件、请求响应。**

统一从 `hub.var(name)` 开始。基于 NATS Core，提供局域网节点自动选举和 SDK 状态上报，由个人维护。

```js
import KinopioHub from 'kinopio-hub';

const hub = new KinopioHub('workshop');
const battery = hub.var('battery');
battery.watch(value => console.log(value));
await battery.set(80);
```

> **数据生命周期：** 值保存在 SDK 内存中，由在线副本同步；最后一个副本退出后，值随之消失。

## 从你的平台开始

| 平台 | 用途 | 上手 | 参考 |
| --- | --- | --- | --- |
| JavaScript | Node.js 与浏览器 | [快速上手](javascript.zh.md) | [API](javascript-api.zh.md) |
| Python | asyncio 应用 | [快速上手](python.zh.md) | [API](python-api.zh.md) |
| C++ | 原生 C++20 应用 | [快速上手](cpp.zh.md) | [API](cpp-api.zh.md) |
| ESP32 | Arduino 客户端 | [快速上手](arduino.zh.md) | [API](arduino-api.zh.md) |
| ROS 2 | YAML 选择 topic 与控制 | [快速上手](ros.zh.md) | [配置](ros-config.zh.md) |
| Web | 浏览器控制台 | [指南](web.zh.md) | [浏览器 SDK](javascript-api.zh.md) |
| Server | 可选的 NATS 通配符策略 | [指南](server.zh.md) | [拓扑](networking.zh.md) |

## 手册章节与阅读顺序

**第一次使用？** 按所属平台的快速上手，运行两个相同 namespace 的实例，再按需要查阅：

| 我想…… | 阅读 |
| --- | --- |
| 读写或监听当前值 | [变量与同步](variables.zh.md) |
| 发布事件、调用处理函数或收集回复 | [事件与请求](messaging.zh.md) |
| 连接设备、使用 mesh 或观察 SDK 状态 | [组网](networking.zh.md) |
| 排查问题或迁移旧客户端 | [故障排查与迁移](troubleshooting.zh.md) |
| 了解设计原理 | [工作原理](architecture.zh.md) |
| 构建、测试、贡献或发布 | [开发与维护](development.zh.md) |

每篇指南都有中英文版本。快速上手提供完整入口；API 片段沿用所在章节的导入与 Hub 配置。

## 先了解这三点

| 规则 | 对应用的影响 |
| --- | --- |
| **状态只存 RAM** | 运行中的 SDK 离线保留当前值，重连后合并；事件与请求没有离线重放。 |
| **写入不等于执行完成** | `set()` 更新本地内存，`flush()` 确认传输；动作完成须看应用结果。 |
| **Mesh 面向小型局域网** | Node.js、Python、C++ 可托管选举出的节点；浏览器和 ESP32 只做客户端。分区可短暂出现多个节点，跨网互通依赖连通的 NATS 拓扑。 |

<details>
<summary>协议与功能兼容性</summary>

- 当前状态协议：**4**；业务消息协议：**1**。
- Web 使用 JavaScript 浏览器 SDK。
- Python live 通道没有对应的 JS、C++、ESP32 API。
- 混用运行时前，查看[消息功能表](messaging.zh.md)和相应语言参考。

</details>

## 反馈

实现问题请在对应 SDK 仓库提交；文档与跨语言问题请使用 [KinopioHub Issues](https://github.com/skyboooox/KinopioHub/issues)，附版本、最小示例和实际结果。
