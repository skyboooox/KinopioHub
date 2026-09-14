# JavaScript

Manual: [Installation and quick start](javascript.md) · [API and configuration](javascript-api.md) · [Variables](variables.md) · [Networking and status](networking.md) · [Troubleshooting](troubleshooting.md)

[简体中文](javascript.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/KinopioHub.JS)

For Node.js 24+ and modern browsers.

In this chapter

- [Start from source](#chapter-1)
- [Daily API](#chapter-2)
- [Connect to an existing server](#chapter-3)
- [Browsers and examples](#chapter-4)

<a id="chapter-1"></a>
## Start from source

In `KinopioHub.JS`, run `npm install`. Start `node examples/watch.mjs`, then run `node examples/basic.mjs` in a second terminal. Keep the watcher running to retain an online copy.

For another application, install this checkout with `npm install /path/to/KinopioHub.JS` from the application's directory, then:

```js
import KinopioHub from 'kinopio-hub';

const hub = new KinopioHub('workshop');
try {
  const battery = hub.var('battery');
  battery.watch(value => console.log(value));
  await battery.set(80);
  await hub.flush();
} finally {
  await hub.close();
}
```

Node automatically selects or starts a LAN node. First use may download the pinned NATS binary; automatic-mode connection waits allow 60 seconds by default.

> **Note:** Importing the package alone starts nothing.

<a id="chapter-2"></a>
## Daily API

| Operation | Meaning |
| --- | --- |
| `hub.var(name)` | Stable reference within this Hub |
| `variable.value` / `variable.meta` | Current local value and metadata |
| `await variable.set(value)` / `delete()` | Update RAM; works offline |
| `variable.watch((value, meta) => {})` | Initial and later views; returns a stop function |
| `await variable.ready({ timeout })` | Wait for known state, possibly known absence |
| `await hub.connected({ timeout })` | Wait for a NATS connection |
| `await hub.flush({ timeout })` | Send current records and wait for NATS transport |
| `hub.status()` / `hub.watch(callback)` | Local SDK status; watch returns a stop function |
| `await hub.instances.list()` / `hub.instances.watch(callback)` | Observed SDK reports |
| `await hub.close()` | Release resources |

`undefined` means no locally available value; JSON `null` is a value. `meta.exists` is `null` when unknown, `false` when absent and `true` when present.

> **Note:** `pending` means awaiting publication, not device execution. `hub.ready()` only waits for local initialization. Keep callbacks brief; `onCallbackError` can handle callback failures.

Repeated writes of the same JSON still create new versions. There is no persistent state or history. Read [How it works](architecture.md) before using values as controls.

<a id="chapter-3"></a>
## Connect to an existing server

```js
const hub = new KinopioHub('demo', { servers: ['tls://nats.example.com:4222'],
  mesh: false,
  discovery: false,
  tls: { handshakeFirst: true },
});
```

Set `handshakeFirst` only for TLS-first servers. Credentials use `token`, `user`/`pass`, or `authenticator`, rather than URL credentials. Node accepts TCP/TLS/WS/WSS. Custom client TLS and authenticators require client-only mode; WSS uses normal CA trust rather than custom TCP TLS options.

For automatic nodes with remote connectivity, use `mesh: { upstreams: ['nats://nats.example.com:7422'] }` with a real leaf listener. Group is `mesh.group`; leaf TLS is `mesh.upstreamTls` with `handshakeFirst`, `caFile`, `certFile`, `keyFile`. `discovery: false` disables legacy endpoint hints, not mesh election.

Options use camelCase and **milliseconds**.

| Common option | Default |
| --- | --- |
| `timeout`, `healthInterval`, `probeInterval` | `3000`, `5000`, `15000` |
| `maxVariables`, `maxMemoryBytes`, `maxInstances` | `10000`, `16777216`, `1024` |

An omitted `peerTimeout` is 80% of `timeout`. Explicit wait timeouts override automatic-mode defaults. Full options are in the [TypeScript declarations](https://github.com/skyboooox/KinopioHub.JS/blob/main/types/index.d.ts).

<a id="chapter-4"></a>
## Browsers and examples

Use the same import through a bundler; conditional exports select the browser transport. Provide a WS/WSS client endpoint, for example `new KinopioHub('workshop', { servers: ['ws://127.0.0.1:9222'], discovery: false })`. Browsers do not elect or host nodes. An HTTP discovery manifest is optional; ordinary NATS brokers do not publish one.

With a local WebSocket listener from the [Server guide](server.md), run `node examples/browser/serve.mjs` in the JS repository and open its printed URL. HTTPS pages need a trusted WSS endpoint. Reloading clears local variable memory.

Other examples: `examples/offline.mjs` and `examples/sdk-status.mjs`. Examples accept `KINOPIO_EXAMPLE_SERVERS`, `KINOPIO_TOKEN`, `KINOPIO_EXAMPLE_TLS_FIRST=1`, `KINOPIO_MESH=0` and `KINOPIO_LEAF_SERVERS`. See [Development](development.md) for test commands. JavaScript does not provide a live-channel API.

## Events and requests

Stable references also expose independent messaging operations. Publishing an event does not update the current value. Once connected:

```js
const battery = hub.var('battery');
console.log(battery.get(0));
const subscription = await battery.sub(value => console.log(value));
const responder = await battery.handle(() => battery.get(0));
await battery.pub(80);
console.log(await battery.req());
await hub.drain({ timeout: 5000 });
```

`pub/sub/req` forward to `publish/subscribe/request`; an omitted request body sends JSON null. `get(fallback)` uses the fallback only for unknown or deleted values. `watchValue` retains state watch timing and cancellation.

> **Note:** Events are never buffered offline or replayed. Node and browsers support wildcards, queue groups, Headers and bounded `requestMany`. Browsers conservatively reject drain while any handler is running; stop producing work and await handlers before draining.

See the JavaScript API reference for options.
