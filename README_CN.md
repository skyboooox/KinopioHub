# KinopioHub

项目版本：**3.0.0**（尚未发布）。

[English](README.md) · [Wiki](https://github.com/skyboooox/KinopioHub/wiki)

在不同语言和设备之间共享同一个当前变量。一个基于 NATS Core 的个人项目，提供自动局域网节点和 SDK 状态报告。

```js
const battery = hub.scope('devices').var('battery');
battery.watch(value => console.log(value));
await battery.set(80);
```

变量只在 SDK 内存中保存。仍在运行的实例断网后保留当前值，重连时合并；全部副本退出后，状态消失。

## 项目

| 项目 | 指南 |
| --- | --- |
| [JavaScript](https://github.com/skyboooox/KinopioHub.JS) | [Node.js 和浏览器](https://github.com/skyboooox/KinopioHub/wiki/JavaScript-ZH) |
| [Python](https://github.com/skyboooox/KinopioHub.py) | [asyncio SDK](https://github.com/skyboooox/KinopioHub/wiki/Python-ZH) |
| [C++](https://github.com/skyboooox/KinopioHub.cpp) | [原生 SDK](https://github.com/skyboooox/KinopioHub/wiki/Cpp-ZH) |
| [Arduino](https://github.com/skyboooox/KinopioHub.ino) | [ESP32 客户端](https://github.com/skyboooox/KinopioHub/wiki/Arduino-ZH) |
| [ROS](https://github.com/skyboooox/KinopioHub.ROS) | [ROS 2 桥接](https://github.com/skyboooox/KinopioHub/wiki/ROS-ZH) |
| [Web](https://github.com/skyboooox/KinopioHub.web) | [控制台](https://github.com/skyboooox/KinopioHub/wiki/Web-ZH) |
| [Server](https://github.com/skyboooox/Kinopio-server) | [可选 NATS 分支](https://github.com/skyboooox/KinopioHub/wiki/Server-ZH) |

JS、Python、C++、ESP32 和 ROS 的 v3 重写目前仍是未发布的本地源码，Web 仍使用 v2。现有公开包不包含这些重写；v3 同时更换 API 和消息协议。

## 本仓库

这里是文档与工作区入口。Wiki 正文在 [docs/](docs/wiki-home.md)，可运行的跨项目检查在 `integration/`。各实现分别维护代码、测试和中英文 README。

工作区恢复、检查和 Wiki 维护见[开发说明](docs/development.zh.md)。欢迎通过 [Issues](https://github.com/skyboooox/KinopioHub/issues) 或对应实现仓库提交小而明确的改进。
