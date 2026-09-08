# Server

[简体中文](server.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/Kinopio-server)

The v3 SDKs work with ordinary NATS Core. `Kinopio-server` is an optional fork of [nats-io/nats-server](https://github.com/nats-io/nats-server) for a stricter subscription policy. It is not a variable store or a required state service.

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

The option defaults to false and applies to client subscriptions. It does not change NATS wildcard syntax or replace authentication and subject permissions. Existing prefix-based v3 subjects do not require this fork. Runtime policy changes should be applied through a controlled server restart; hot reload of this custom option is not documented as supported.

<a id="chapter-2"></a>
## Build and run

In `Kinopio-server`, use the Go toolchain declared in `go.mod`:

```sh
go build -o nats-server .
./nats-server -t -c nats.conf
./nats-server -c nats.conf
```

Create `nats.conf` from the example first. The current source follows upstream `main` and uses the Kinopio project version `3.0.0` (not an upstream NATS release number); its current upstream base is `2.15.0-dev`. It is distinct from the stable server executable pinned by SDK automatic nodes.

<a id="chapter-3"></a>
## Client and leaf listeners

For a local-only topology experiment, ordinary NATS can expose separate listeners:

```conf
host: 127.0.0.1
port: 4222
leafnodes { host: 127.0.0.1; port: 7422 }
websocket { host: 127.0.0.1; port: 9222; no_tls: true }
```

Clients use `nats://127.0.0.1:4222` or `ws://127.0.0.1:9222`; an SDK-managed leaf can use `mesh.upstreams: ['nats://127.0.0.1:7422']`. These loopback listeners are reachable only on the same machine. Remote deployment needs suitable bind addresses, authentication and trusted TLS. WebSocket leaf connections additionally require leaf support on that endpoint.

For deployment options, use the [official NATS configuration guide](https://docs.nats.io/running-a-nats-service/configuration) and [leaf-node guide](https://docs.nats.io/running-a-nats-service/configuration/leafnodes). Do not infer that a client port also supports leaf connections.

<a id="chapter-4"></a>
## Maintaining the fork

`origin` is the Kinopio fork; `upstream` is NATS. Fetch and review upstream changes before merging. Preserve the wildcard option/tests, Kinopio project version, publishing destinations and manual workflow triggers. Keep the release Dockerfile's configuration file when upstream changes its own packaging.

Focused check:

```sh
go test ./server -run 'Test.*FirstWildcard|TestQueueSubscribePermissions|TestClientSubscribeDenyWildcardOverlapBlocksDelivery' -count=1
```

Broader checks use `go vet ./...`, `go test ./...` and the upstream CI test groups. Some tests write temporary files into their working directory or require syslog. Use a disposable writable checkout for those runs. Release packaging uses `.goreleaser.yml` and `docker/Dockerfile.release`.

Contributions should explain the change, include relevant validation and use signed-off commits (`git commit -s`). The fork keeps the upstream Apache-2.0 license and third-party notices; see its `LICENSE` and `DEPENDENCIES.md`. Upstream design material remains in [nats-architecture-and-design](https://github.com/nats-io/nats-architecture-and-design).

Windows certificate-store test maintenance is documented in the [upstream PKCS12 fixture notes](https://github.com/nats-io/nats-server/blob/622457b6dfd5649fdc882cacb287528424762948/test/configs/certs/tlsauth/certstore/pkcs12.md). General MQTT behavior remains covered by the [official NATS MQTT guide](https://docs.nats.io/running-a-nats-service/configuration/mqtt).
