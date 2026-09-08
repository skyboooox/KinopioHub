# Development

[简体中文](development.zh.md) · [Home](wiki-home.en.md)

Keep changes small: reproduce a problem, change the owning project, run its relevant checks, and update both README languages or the Wiki page when behavior changes. Open cross-project questions in KinopioHub; implementation issues belong in the SDK repository.

In this chapter

- [Workspace](#chapter-1)
- [Check the changed project](#chapter-2)
- [ESP32 hardware](#chapter-3)
- [ROS Docker](#chapter-4)
- [GitHub Wiki](#chapter-5)

<a id="chapter-1"></a>
## Workspace

The portal and seven implementation repositories are independent sibling Git repositories. With Git and Node.js 24+, run in `KinopioHub`:

```sh
node scripts/workspace.mjs bootstrap
node scripts/workspace.mjs status
node scripts/workspace.mjs setup js
node scripts/workspace.mjs test js
```

The manager uses Node built-ins, with no npm setup. Repository IDs are `js`, `python`, `cpp`, `arduino`, `ros`, `web`, `server`; each needs its own toolchain. The command list lives in [repositories.json](../repositories.json). `bootstrap` clones missing projects; `fetch` fetches remotes; `pull` only fast-forwards clean checkouts. Server upstream merging is a separate review step. Commit and push each repository separately.

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
node integration/javascript-cpp.mjs
node integration/discovery-clients.mjs
```

These cover values, versions, deletion, late join, reports and shared-node takeover; the discovery runner checks non-voting clients. `KINOPIO_PYTHON` and `KINOPIO_CPP` override the sibling Python environment and built C++ worker. Avoid overlapping LAN-election tests on the discovery port. Record exact source versions, dirty state, environment and failures; do not treat an old successful run as current acceptance.

<a id="esp32-hardware"></a>
<a id="chapter-3"></a>
## ESP32 hardware

Flash `KinopioHub.ino/test/firmware/firmware.ino` with a private `KinopioTestConfig.h` defining `KINOPIO_WIFI_SSID` and `KINOPIO_WIFI_PASSWORD`. Keep the header outside tracked source and supply its directory through an include path. From the Arduino repository:

```sh
PLATFORMIO_SRC_DIR=test/firmware \
PLATFORMIO_BUILD_FLAGS='-std=gnu++17 -I/absolute/path/to/private-config' \
pio run -t upload
```

Close other serial monitors. From `KinopioHub`, set `KINOPIO_SERIAL` to the intended ESP32 port and `KINOPIO_PYTHON` to a Python with pyserial, then run `node integration/javascript-arduino.mjs`. With no `KINOPIO_SERVER`, it starts a LAN node; an explicit server selects a reachable broker. TLS requires `KINOPIO_CA_FILE`; optional authentication uses `KINOPIO_TOKEN` or `KINOPIO_USER` / `KINOPIO_PASSWORD`. `KINOPIO_GROUP` selects the discovery domain.

Additional runners under `integration/` are `arduino-offline.mjs`, `arduino-recovery.mjs`, `arduino-flush.mjs`, `arduino-repair.mjs`, `arduino-stalls.mjs` and `arduino-tls-negative.mjs`. LAN fixtures need `KINOPIO_TEST_HOST`, a host IPv4 reachable by the board; stalls also need the CA file. TLS-negative checks use OpenSSL. Run separately: these tests can reconfigure or reboot the board. Measure flash, static RAM, free/minimum heap and workload together.

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

Omit `humble` for all configured distributions; repeat with `linux/amd64` for that architecture. Cross-architecture execution needs Docker emulation. Each run isolates real ROS, bridge and controller processes and uses TLS NATS, including a broker restart. Certificates are temporary fixtures; `KINOPIO_TLS_DIR` overrides their directory.

For a trusted remote server, provide `KINOPIO_SERVER`, `KINOPIO_CA_FILE` and optional `KINOPIO_TEST_TOKEN`, then use `node docker/check.mjs test humble --remote`. Remote mode skips local certificate-negative and broker-restart cases. A declared matrix is not proof of passing tests; distinguish native hardware from emulation.

<a id="chapter-5"></a>
## GitHub Wiki

All public guide bodies live in `KinopioHub/docs/`. Each project keeps only `README.md` and `README_CN.md` as reader documentation; licenses, third-party notices, agent instructions and GitHub templates retain their own roles. Examples and test code stay with their projects.

Edit the English `.md` and Chinese `.zh.md` pages together. The two home sources are `wiki-home.en.md` and `wiki-home.md`; `wiki-sidebar.md` supplies navigation. Run from `KinopioHub`:

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

The generator updates marked pages and removes explicitly retired generated pages; it refuses unmarked collisions. Review new files with `git status` too. Publish only after review and authorization:

```sh
git -C .wiki/checkout add -A -- '*.md'
git -C .wiki/checkout commit -m "Update Wiki"
git -C .wiki/checkout push
```

Commit portal sources separately. Publishing a Wiki does not publish SDK code or packages. Keep real test endpoints, credentials and experiment logs in the private development workspace.
