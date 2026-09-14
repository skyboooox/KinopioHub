# Development

[简体中文](development.zh.md) · [Home](wiki-home.en.md)

**Small, focused contributions are welcome.** Reproduce the problem, change the owning project, run relevant checks and update both documentation languages.

| Question | Where to ask |
| --- | --- |
| Cross-project behavior or documentation | KinopioHub |
| SDK implementation | That SDK repository |

In this chapter

- [Workspace](#chapter-1)
- [Check the changed project](#chapter-2)
- [ESP32 hardware](#chapter-3)
- [ROS Docker](#chapter-4)
- [GitHub Wiki](#chapter-5)
- [Publishing](#chapter-6)

<a id="chapter-1"></a>
## Workspace

The portal and seven implementation repositories are independent sibling Git repositories. With Git and Node.js 24+, run in `KinopioHub`:

```sh
node scripts/workspace.mjs bootstrap
node scripts/workspace.mjs status
node scripts/workspace.mjs setup js
node scripts/workspace.mjs test js
```

The manager uses Node built-ins, with no npm setup. Each project needs its own toolchain. IDs: `js`, `python`, `cpp`, `arduino`, `ros`, `web`, `server`.

| Command | Effect |
| --- | --- |
| `bootstrap` | Clone missing projects |
| `fetch` | Fetch remotes |
| `pull` | Fast-forward clean checkouts only |

See [repositories.json](../repositories.json) for the command list. Review Server upstream merges separately; commit and push each repository independently.

<a id="chapter-2"></a>
## Check the changed project

Run commands from that project's directory:

| Project | Checks |
| --- | --- |
| JavaScript | `npm test`, `npm run test:types`, `npm run test:package`, `npm run test:browser` |
| Python | `uv run ruff check .`, `uv run mypy .`, `uv run pytest`, `uv build` |
| C++ | Build with `-DBUILD_TESTING=ON`, then `ctest --test-dir build-v3 --output-on-failure` |
| ESP32 | `node ../KinopioHub/scripts/workspace.mjs test arduino` |
| ROS | Install `.[test]`, then `python -m pytest`; Docker commands below |
| Web | `npm run typecheck`, `npm run build` |
| Server | `go build .`, `go vet ./...`, focused fork checks from the [Server guide](server.md) |

JS browser checks require Playwright Chromium (`npx playwright install chromium`). Source and package checks do not replace device tests. Server's full upstream suite is large and has environment prerequisites; use its CI groups for broader changes.

After installing JS/Python and building C++ test targets, run cross-language checks **one at a time** from `KinopioHub`:

```sh
node integration/javascript-python.mjs
node integration/messaging.mjs
node integration/javascript-cpp.mjs
node integration/discovery-clients.mjs
```

These cover values, versions, deletion, late join, reports and shared-node takeover; the discovery runner checks non-voting clients. `KINOPIO_PYTHON` and `KINOPIO_CPP` override the sibling Python environment and built C++ worker. Run LAN-election checks one at a time because they share the discovery port.

### Message interoperability

| Runner | Coverage |
| --- | --- |
| `integration/messaging.mjs` | Shared encoding, bidirectional events/requests/Headers, response collection, mixed-language queues, health and cleanup; temporary local broker |
| `node integration/messaging-matrix.mjs` | Adds real Chromium and a temporary authenticated TLS broker; requires OpenSSL |

| Environment | Selects |
| --- | --- |
| `KINOPIO_CPP_WORKER` | C++ `messaging-worker` executable |
| `KINOPIO_SERIAL` | ESP32 serial port |
| `KINOPIO_TEST_HOST` | Host IPv4 reachable from ESP32 |

The selected Python needs the sibling SDK and pyserial.

The matrix respects ESP32's basic API: exact-name subscriptions and single-response calls, JSON delivery from messages carrying desktop Headers, and the device as a gather responder and queue-service caller. Full Headers, wildcard, collection and queue-worker checks run on JS, Python and C++.

<a id="esp32-hardware"></a>
<a id="chapter-3"></a>
## ESP32 hardware

1. Use `KinopioHub.ino/test/firmware/firmware.ino`. Define `KINOPIO_WIFI_SSID` and `KINOPIO_WIFI_PASSWORD` in a private `KinopioTestConfig.h`.
2. Copy the SDK's `platformio.ini` to an ignored test configuration. Point `src_dir` at the firmware and add the header directory to `build_flags`. Use absolute paths for an external configuration.
3. Check built size against the application partition, then upload from the Arduino repository.

> **Test partition:** If extra instrumentation exceeds capacity, the private fixture can use `board_build.partitions = huge_app.csv`. This layout has no OTA slot. Ordinary examples retain the default application partition.

```sh
pio run -c /absolute/path/to/private-test.ini -t upload
```

Close other serial monitors. From `KinopioHub`, run `node integration/javascript-arduino.mjs` with:

| Environment | Purpose |
| --- | --- |
| `KINOPIO_SERIAL` | Intended ESP32 port |
| `KINOPIO_PYTHON` | Python with pyserial |
| `KINOPIO_SERVER` | Reachable broker; omit to start a LAN node |
| `KINOPIO_CA_FILE` | Required for TLS |
| `KINOPIO_TOKEN` or `KINOPIO_USER` / `KINOPIO_PASSWORD` | Optional authentication |
| `KINOPIO_GROUP` | Discovery domain |

<details>
<summary>Additional device checks</summary>

All runners live under `integration/`:

| Area | Runner |
| --- | --- |
| Offline, recovery and namespaces | `arduino-offline.mjs`, `arduino-recovery.mjs`, `arduino-namespace.mjs` |
| Transport and repair | `arduino-flush.mjs`, `arduino-repair.mjs`, `arduino-stalls.mjs` |
| TLS failures | `arduino-tls-negative.mjs` |
| Messaging lifecycle | `messaging-arduino-lifecycle.mjs` |

The lifecycle runner uses a temporary TLS broker for snapshot ownership, deferred replies, bounded overload, cancellation and Wi-Fi recovery.

LAN fixtures need an ESP32-reachable `KINOPIO_TEST_HOST`; stalls also need a CA file. TLS checks use OpenSSL.

</details>

> **Run device checks separately:** They can reconfigure or reboot the board. Measure flash, static RAM, free/minimum heap and the application workload together.

<a id="ros-docker"></a>
<a id="chapter-4"></a>
## ROS Docker

With sibling Python/ROS checkouts, Docker, Node.js and OpenSSL, run in `KinopioHub.ROS`:

```sh
node docker/check.mjs matrix
node docker/check.mjs certs
KINOPIO_DOCKER_PLATFORM=linux/arm64 node docker/check.mjs build humble
KINOPIO_DOCKER_PLATFORM=linux/arm64 node docker/check.mjs test humble
```

| Choice | Configuration |
| --- | --- |
| All configured distributions | Omit `humble` |
| amd64 | Repeat with `linux/amd64` |
| Cross-architecture execution | Requires Docker emulation |
| Certificate location | Temporary fixtures; override with `KINOPIO_TLS_DIR` |

Each run isolates real ROS, bridge and controller processes and uses TLS NATS, including broker restart.

For a trusted remote server, provide `KINOPIO_SERVER`, `KINOPIO_CA_FILE` and optional `KINOPIO_TEST_TOKEN`, then use `node docker/check.mjs test humble --remote`. Remote mode skips local certificate-negative and broker-restart cases. The configured matrix describes target environments; distinguish native hardware from emulation when interpreting coverage.

<a id="chapter-5"></a>
<a id="github-wiki"></a>
## GitHub Wiki

All public guide bodies live in `KinopioHub/docs/`. Each project keeps only `README.md` and `README_CN.md` as reader documentation; licenses, third-party notices, agent instructions and GitHub templates retain their own roles. Examples and test code stay with their projects.

Edit both languages together:

| Source | Generated Wiki page |
| --- | --- |
| English `.md` / Chinese `.zh.md` | Matching guide pair |
| `wiki-home.en.md` | `Home` — default English entry |
| `wiki-home.md` | `Home-ZH` |
| `wiki-sidebar.md` | English-first navigation with Chinese links |
| Generated compatibility entry | `Home-EN` keeps older links working |

Run from `KinopioHub`:

```sh
node --test scripts/workspace.test.mjs scripts/wiki.test.mjs
node scripts/workspace.mjs validate
node scripts/wiki.mjs build
node scripts/wiki.mjs check
```

`.wiki/` is generated local output, not a publication. To publish, first create Home on GitHub if the Wiki has never been initialized, then clone its separate repository once:

```sh
git clone https://github.com/skyboooox/KinopioHub.wiki.git .wiki/checkout
```

With a clean Wiki checkout, pull before editing it. Import any direct Wiki edits into the source first. Generate and review:

```sh
git -C .wiki/checkout pull --ff-only
node scripts/wiki.mjs build --output .wiki/checkout
node scripts/wiki.mjs check --output .wiki/checkout
git -C .wiki/checkout diff
```

The generator updates marked pages and removes explicitly retired generated pages; it refuses unmarked collisions. Review new files with `git status` too. Review the generated diff before publishing:

```sh
git -C .wiki/checkout add -A -- '*.md'
git -C .wiki/checkout commit -m "Update Wiki"
git -C .wiki/checkout push
```

Commit portal sources separately. Publishing a Wiki does not publish SDK code or packages. Keep real test endpoints, credentials and experiment logs in the private development workspace.

<a id="chapter-6"></a>
## Publishing

Build each repository’s artifacts from the commit named by its release tag. Check version metadata, licenses, packaged files and documented examples before publishing. Track unresolved defects and validation gaps in the maintainer TODO; user manuals describe supported behavior and relevant limits.

| Project | Artifact and installation check |
| --- | --- |
| JavaScript | Inspect `npm pack --dry-run`, run `npm run test:package`, then install the built tarball in a clean consumer and run an example. |
| Python | Build wheel and source archive with `uv build`; install the wheel in a clean environment and run the documented asyncio example. |
| C++ | Verify a CMake install in a temporary prefix and a consumer using `find_package(KinopioHub CONFIG REQUIRED)`. |
| ESP32 | Build from the packaged library with its pinned dependencies; inspect contents for private headers and run the relevant device checks. |
| ROS | Build its wheel/source archive and validate the example YAML and selected Docker targets with the matching Python SDK. |
| Server | Build and test the fork separately; its version and upstream base are distinct from the SDKs' pinned automatic-node binary. |

1. Publish Python before ROS (`kinopio-hub==3.0.0`).
2. Publish JavaScript before building and deploying Web with that dependency.
3. Verify registry or release-attachment installation after upload. Source-checkout success does not verify the distributed artifact.
4. Upgrade participating SDKs together to protocol 4 using the [migration guide](troubleshooting.md#chapter-6).

Publish the portal sources and generated Wiki after the reviewed SDK instructions and artifacts agree. Tags, GitHub releases, package registries and the separate Wiki repository are distinct publication steps; check each result. Never include private endpoints, credentials, device test headers or internal experiment output in an artifact.
