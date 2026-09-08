# JavaScript API reference

[简体中文](javascript-api.zh.md) · [Getting started](javascript.md) · [Home](wiki-home.en.md)

Version 3.0.0, currently unpublished. Use Node.js 24+ or a modern browser with a bundler. The package provides default and named `KinopioHub` exports, `KinopioError`, and TypeScript declarations. This reference covers the supported public API, not internal protocol helpers.

In this chapter

- [1. Create and close a Hub](#chapter-1)
- [2. Constructor options](#chapter-2)
- [3. Scope and Variable](#chapter-3)
- [4. Watches and cleanup](#chapter-4)
- [5. SDK status and observed instances](#chapter-5)
- [6. Errors and transport boundaries](#chapter-6)
- [7. Browser use and current limits](#chapter-7)

<a id="chapter-1"></a>
## 1. Create and close a Hub

```js
import KinopioHub, { KinopioError } from 'kinopio-hub';

const hub = new KinopioHub({ namespace: 'workshop', name: 'monitor' });
try {
  await hub.connected();
  console.log(hub.status());
} finally {
  await hub.close();
}
```

Construction starts local initialization and connection management. `ready()` returns `Promise<this>` for local initialization; `connected({ timeout })` returns `Promise<this>` for an active connection. `flush({ timeout })` and `close()` return `Promise<void>`. Read-only `instanceId` identifies this lifetime and `state` exposes local connection state.

Retain a Hub for the lifetime of the application. A short-lived example closes after sending; it will not retain an online copy after exit. `close()` is cleanup, not implicit persistence or a guarantee that pending values reached another SDK. Call `flush()` first when transport confirmation is required.

<a id="chapter-2"></a>
## 2. Constructor options

Durations use **milliseconds**. Positive integer constraints apply to general timers and capacities. Most applications only need namespace and their chosen connection mode.

| Option | Default | Purpose |
| --- | --- | --- |
| `namespace` | `"default"` | Shared data namespace |
| `name` | Runtime-generated display name | Human-readable SDK name; not persistent identity |
| `servers` | Selected by runtime/mode | Client URL string or array |
| `mesh` | Enabled in Node | `false` for client-only; object for group, binary and leaf settings |
| `discovery` | Enabled | Endpoint hints; `{url}` can select an HTTP discovery manifest |
| `token` | Unset | Token authentication |
| `user`, `pass` | Unset | User/password authentication |
| `authenticator` | Unset | NATS authenticator callback; Node client-only mode |
| `tls` | Unset | Node TCP TLS options; client-only mode |
| `timeout` | `3000` | General wait timeout; an explicit value also overrides connection waits |
| `peerTimeout` | 80% of `timeout`, at least 1 | Initial peer discovery wait |
| `healthInterval` | `5000` | SDK report interval |
| `probeInterval` | `15000` | Connection quality probe interval |
| `maxVariables` | `10000` | Record/reference capacity |
| `maxMemoryBytes` | `16777216` | Record-data budget |
| `maxInstances` | `1024` | Observed SDK report capacity |
| `selection` | SDK policy | `improvementMs`, `improvementRatio`, `cooldownMs` tune endpoint handoff |
| `onCallbackError` | Unset | Handler for application callback failures |

Omitting `timeout` lets automatic Node connection/flush waits use 60 seconds. A per-call timeout overrides the applicable default. `selection` tunes client endpoint switching; it is not a public API for replacing mesh voting logic.

`mesh` accepts `group`, `binary`, `upstreams` and `upstreamTls`. The latter accepts `caFile`, `certFile`, `keyFile`, `handshakeFirst`. See [Networking](networking.md) for domain matching and leaf prerequisites. Setting only `discovery: false` does not turn off mesh election.

<a id="chapter-3"></a>
## 3. Scope and Variable

`hub.scope(name)` returns a stable Scope with a read-only `name`. `scope.var(name)` returns a stable Variable within this Hub. TypeScript applications can use `scope.var<number>('battery')`; the generic describes the intended type but does not make untrusted incoming JSON conform to an application schema.

| Member | Return | Behavior |
| --- | --- | --- |
| `name`, `scopeName` | String | Reference names |
| `value` | JSON or `undefined` | Local value copy |
| `meta` | `VariableMeta` | Current initialization, existence, version and publication state |
| `set(value)` | `Promise<void>` | Validate and update RAM |
| `delete()` | `Promise<void>` | Write a versioned deletion |
| `watch(callback)` | Stop function | Observe `(value, meta)` snapshots |
| `ready({timeout})` | `Promise<this>` | Wait for local initialization of this variable |

`meta` has `initialized`, `exists`, `version`, `pending` and `connected`. `exists` is `null` when unknown, `false` when absent and `true` when present. `version`, when available, contains string `counter` and `writer`. `pending` tracks publication, not device completion.

```js
const battery = hub.scope('devices').var('battery');
await battery.ready();
if (battery.meta.exists === true) console.log(battery.value);
await battery.set(null);
console.log(battery.meta.exists); // true
await battery.delete();
```

JSON validation rejects nonfinite numbers, unsafe integer-valued numbers, cycles, sparse arrays, getters and non-plain objects. Convert class instances into plain data explicitly. Read [Variables](variables.md) before choosing defaults or implementing concurrent updates.

<a id="chapter-4"></a>
## 4. Watches and cleanup

```js
const battery = hub.scope('devices').var('battery');
const stop = battery.watch((value, meta) => {
  console.log(value, meta.pending);
});
await battery.set(80);
stop();
```

If already initialized, a variable watch provides its initial snapshot when registered; otherwise it waits for initialization. Later notifications can reflect metadata changes as well as value versions. Keep callbacks brief. Handle failures with `onCallbackError`; do not assume a thrown callback aborts a completed write. Stop watchers when their UI or application consumer is disposed.

<a id="chapter-5"></a>
## 5. SDK status and observed instances

`hub.status()` is a synchronous local snapshot. `hub.watch(callback)` observes local SDK status and returns a stop function. `await hub.instances.list()` returns observed reports; `hub.instances.watch(callback)` observes the current report list and returns a stop function.

```js
const stop = hub.instances.watch(instances => {
  for (const instance of instances) {
    console.log(instance.name, instance.online, instance.health);
  }
});
// Call stop() during cleanup.
```

Interpret connection, freshness and error fields using [SDK status](networking.md#6-read-sdk-status). Instance reports do not contain business values or permanent device registration.

<a id="chapter-6"></a>
## 6. Errors and transport boundaries

Catch `KinopioError` and inspect `code`; other runtime or transport errors may also occur. Common SDK codes include `INVALID_OPTIONS`, `INVALID_NAME`, `INVALID_VALUE`, `MEMORY_FULL`, `MESSAGE_TOO_LARGE`, `TIMEOUT`, `DISCONNECTED` and `CLOSED`. Inspect `status().currentError` for background failures and `lastError` for the latest recorded failure.

An error from `flush()` does not undo a successful local `set()`. A retry of `set()` makes a new version. See [Troubleshooting](troubleshooting.md) for diagnosing timeouts and oversized values.

<a id="chapter-7"></a>
## 7. Browser use and current limits

Use the package import through a bundler so browser conditional exports select the WebSocket transport. Supply WS/WSS client endpoints; browsers never start a broker. Node-specific TLS files and process settings do not apply to browser transport. A discovery manifest must actually exist at the configured URL; NATS Core does not serve one by default.

v3 does not expose the old request/reply, node CLI, separate leaf export, persistence or `synced()` API. JavaScript has no live-channel API yet. Use [Python live](python-api.md#live) for a compatible live controller, rather than inventing an equivalent JS method.

Exact exported types: [types/index.d.ts](https://github.com/skyboooox/KinopioHub.JS/blob/main/types/index.d.ts). Runnable examples and installation are in [Getting started](javascript.md).
