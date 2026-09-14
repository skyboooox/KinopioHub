# KinopioHub

[English](README.md) · [中文手册](https://github.com/skyboooox/KinopioHub/wiki/Home-ZH)

通过 `hub.var(name)` 在不同语言和设备之间共享变量、发布事件和请求响应。一个基于 NATS Core 的个人项目，提供自动局域网节点和 SDK 状态报告。

```js
import KinopioHub from 'kinopio-hub';

const hub = new KinopioHub('workshop');
const battery = hub.var('battery');
battery.watch(value => console.log(value));
await battery.set(80);
```

变量只在 SDK 内存中保存。仍在运行的实例断网后保留当前值，重连时合并；全部副本退出后，状态消失。

事件使用 `pub/sub`，请求使用 `req/handle`。这些消息需要活动连接，不保留、不重放，详见[事件与请求](docs/messaging.zh.md)。

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

安装方式见各语言章节。Web 控制台使用 JavaScript 浏览器 SDK。Python live 通道没有对应的 JS、C++、ESP32 API。

## 本仓库

这里是文档与工作区入口。Wiki 正文在 [docs/](docs/wiki-home.md)，可运行的跨项目检查在 `integration/`。各实现分别维护代码、测试和中英文 README。

工作区恢复、检查和 Wiki 维护见[开发说明](docs/development.zh.md)。欢迎通过 [Issues](https://github.com/skyboooox/KinopioHub/issues) 或对应实现仓库提交小而明确的改进。
