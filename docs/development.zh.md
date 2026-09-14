# 开发说明

[English](development.md) · [首页](wiki-home.md)

**欢迎小而明确的改进。** 复现问题、修改所属项目、运行相关检查，并同步中英文文档。

| 问题 | 提交位置 |
| --- | --- |
| 跨项目行为或文档 | KinopioHub |
| SDK 实现 | 对应 SDK 仓库 |

本章目录

- [工作区](#chapter-1)
- [检查修改的项目](#chapter-2)
- [ESP32 真机](#chapter-3)
- [ROS Docker](#chapter-4)
- [GitHub Wiki](#chapter-5)
- [发布流程](#chapter-6)

<a id="chapter-1"></a>
## 工作区

入口和七个实现分别是独立的同级 Git 仓库。准备 Git 和 Node.js 24+，在 `KinopioHub` 中运行：

```sh
node scripts/workspace.mjs bootstrap
node scripts/workspace.mjs status
node scripts/workspace.mjs setup js
node scripts/workspace.mjs test js
```

管理脚本只使用 Node 内置模块，无需 npm 安装。各项目仍需自己的工具链。ID：`js`、`python`、`cpp`、`arduino`、`ros`、`web`、`server`。

| 命令 | 作用 |
| --- | --- |
| `bootstrap` | 克隆缺失项目 |
| `fetch` | 获取远程 |
| `pull` | 只快进干净工作树 |

命令清单见 [repositories.json](../repositories.json)。Server 合并上游单独审查；提交和推送按仓库分别进行。

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
node integration/messaging.mjs
node integration/javascript-cpp.mjs
node integration/discovery-clients.mjs
```

覆盖值、版本、删除、晚加入、状态与共享节点接管；发现脚本检查不投票的客户端。`KINOPIO_PYTHON` 和 `KINOPIO_CPP` 可覆盖同级 Python 环境及已构建 C++ worker 路径。局域网选举检查共享发现端口，请依次运行。

### 消息互通

| 脚本 | 覆盖范围 |
| --- | --- |
| `integration/messaging.mjs` | 共享编码、双向事件/请求/Headers、多响应、混合语言队列、健康与清理；使用临时本地 broker |
| `node integration/messaging-matrix.mjs` | 加入真实 Chromium 和临时鉴权 TLS broker，需要 OpenSSL |

| 环境变量 | 选择对象 |
| --- | --- |
| `KINOPIO_CPP_WORKER` | C++ `messaging-worker` 可执行文件 |
| `KINOPIO_SERIAL` | ESP32 串口 |
| `KINOPIO_TEST_HOST` | ESP32 可达的主机 IPv4 |

所选 Python 需安装同级 SDK 和 pyserial。

矩阵按 ESP32 基础 API 验证：使用精确话题订阅和单响应调用，确认带桌面端 Headers 的消息仍能向设备投递 JSON，并让设备回答多响应收集、调用队列服务。完整 Headers、通配符、多响应调用端和队列工作者检查在 JS、Python、C++ 上执行。

<a id="esp32-hardware"></a>
<a id="chapter-3"></a>
## ESP32 真机

1. 使用 `KinopioHub.ino/test/firmware/firmware.ino`，在私有 `KinopioTestConfig.h` 中定义 `KINOPIO_WIFI_SSID` 和 `KINOPIO_WIFI_PASSWORD`。
2. 将 SDK 的 `platformio.ini` 复制为被忽略的测试配置。`src_dir` 指向固件，`build_flags` 加入私有头文件目录；项目外配置使用绝对路径。
3. 构建后核对应用分区容量，再从 Arduino 仓库烧录。

> **测试分区：** 额外仪器逻辑使固件超限时，可在私有配置设置 `board_build.partitions = huge_app.csv`；该布局没有 OTA 槽。普通示例保留默认应用分区。

```sh
pio run -c /absolute/path/to/private-test.ini -t upload
```

关闭其他串口监视器。在 `KinopioHub` 运行 `node integration/javascript-arduino.mjs`，配置：

| 环境变量 | 用途 |
| --- | --- |
| `KINOPIO_SERIAL` | 目标 ESP32 串口 |
| `KINOPIO_PYTHON` | 安装 pyserial 的 Python |
| `KINOPIO_SERVER` | 可达 broker；省略时启动局域网节点 |
| `KINOPIO_CA_FILE` | TLS 必填 |
| `KINOPIO_TOKEN` 或 `KINOPIO_USER` / `KINOPIO_PASSWORD` | 可选鉴权 |
| `KINOPIO_GROUP` | 发现域 |

<details>
<summary>其他设备检查</summary>

脚本均位于 `integration/`：

| 范围 | 脚本 |
| --- | --- |
| 离线、恢复与命名空间 | `arduino-offline.mjs`、`arduino-recovery.mjs`、`arduino-namespace.mjs` |
| 传输与修复 | `arduino-flush.mjs`、`arduino-repair.mjs`、`arduino-stalls.mjs` |
| TLS 失败 | `arduino-tls-negative.mjs` |
| 消息生命周期 | `messaging-arduino-lifecycle.mjs` |

生命周期脚本使用临时 TLS broker，验证快照所有权、延迟回复、有界过载、取消与 Wi-Fi 恢复。

局域网 fixture 需要 ESP32 可达的 `KINOPIO_TEST_HOST`；停滞测试还需 CA 文件，TLS 检查使用 OpenSSL。

</details>

> **设备检查分别执行：** 脚本可能重配或重启设备。结合应用负载测量 Flash、静态 RAM、空闲堆与最低空闲堆。

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

| 选择 | 配置 |
| --- | --- |
| 所有配置的发行版 | 省略 `humble` |
| amd64 | 使用 `linux/amd64` 再运行 |
| 跨架构执行 | 需要 Docker 仿真 |
| 证书位置 | 临时 fixture，可用 `KINOPIO_TLS_DIR` 覆盖 |

每次运行隔离真实 ROS、桥接和控制进程，通过 TLS NATS 连接，并包含 broker 重启。

远端检查提供 `KINOPIO_SERVER`、`KINOPIO_CA_FILE` 和可选 `KINOPIO_TEST_TOKEN`，再执行 `node docker/check.mjs test humble --remote`。远端模式跳过本地证书反例及 broker 重启。镜像矩阵描述目标环境，解释覆盖范围时需区分原生硬件与模拟运行。

<a id="chapter-5"></a>
<a id="github-wiki"></a>
## GitHub Wiki

公开指南正文统一放在 `KinopioHub/docs/`。每个项目只保留 `README.md` 与 `README_CN.md` 作为读者文档；许可证、第三方声明、智能体指令和 GitHub 模板按各自用途保留。示例和测试代码仍随所属项目维护。

中英文同步编辑：

| 源文件 | 生成的 Wiki 页面 |
| --- | --- |
| 英文 `.md` / 中文 `.zh.md` | 对应的双语指南 |
| `wiki-home.en.md` | `Home`，默认英文入口 |
| `wiki-home.md` | `Home-ZH` |
| `wiki-sidebar.md` | 英文优先导航，附中文链接 |
| 自动生成的兼容入口 | `Home-EN` 保留旧链接 |

在 `KinopioHub` 执行：

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

生成器更新带标记页面，删除明确撤下的旧生成页，拒绝覆盖无标记同名文件。新文件还需通过 `git status` 检查。审查生成差异后发布：

```sh
git -C .wiki/checkout add -A -- '*.md'
git -C .wiki/checkout commit -m "Update Wiki"
git -C .wiki/checkout push
```

入口源文件需要另行提交。发布 Wiki 不会发布 SDK 代码或软件包。真实测试地址、凭据和实验日志只放在私有开发工作区。

<a id="chapter-6"></a>
## 发布流程

每个仓库从发布标签指向的提交构建构件。发布前核对版本元数据、许可证、包内文件和文档示例。未解决缺陷与验证缺口统一跟踪在维护者 TODO；用户手册说明支持的行为及使用限制。

| 项目 | 构件与安装检查 |
| --- | --- |
| JavaScript | 检查 `npm pack --dry-run`，运行 `npm run test:package`，再将打包文件安装到干净的消费项目并运行示例。 |
| Python | 用 `uv build` 构建 wheel 与源码包，在干净环境安装 wheel 并运行文档中的 asyncio 示例。 |
| C++ | 安装到临时 CMake 前缀，验证消费项目通过 `find_package(KinopioHub CONFIG REQUIRED)` 使用库。 |
| ESP32 | 从打包库及锁定依赖编译，检查包中没有私有头文件，并执行相关设备验收。 |
| ROS | 构建 wheel 与源码包，使用配套 Python SDK 验证示例 YAML 和选定的 Docker 环境。 |
| Server | 单独构建和测试 fork；自身版本及上游基线与 SDK 自动节点固定的执行文件分别维护。 |

1. 先发布 Python，再发布 ROS（依赖 `kinopio-hub==3.0.0`）。
2. 先发布 JavaScript，再使用该依赖构建和部署 Web。
3. 上传后验证注册表或发布附件安装；源码通过不代表分发构件通过。
4. 按[迁移指南](troubleshooting.zh.md#chapter-6)，将参与互通的 SDK 一起升级到协议 4。

SDK 安装说明与已验收构件一致后，发布入口仓库正文及生成的 Wiki。标签、GitHub Release、包注册表和独立 Wiki 仓库是不同的发布步骤，应分别核对结果。构件不得包含私有测试入口、凭据、设备测试头文件或内部实验输出。
