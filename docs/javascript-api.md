# JavaScript API reference

[简体中文](javascript-api.zh.md) · [Getting started](javascript.md) · [Home](wiki-home.en.md)

Use Node.js 24+ or a modern browser with a bundler. The package provides default and named `KinopioHub` exports, `KinopioError`, and TypeScript declarations. This reference covers the supported public API, not internal protocol helpers.

In this chapter

- [1. Create and close a Hub](#chapter-1)
- [2. Constructor options](#chapter-2)
- [3. Variable](#chapter-3)
- [4. Watches and cleanup](#chapter-4)
- [5. SDK status and observed instances](#chapter-5)
- [6. Errors and transport boundaries](#chapter-6)
- [7. Browser use and current limits](#chapter-7)

<a id="chapter-1"></a>
## 1. Create and close a Hub

```js
import KinopioHub, { KinopioError } from 'kinopio-hub';

const hub = new KinopioHub('workshop');
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

Durations use **milliseconds**. Positive integer constraints apply to general timers and capacities. The signature is `new KinopioHub(namespace?, options?)`. The first argument selects the namespace; omission generates a UUID exposed as read-only `hub.namespace`. Use `new KinopioHub(undefined, options)` for advanced options with a generated namespace. Options do not accept namespace or name.

| Option | Default | Purpose |
| --- | --- | --- |
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
## 3. Variable

`hub.var(name)` returns the same stable Variable for repeated lookups. TypeScript can use `hub.var<number>('battery')`; this describes the intended type but does not validate incoming JSON against an application schema.

| Member | Return | Behavior |
| --- | --- | --- |
| `name` | String | Reference names |
| `value` | JSON or `undefined` | Local value copy |
| `meta` | `VariableMeta` | Current initialization, existence, version and publication state |
| `set(value)` | `Promise<void>` | Validate and update RAM |
| `delete()` | `Promise<void>` | Write a versioned deletion |
| `watch(callback)` | Stop function | Observe `(value, meta)` snapshots |
| `ready({timeout})` | `Promise<this>` | Wait for local initialization of this variable |

`meta` has `initialized`, `exists`, `version`, `pending` and `connected`. `exists` is `null` when unknown, `false` when absent and `true` when present. `version`, when available, contains string `counter` and `writer`. `pending` tracks publication, not device completion.

Names are 1–128 UTF-8 bytes without control characters. Protocol 4 encodes both the namespace and variable name as UTF-8 hexadecimal tokens; a state record uses `<namespace-token>.<variable-token>`, while SDK control subjects use `_sys.v4.<namespace-token>`. These subjects are internal protocol details, not a substitute for `hub.var(name)`.

```js
const battery = hub.var('battery');
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
const battery = hub.var('battery');
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
    console.log(instance.instanceId, instance.online, instance.health);
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

JavaScript does not provide a live-channel API. Use [Python live](python-api.md#live) for a compatible live controller. Variables are RAM-only and do not provide persistence or history.

Exact exported types: [types/index.d.ts](https://github.com/skyboooox/KinopioHub.JS/blob/main/types/index.d.ts). Runnable examples and installation are in [Getting started](javascript.md).

## 8. Events, requests and drain

All message operations belong to `hub.var(name)`. Pure message references count toward `maxVariables` but create no state record; `delete()` only deletes state, not subscriptions.

`get()` reads the same local copy as `value`. `get(fallback)` returns the fallback only when absent, preserving null, false, zero and empty values. `watchValue(callback)` passes only the value and returns the existing stop function; metadata changes can still trigger it.

| Reference method | Result |
| --- | --- |
| `publish(data, {headers})`, `pub` | Promise accepting one JSON event into bounded transport |
| `subscribe(handler, options)`, `sub` | Promise of a ready subscription; handler receives `(data, context)` |
| `handle(handler, options)` | Ready subscription; the awaited return value replies automatically, undefined becomes null |
| `request(data = null, options)`, `req` | First reply data; `{details: true}` returns `{data, headers}` |
| `requestMany(data = null, options)` | Reply data array; `{details: true}` returns `{replies, reason}` |

Message names use dot-separated segments, with 1–128 UTF-8 bytes overall and no empty segments or control characters. Subscriptions allow whole-segment `*` and a final `>` (one or more segments); publishers and requests reject wildcards with `INVALID_TOPIC`.

> **Note:** A state name such as `sensor.*` remains literal for set/watch; only messaging interprets it as a pattern. Messages use `_msg.v1.<hex(namespace)>.<hex(segment)>...`; state protocol 4 remains unchanged.

Subscribe/handle options are `queue`, `pendingMessages`, `pendingBytes` and setup `timeout` (default 3000 ms). Queue names are complete UTF-8 names without wildcards and are encoded within the namespace. Equivalent responders in the same queue share work. Normal subscribers, overlapping patterns and other queue groups may each receive a request. Subscribe returns only after SUB and protocol synchronization. Reconnected subscriptions are restored; events missed during disconnection are lost.

### Context and Headers

`context.topic` is the actual decoded business topic. `context.headers` is an iterable `MessageHeaders`; inputs accept strings/string-array objects, `MessageHeaders`, or iterable name/value pairs.

| Rule | Behavior |
| --- | --- |
| Lookup | Case-insensitive `get(name)` returns the first value; `getAll(name)` returns wire-order values |
| Outbound | ASCII-token names, visible-ASCII values, lowercase names and trimmed edge ASCII spaces |
| Duplicate values | Preserved per key; received iteration uses received names and has no cross-key ordering guarantee |

Use JSON for Unicode data.

A subscribe callback can `await context.reply(data, {headers})` multiple times while its callback remains active. Missing reply subjects produce `NO_REPLY_SUBJECT`. The callback's return value is ignored. Handle contexts instead expose mutable `context.replyHeaders`; they have no manual reply. Handle ignores ordinary events without reply subjects. Exceptions and invalid return values become local `HANDLER_ERROR`, with no synthetic response or exception disclosure.

Request options are `timeout` (3000 ms), `headers`, `details` and `signal: AbortSignal`. Pass `null` explicitly when providing only options. `requestMany` additionally accepts `maxReplies` (16) and `maxBytes` (1 MiB; `maxReplyBytes` also accepted); limits cannot exceed Hub collection limits.

Its total window ends with `deadline` or `maxReplies`; a deadline can successfully return an empty array. Native 503 is `NO_RESPONDERS`, while a matching subscriber that does not reply can cause `TIMEOUT`. Cancellation is `CANCELLED`; invalid first responses fail immediately.

> **Note:** Collection errors carry bounded `partialReplies` as detailed replies, even in simple mode. Timeouts and cancellation never undo remote side effects, and requests are never resent automatically.

`hub.drain({timeout: 5000})` rejects new messages, subscriptions and state writes with `DRAINING`, waits admitted handlers/replies and pending requests, confirms transmission, then closes. Subscription drain affects only that subscription. A shared total deadline forces cleanup with `DRAIN_TIMEOUT`; `close()` remains immediate and can interrupt drain.

> **Note:** Drain from a managed Node handler is `DRAIN_IN_HANDLER`. Browser detection is conservative: any running handler causes drain rejection, including calls from an external owner. Stop producing work and wait for handlers first.

JavaScript cannot forcibly stop user callbacks or external actions. Expired/old-generation reply contexts cannot send on a replacement connection. Planned handoff withdraws old subscriptions and waits up to five seconds for admitted callbacks before activating new subscriptions; requests fail and events may be lost across the gap.

### Status and overload

`hub.status().messaging` and `subscription.status()` expose queued counts/bytes, running handlers, drops, high-water marks and effective limits. Hub budgets include callbacks and collected replies.

Native/network drop counts are unknown (`null`), not zero. Callback subscriptions use the native callback path rather than a second unbounded native iterator queue. When full, subscriptions discard new arrivals and report `SLOW_CONSUMER`; cumulative counts remain after the current warning clears. Requests fail on overflow with `BUFFER_OVERFLOW`.

Set Hub `messaging` limits using these positive integer options:

| Option | Default |
| --- | --- |
| `maxSubscriptions`, `maxRequests` | 128, 64 |
| `pendingMessages`, `pendingBytes` | 256, 1 MiB per subscription, including its active handler |
| `maxPendingMessages`, `maxPendingBytes` | 4096, 8 MiB per Hub |
| `maxPayloadBytes` | 64 KiB |
| `maxHeaderBytes`, `maxHeaderEntries` | 4 KiB, 32 name/value entries |
| `maxReplies`, `maxReplyBytes` | 16, 1 MiB per collector |
| `maxOutboundBytes` | 8 MiB native pending write budget |

Byte budgets include raw payload, Headers and subjects, and do not represent total JavaScript heap usage. JSON retains existing depth/node validation; payload plus Headers must also fit broker max_payload. Publish/reply do not force per-message PING/PONG; explicit `hub.flush()` covers prior messages and retains its state transport meaning. No connection produces `DISCONNECTED` immediately, with no offline event buffering.

If owned-node cleanup outlasts the drain deadline, `DRAIN_TIMEOUT` returns after stopping transport and new operations while cleanup continues. `await hub.close()` joins that cleanup.

[Shared messaging semantics](messaging.md)
