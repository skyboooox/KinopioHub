# KinopioHub

KinopioHub 是 KinopioHub 项目族的统一入口：围绕作用域化 NATS 消息通信提供多语言 SDK、桥接与调试工具，并维护一个 NATS Server 下游分支。

[English](README.md)

## 项目起源

KinopioHub 最初从 `KinopioHub.JS` 开始；其他语言实现随后由 JavaScript 实现演变而来。与此同时，`Kinopio-server` 是 NATS Server 的下游分支，修改了通配符订阅逻辑。

完整的来源记录，以及 NATS 上游行为与 Kinopio 特有行为之间的区别，见[项目起源与血缘关系](docs/origins.md)。

## 项目组成

| 项目 | 定位 | 技术栈 |
| --- | --- | --- |
| [KinopioHub.JS](https://github.com/skyboooox/KinopioHub.JS) | 浏览器与 Node.js SDK | JavaScript |
| [KinopioHub.py](https://github.com/skyboooox/KinopioHub.py) | Python SDK 与本地 leaf runtime | Python |
| [KinopioHub.ROS](https://github.com/skyboooox/KinopioHub.ROS) | ROS 1/2 topic 与 service 桥接 | Python / ROS |
| [KinopioHub.web](https://github.com/skyboooox/KinopioHub.web) | 浏览器调试与运维控制台 | TypeScript / Vite |
| [KinopioHub.ino](https://github.com/skyboooox/KinopioHub.ino) | ESP32 Arduino 客户端 | C++ / Arduino |
| [KinopioHub.cpp](https://github.com/skyboooox/KinopioHub.cpp) | 原生 C++20 SDK | C++ / CMake |
| [Kinopio-server](https://github.com/skyboooox/Kinopio-server) | Kinopio 维护的 `nats-io/nats-server` 下游分支 | Go |

每个项目继续使用独立 Git 仓库、版本和构建工具。本仓库负责统一文档、工作区自动化、兼容性策略，以及未来的跨仓库集成测试。

## 本地开发工作区

推荐把所有仓库放在同一个纯本地开发目录中，并保持兄弟目录关系：

```text
KinopioHub.dev/
├── KinopioHub/          # 本入口仓库
├── KinopioHub.JS/
├── KinopioHub.py/
├── KinopioHub.ROS/
├── KinopioHub.web/
├── KinopioHub.ino/
├── KinopioHub.cpp/
└── Kinopio-server/      # NATS Server 下游分支
```

从空的开发目录开始：

```bash
gh repo clone skyboooox/KinopioHub KinopioHub
cd KinopioHub
python3 scripts/workspace.py bootstrap
```

如果安装了 [`just`](https://just.systems/)，可以使用简写命令：

```bash
just bootstrap
just status
just fetch
just setup js
just test js
```

使用 VS Code 打开 `KinopioHub.code-workspace`，即可把每个仓库作为独立的源码管理根目录使用。

## 文档

- [项目起源与血缘关系](docs/origins.md)
- [架构与仓库边界](docs/architecture.md)
- [开发工作流](docs/development.md)
- [兼容性策略](docs/compatibility.md)
- [集成测试目录](integration/README.md)

## 许可证

本入口仓库使用 GPL-3.0-or-later。`Kinopio-server` 继承 NATS Server 的 Apache-2.0 许可证；各子项目的准确许可证以对应仓库为准。
