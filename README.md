# KinopioHub

[简体中文](README_CN.md) · [Wiki](https://github.com/skyboooox/KinopioHub/wiki)

Share variables, send events and request responses across languages and devices through `hub.var(name)`. A personally maintained project built on NATS Core, with automatic LAN nodes and SDK status reports.

```js
import KinopioHub from 'kinopio-hub';

const hub = new KinopioHub('workshop');
const battery = hub.var('battery');
battery.watch(value => console.log(value));
await battery.set(80);
```

Variables live in SDK memory. Running instances retain current values offline and merge on reconnect; when all copies exit, state disappears.

Use `pub/sub` for events and `req/handle` for requests. These messages require an active connection and are not retained or replayed. See [Events and requests](docs/messaging.md).

## Projects

| Project | Guide |
| --- | --- |
| [JavaScript](https://github.com/skyboooox/KinopioHub.JS) | [Node.js and browsers](https://github.com/skyboooox/KinopioHub/wiki/JavaScript) |
| [Python](https://github.com/skyboooox/KinopioHub.py) | [asyncio SDK](https://github.com/skyboooox/KinopioHub/wiki/Python) |
| [C++](https://github.com/skyboooox/KinopioHub.cpp) | [Native SDK](https://github.com/skyboooox/KinopioHub/wiki/Cpp) |
| [Arduino](https://github.com/skyboooox/KinopioHub.ino) | [ESP32 client](https://github.com/skyboooox/KinopioHub/wiki/Arduino) |
| [ROS](https://github.com/skyboooox/KinopioHub.ROS) | [ROS 2 bridge](https://github.com/skyboooox/KinopioHub/wiki/ROS) |
| [Web](https://github.com/skyboooox/KinopioHub.web) | [Console](https://github.com/skyboooox/KinopioHub/wiki/Web) |
| [Server](https://github.com/skyboooox/Kinopio-server) | [Optional NATS fork](https://github.com/skyboooox/KinopioHub/wiki/Server) |

Follow the installation chapter for your language. The Web console uses the JavaScript browser SDK. Python live channels have no JS, C++ or ESP32 equivalent.

## This repository

This is the documentation and workspace portal. Wiki bodies live in [docs/](docs/wiki-home.en.md); runnable integration checks live in `integration/`. Each implementation keeps its own code, tests and two README languages.

For workspace setup, checks and Wiki maintenance, see [Development](docs/development.md). Small, focused contributions are welcome through [Issues](https://github.com/skyboooox/KinopioHub/issues) or the relevant implementation repository.
