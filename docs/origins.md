# Project origins and lineage / 项目起源与血缘关系

This document records the project history supplied by the maintainer. It distinguishes implementation derivation and the NATS Server fork so that future contributors understand which behavior is original, inherited, or Kinopio-specific.

本文记录维护者提供的项目历史，并区分实现演变和 NATS Server 分支，以便后续贡献者理解哪些行为来自上游、哪些由 KinopioHub 演变而来，以及哪些属于 Kinopio 特有扩展。

## Lineage / 血缘关系

```text
       KinopioHub.JS
              │ 其他语言实现由此演变
              ├── KinopioHub.py
              ├── KinopioHub.cpp
              ├── KinopioHub.ino
              └── KinopioHub.ROS

nats-io/nats-server
              │ 下游分支 / downstream fork
              ▼
       Kinopio-server
       修改通配符订阅逻辑
```

`KinopioHub.web` is an accompanying browser application built around KinopioHub/NATS capabilities. It is not another language port in the lineage above.

`KinopioHub.web` 是围绕 KinopioHub/NATS 能力构建的浏览器应用，不属于上图中的语言移植实现。

## 1. JavaScript as the historical reference / JavaScript 参考实现

`KinopioHub.JS` was the first KinopioHub implementation. The Python, C++, Arduino, and ROS variants were derived from it. Therefore, when behavior differs and no independent protocol specification resolves the question, the JavaScript version and commit used for comparison must be recorded.

`KinopioHub.JS` 是 KinopioHub 的第一个实现。Python、C++、Arduino 和 ROS 版本均由它演变而来。因此，在缺少独立协议规范且各语言行为不一致时，应记录用作比较依据的 JavaScript 版本与提交。

This does not mean every language must reproduce JavaScript syntax or runtime details. The intended parity is observable messaging behavior: subjects, payload representation, publish/subscribe, request/reply, reconnection, discovery, and other documented protocol-visible behavior.

这并不要求其他语言复制 JavaScript 的语法或运行时细节。需要保持一致的是可观察的通信行为，包括 subject、payload 表示、发布/订阅、请求/响应、重连、发现机制，以及其他已经记录的协议可见行为。

## 2. Kinopio Server fork / 服务端分支

`Kinopio-server` is a downstream fork of [`nats-io/nats-server`](https://github.com/nats-io/nats-server). Its Kinopio-specific change is in wildcard subscription logic. The exact matching rules and the upstream commit from which each release is derived must be documented separately as the implementation evolves.

`Kinopio-server` 是 [`nats-io/nats-server`](https://github.com/nats-io/nats-server) 的下游分支，其 Kinopio 特有修改位于通配符订阅逻辑。随着实现演进，应进一步记录准确的匹配规则，以及每个版本所基于的 NATS 上游提交。

Until those rules are specified, documentation and test reports must avoid implying that Kinopio-specific wildcard behavior is provided by an unmodified NATS Server.

在这些规则形成明确规范之前，文档和测试报告不得暗示未修改的 NATS Server 具备 Kinopio 特有的通配符行为。

## 3. Information still to record / 待补充信息

- A normative description and examples of the `Kinopio-server` wildcard subscription changes.
- The upstream NATS commit or tag underlying each `Kinopio-server` release.
- Cross-language conformance cases derived from a named `KinopioHub.JS` version.

- `Kinopio-server` 通配符订阅修改的规范描述与示例。
- 每个 `Kinopio-server` 版本对应的 NATS 上游 commit 或 tag。
- 由明确 `KinopioHub.JS` 版本派生的跨语言一致性测试用例。
