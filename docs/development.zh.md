# 开发说明

[English](development.md) · [首页](wiki-home.md)

保持小步修改：复现问题，修改所属项目，运行相关检查，行为变化时同步两种语言的 README 或 Wiki。跨项目问题在 KinopioHub 讨论，实现问题提交到对应 SDK 仓库。

本章目录

- [工作区](#chapter-1)
- [检查修改的项目](#chapter-2)
- [ESP32 真机](#chapter-3)
- [ROS Docker](#chapter-4)
- [GitHub Wiki](#chapter-5)

<a id="chapter-1"></a>
## 工作区

入口和七个实现分别是独立的同级 Git 仓库。准备 Git 和 Node.js 24+，在 `KinopioHub` 中运行：

```sh
node scripts/workspace.mjs bootstrap
node scripts/workspace.mjs status
node scripts/workspace.mjs setup js
node scripts/workspace.mjs test js
```

管理脚本只使用 Node 内置模块，无需 npm 安装。项目 ID 为 `js`、`python`、`cpp`、`arduino`、`ros`、`web`、`server`，各自需要相应工具链。命令清单见 [repositories.json](../repositories.json)。`bootstrap` 克隆缺失项目，`fetch` 获取远程，`pull` 只快进干净工作树。Server 合并上游需要单独审查。提交和推送按仓库分别进行。

<a id="chapter-2"></a>
## 检查修改的项目

在对应项目目录执行：

| 项目 | 检查 |
| --- | --- |
| JavaScript | `npm test`、`npm run test:types`、`npm run test:package`、`npm run test:browser` |
| Python | `uv run ruff check .`、`uv run mypy .`、`uv run pytest`、`uv build` |
| C++ | 用 `-DBUILD_TESTING=ON` 构建，再运行 `ctest --test-dir build-v3 --output-on-failure` |
| ESP32 | `node ../KinopioHub/scripts/workspace.mjs test arduino` |
| ROS | 安装 `.[test]` 后 `python -m pytest`，Docker 命令见下文 |
| Web | `npm run typecheck`、`npm run build` |
| Server | `go build .`、`go vet ./...`，定制回归见 [Server 指南](server.zh.md) |

JS 浏览器检查需要 Playwright Chromium（`npx playwright install chromium`）。源码和打包检查不能替代设备验收。Server 全量上游测试较大且有环境前提，更广改动按其 CI 分组验证。

安装 JS/Python 并构建 C++ 测试目标后，在 `KinopioHub` **依次**运行跨语言检查：

```sh
node integration/javascript-python.mjs
node integration/javascript-cpp.mjs
node integration/discovery-clients.mjs
```

覆盖值、版本、删除、晚加入、状态与共享节点接管；发现脚本检查不投票的客户端。`KINOPIO_PYTHON` 和 `KINOPIO_CPP` 可覆盖同级 Python 环境及已构建 C++ worker 路径。避免多个选举测试争用发现端口。记录精确源码版本、未提交状态、环境和失败，旧成功记录不能当作当前验收。

<a id="esp32-hardware"></a>
<a id="chapter-3"></a>
## ESP32 真机

烧录 `KinopioHub.ino/test/firmware/firmware.ino`，用私有 `KinopioTestConfig.h` 定义 `KINOPIO_WIFI_SSID` 和 `KINOPIO_WIFI_PASSWORD`。头文件放在未跟踪的位置，通过 include 路径提供。在 Arduino 仓库中执行：

```sh
PLATFORMIO_SRC_DIR=test/firmware \
PLATFORMIO_BUILD_FLAGS='-std=gnu++17 -I/absolute/path/to/private-config' \
pio run -t upload
```

关闭其他串口监视器。在 `KinopioHub` 设置 `KINOPIO_SERIAL` 为目标 ESP32 串口，`KINOPIO_PYTHON` 为安装 pyserial 的 Python，再运行 `node integration/javascript-arduino.mjs`。不设 `KINOPIO_SERVER` 时启动局域网节点；显式设置则使用可达 broker。TLS 需要 `KINOPIO_CA_FILE`，可选鉴权为 `KINOPIO_TOKEN` 或 `KINOPIO_USER` / `KINOPIO_PASSWORD`。`KINOPIO_GROUP` 选择发现域。

`integration/` 中另有 `arduino-offline.mjs`、`arduino-recovery.mjs`、`arduino-flush.mjs`、`arduino-repair.mjs`、`arduino-stalls.mjs`、`arduino-tls-negative.mjs`。局域网 fixture 需要设备可达的主机 IPv4 `KINOPIO_TEST_HOST`，停滞测试还需要 CA 文件，TLS 反例使用 OpenSSL。分别执行，这些检查会重新配置或重启设备。资源测量同时记录 Flash、静态 RAM、空闲/最低堆和负载。

<a id="ros-docker"></a>
<a id="chapter-4"></a>
## ROS Docker

准备同级 Python/ROS 源码、Docker、Node.js 和 OpenSSL，在 `KinopioHub.ROS` 执行：

```sh
node docker/check.mjs matrix
node docker/check.mjs certs
KINOPIO_DOCKER_PLATFORM=linux/arm64 node docker/check.mjs build humble
KINOPIO_DOCKER_PLATFORM=linux/arm64 node docker/check.mjs test humble
```

省略 `humble` 运行全部配置的发行版，改为 `linux/amd64` 验证该架构。跨架构需要 Docker 模拟支持。每轮隔离真实 ROS、桥接器和控制器进程，使用 TLS NATS，并测试 broker 重启。证书只是临时 fixture，可通过 `KINOPIO_TLS_DIR` 改目录。

远端检查提供 `KINOPIO_SERVER`、`KINOPIO_CA_FILE` 和可选 `KINOPIO_TEST_TOKEN`，再执行 `node docker/check.mjs test humble --remote`。远端模式跳过本地证书反例及 broker 重启。声明镜像矩阵不等于通过测试，记录时区分原生硬件与模拟运行。

<a id="chapter-5"></a>
## GitHub Wiki

公开指南正文统一放在 `KinopioHub/docs/`。每个项目只保留 `README.md` 与 `README_CN.md` 作为读者文档；许可证、第三方声明、智能体指令和 GitHub 模板按各自用途保留。示例和测试代码仍随所属项目维护。

英文 `.md` 与中文 `.zh.md` 同步修改，首页分别为 `wiki-home.en.md` 和 `wiki-home.md`，导航为 `wiki-sidebar.md`。在 `KinopioHub` 运行：

```sh
node --test scripts/workspace.test.mjs scripts/wiki.test.mjs
node scripts/workspace.mjs validate
node scripts/wiki.mjs build
node scripts/wiki.mjs check
```

`.wiki/` 是本地生成结果，不代表发布。若 Wiki 从未初始化，先在 GitHub 创建 Home，再只克隆一次独立 Wiki 仓库：

```sh
git clone https://github.com/skyboooox/KinopioHub.wiki.git .wiki/checkout
```

Wiki 工作树干净时，先拉取再编辑；线上直接修改过的内容先合回源文件。生成并审查：

```sh
git -C .wiki/checkout pull --ff-only
node scripts/wiki.mjs build --output .wiki/checkout
node scripts/wiki.mjs check --output .wiki/checkout
git -C .wiki/checkout diff
```

生成器更新带标记页面，删除明确撤下的旧生成页，拒绝覆盖无标记同名文件。新文件还需通过 `git status` 检查。审查并获得发布授权后再执行：

```sh
git -C .wiki/checkout add -A -- '*.md'
git -C .wiki/checkout commit -m "Update Wiki"
git -C .wiki/checkout push
```

入口源文件需要另行提交。发布 Wiki 不会发布 SDK 代码或软件包。真实测试地址、凭据和实验日志只放在私有开发工作区。
