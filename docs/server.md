# Server

[简体中文](server.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/Kinopio-server)

**Kinopio-server is optional.** The SDKs work with ordinary NATS Core and keep variables in SDK RAM.

This fork of [nats-io/nats-server](https://github.com/nats-io/nats-server) adds a stricter subscription policy. It is not a variable store, state service or history service.

In this chapter

- [Fork-specific subscription rule](#chapter-1)
- [Build and run](#chapter-2)
- [Client and leaf listeners](#chapter-3)
- [Maintaining the fork](#chapter-4)

<a id="chapter-1"></a>
## Fork-specific subscription rule

Enable the rule in a NATS configuration:

```conf
port: 4222
authorization {
  reject_first_wildcard: true
}
```

| Subscription | With the option enabled |
| --- | --- |
| `>` / `*` / `*.battery` | Rejected |
| `devices.>` / `devices.*` / `devices.battery` | Allowed by this rule; normal permissions still apply |

| Option behavior | Rule |
| --- | --- |
| Default | `false` |
| Scope | Client subscriptions |
| Apply a change | Restart the server |
| Permissions | Normal NATS authentication and subject permissions still apply |

It does not change wildcard syntax. Prefix-based SDK subjects do not require this fork.

The SDK's message patterns keep the literal `_msg.v1` prefix, and replies use `_INBOX`. They remain compatible with this rule, including `hub.var('sensor.*').sub(...)`. Configure the corresponding publish, subscribe and reply permissions separately; queue groups do not bypass them.

<a id="chapter-2"></a>
## Build and run

In `Kinopio-server`, use the Go toolchain declared in `go.mod`:

```sh
go build -o nats-server .
./nats-server -t -c nats.conf
./nats-server -c nats.conf
```

Create and review `nats.conf` before starting a reachable server. This fork is distinct from the stable executable pinned by SDK automatic nodes.

<a id="chapter-3"></a>
## Client and leaf listeners

For a local-only topology experiment, configure separate listeners:

```conf
host: 127.0.0.1
port: 4222
leafnodes { host: 127.0.0.1; port: 7422 }
websocket { host: 127.0.0.1; port: 9222; no_tls: true }
```

| Connection | Local endpoint |
| --- | --- |
| Browser client | `ws://127.0.0.1:9222` |
| Native client | `nats://127.0.0.1:4222` |
| Managed leaf | `mesh.upstreams: ['nats://127.0.0.1:7422']` |

> **Local-only example:** These listeners are reachable only on this machine. A client URL does not prove that its port accepts leaf connections.

ESP32 and ROS use TCP/TLS, never WS/WSS. Remote deployments need explicit bind addresses, authentication and trusted TLS.

For deployment options, use the [official NATS configuration guide](https://docs.nats.io/running-a-nats-service/configuration) and [leaf-node guide](https://docs.nats.io/running-a-nats-service/configuration/leafnodes).

<a id="chapter-4"></a>
## Maintaining the fork

`origin` is the Kinopio fork and `upstream` is NATS. Fetch and review upstream changes before merging. Preserve the wildcard option and tests, publishing destinations and manual workflow triggers. Review the fork's release Dockerfile when upstream changes packaging.

| Release field | Format |
| --- | --- |
| Binary version | `<merged-upstream-version>+kinopio.<revision>` |
| Git tag | `v` followed by the binary version |
| Docker tag | Git tag with `+` replaced by `-` |

Retain upstream prerelease markers such as `dev` or `RC`. The Kinopio suffix identifies the fork build; it does not change [SemVer precedence](https://semver.org/#spec-item-10). SDK versions and their pinned NATS executables are maintained separately.

Focused check:

```sh
go test ./server -run 'Test.*FirstWildcard|TestQueueSubscribePermissions|TestClientSubscribeDenyWildcardOverlapBlocksDelivery' -count=1
```

Broader checks use `go vet ./...`, `go test ./...` and the upstream CI test groups. Some tests write temporary files or require syslog; use a disposable writable checkout for those runs. The fork retains the upstream Apache-2.0 license and third-party notices; see `LICENSE` and `DEPENDENCIES.md`.
