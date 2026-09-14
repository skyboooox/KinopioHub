# ROS YAML and control reference

[简体中文](ros-config.zh.md) · [Getting started](ros.md) · [Home](wiki-home.en.md)

One YAML file selects outbound topics, reverse publishers and connection settings. The bridge uses the matching Python SDK. Its container configuration covers Humble, Jazzy, Kilted, Lyrical and Rolling on `linux/arm64` and `linux/amd64`; [Development](development.md#ros-docker) documents the available verification commands and their native or emulated execution modes.

In this chapter

- [1. Configuration lifecycle](#chapter-1)
- [2. NATS connection fields](#chapter-2)
- [3. Outbound topic fields](#chapter-3)
- [4. Reverse control fields](#chapter-4)
- [5. State sessions and subscriber readiness](#chapter-5)
- [6. Live command lifetime](#chapter-6)
- [7. QoS and observability](#chapter-7)

<a id="chapter-1"></a>
## 1. Configuration lifecycle

```sh
kinopio-hub-ros --config config.yaml --check-config
kinopio-hub-ros --config config.yaml
```

The first command parses and validates the configuration. It does not prove TLS connectivity, available message packages, DDS matching or robot behavior. Source ROS and custom message workspaces before starting. Configuration is loaded once; restart the bridge after edits.

| Top-level key | Default | Meaning |
| --- | --- | --- |
| `hub` | Python SDK defaults | Connection options |
| `topics` | Empty list | Outbound ROS-to-variable allowlist, at most 256 routes |
| `controls` | Empty list | Variable/live-to-ROS allowlist, at most 256 routes including at most 32 live routes |
| `health_variable` | `_bridge` | Bridge report variable in the Hub namespace |

> **Note:** Unknown configuration keys are rejected. Configure namespace only in `hub.namespace`; omission generates a UUID. Use separate namespaces for robots or choose unique variable names. The old robot/name fields are rejected. Topics must be absolute ROS names, without substitutions or wildcards. Cloud names follow the SDK's UTF-8 length/control-character rules. All route topics and cloud variable names must be unique, including across directions; variables cannot collide with the bridge-health variable.

<a id="chapter-2"></a>
## 2. NATS connection fields

`hub` accepts `namespace`, `servers`, `tls`, `token`, `user`, `password`, `mesh`, `discovery`. `mesh` and `discovery` are booleans here, not the full Python mesh dictionaries.

```yaml
hub:
  namespace: robot01
  servers: [tls://nats.example.com:4222]
  tls:
    ca_file: ./certs/ca.pem
    handshake_first: true
topics:
  - /battery
```

`servers` contains 1–32 TCP/TLS client URLs when specified. It rejects WS/WSS and embedded URL credentials. Explicit servers default `mesh` and `discovery` to false; omitting `hub` inherits automatic Python LAN mode. `nats://` is available for trusted local use.

TLS requires `ca_file`. `cert_file` and `key_file` must be supplied together for mutual TLS. Paths resolve relative to the YAML directory. `handshake_first` defaults to true; set false only for an INFO-then-TLS listener. Certificate verification cannot be disabled in the bridge config.

<a id="chapter-3"></a>
## 3. Outbound topic fields

A string entry such as `- /battery` selects a topic with automatic type discovery. Use a mapping to control its cloud name, rate and field selection.

| Field | Required / default | Meaning |
| --- | --- | --- |
| `topic` | Required | Absolute ROS topic |
| `type` | Optional | `package/msg/Message`; otherwise discover from the ROS graph |
| `variable` | Topic name, including leading slash | Cloud variable within the Hub namespace |
| `field` | Whole message | One field or dotted nested field path |
| `max_hz` | No additional rate cap | Finite rate in `(0, 1000]` |
| `qos` | Runtime-compatible defaults | Depth, reliability and durability |

```yaml
topics:
  - topic: /temperature
    type: sensor_msgs/msg/Temperature
    variable: temperature
    field: temperature
    max_hz: 2
```

The example writes a number into `hub.var("temperature")`. Without `field`, it writes the complete message object. Renaming `variable` does not rename the ROS topic. Rate limiting retains the latest pending sample rather than every intermediate message.

YAML only configures routing. Data comes from ROS messages and becomes JSON: `std_msgs/msg/String` maps to `{"data":"hello"}`, not the string `"hello"` unless `field: data` selects it. Nested messages and arrays follow their message structure. Binary/image streams can exceed the 64 KiB payload boundary; this bridge is not a bulk media transport.

<a id="controls"></a>
<a id="chapter-4"></a>
## 4. Reverse control fields

| Field | Required / default | Meaning |
| --- | --- | --- |
| `topic` | Required | ROS topic to publish |
| `type` | Required | Complete ROS message type |
| `variable` | `control` plus topic | Cloud state name, or complete live channel name |
| `mode` | `state` | `state` or `live` |
| `apply_existing` | `false` | State only: allow restoring existing desired values and bypass the session guard |
| `timeout_ms` | `300` for live | Live only, integer 1–60,000 ms |
| `qos` | Publisher defaults | Live durability must be volatile |

Controls do not accept `field` or `max_hz`. The value must be a complete typed ROS message with no missing/unknown fields, invalid ranges or unsupported numeric values. Custom message packages must be installed and sourced locally.

A configured control creates a ROS publisher, even if that topic did not previously exist. It publishes new messages; it cannot edit an already published message, change another publisher's type or create arbitrary topics from a remote request.

<a id="chapter-5"></a>
## 5. State sessions and subscriber readiness

```yaml
controls:
  - topic: /target_mode
    type: std_msgs/msg/String
    mode: state
```

By default, send the cloud value as `{"session":"...","value":{"data":"manual"}}` to `control/target_mode` in the Hub namespace. Obtain the session from the bridge report's `control_session`. The [getting-started example](ros.md#controls) shows the Python call.

Connection changes rotate the session. Values belonging to old sessions are rejected. Within the current session, the latest desired value can wait for a matching ROS subscriber. State has no 300 ms expiry; `timeout_ms` is invalid for a state route.

`apply_existing: true` deliberately bypasses the session guard and allows restoring existing desired values. Use it only for state that is safe to restore. Do not enable it to hide a stale-session error. This option does not add persistent storage.

<a id="chapter-6"></a>
## 6. Live command lifetime

```yaml
controls:
  - topic: /command
    type: std_msgs/msg/String
    mode: live
    timeout_ms: 300
```

Send with the connected Python SDK: `await hub.live("control/command").send({"data": "step"})`. Use the bridge's namespace. The sender timeout is a transport wait; the route's `timeout_ms` is the receiver lease lifetime. They are different settings.

> **Note:** Live commands reject stale sessions, expired leases, duplicates and reordering. They are not replayed after reconnection. The bridge keeps at most 32 queued live commands and drops older work under overload; this is not a reliable work queue. Deploy one receiver per channel. Configure volatile durability to prevent DDS replay.

For motion that must stop when commands disappear, implement the stop/watchdog in the local robot controller. Neither a transport timeout nor an expired bridge command automatically publishes a stop message.

<a id="chapter-7"></a>
## 7. QoS and observability

`qos.depth` accepts 1–10,000. Default depth is 1 for outbound subscriptions and 10 for controls. Reliability accepts `best_effort` or `reliable`; controls default to reliable, while outbound selection adapts to observed publishers and accommodates best-effort sensors. Durability accepts `volatile` or `transient_local`, with volatile as the default.

When explicitly selecting QoS, verify compatibility with the actual publisher/subscriber. Discovery and configuration validity do not prove DDS delivery. Late publishers and message type discovery are handled while the bridge runs, but missing packages must still be installed locally.

The `_bridge` variable reports route counts/counters, errors and `control_session`. SDK instance health separately reports the underlying SDK connection. Neither confirms actuator execution; publish application feedback on an outbound topic. ROS 1, Action forwarding, config hot reload and WSS are not part of this bridge.

## Events and services

`topics` and `controls` keep their current-state/live semantics. Separate `events` and `services` routes use the Python SDK's stable-reference message methods; they never enter the latest-value queue, write cloud variables or replay offline events. See [message semantics](messaging.md).

```yaml
events:
  - ros_topic: /diagnostics_event
    channel: robot.diagnostics
  - ros_topic: /remote_notice
    type: std_msgs/msg/String
    channel: robot.notices.*
    direction: nats_to_ros
services:
  - ros_service: /enable_sensor
    type: std_srvs/srv/SetBool
    channel: robot.sensor.enable
    direction: nats_to_ros
  - ros_service: /remote_enable
    type: std_srvs/srv/SetBool
    channel: backend.enable
    direction: ros_to_nats
```

| Event field | Meaning |
| --- | --- |
| `ros_topic`, `channel` | Required fixed ROS endpoint and message channel |
| `direction` | `ros_to_nats` by default; explicit `nats_to_ros` for inbound events |
| `type` | `package/msg/Message`; outbound omission discovers a unique ROS graph type; inbound requires it |
| `queue` | Optional inbound NATS queue group; no wildcards in the queue name |
| `headers` | Fixed outbound ASCII Header mapping; values are strings or nonempty string lists |
| `pending_messages`, `pending_bytes` | Per-route accepted FIFO budget: defaults 32 / 262,144, maxima 256 / 1,048,576 |
| `qos` | `depth` defaults to 32 (maximum 256); reliability follows the existing graph-aware policy; durability must be `volatile` |

Outbound channels must be concrete. Inbound event channels may contain whole-segment `*` or a terminal `>`, always routed to the explicitly configured ROS message type and topic. Missing or ambiguous discovered types are visible route errors; the bridge retries discovery. A JSON event must contain the complete, correctly typed ROS message fields. Unknown fields and unsafe integers are rejected using the same conversion rules as state controls.

Events preserve repeated equal payloads in FIFO order. Overflow drops the new delivery. Each direction has an additional aggregate 256-message / 1 MiB budget, including work already removed for dispatch but not yet completed.

> **Note:** Channel and Header bytes count toward these bridge budgets; SDK queues and DDS queues have their own limits. Inbound events are published once without waiting for a DDS subscriber and use volatile QoS. Disconnect or planned connection replacement discards queued old-generation events. An already dispatched side effect cannot be recalled.

| Service field | Meaning |
| --- | --- |
| `ros_service`, `type`, `channel`, `direction` | Required absolute service endpoint, `package/srv/Service`, concrete channel and explicit direction |
| `direction: nats_to_ros` | Handle a message request by calling a local native ROS service; return its complete response as JSON |
| `direction: ros_to_nats` | Expose a native ROS service that calls a remote SDK responder and validates its complete typed response |
| `timeout_ms` | Total local operation budget, default 3,000 ms, range 1–60,000 |
| `concurrency` | Outbound ROS-to-NATS default 4, range 1–32; inbound NATS-to-ROS must be 1, matching the serial SDK handler |
| `queue` | Optional NATS-to-ROS queue group for equivalent bridge workers; not automatically added |
| `headers` | Fixed outgoing request Headers for ROS-to-NATS, or outgoing response Headers for NATS-to-ROS |

### Service budget and readiness

Inbound service subscriptions additionally bound accepted SDK work to 32 messages / 256 KiB per route. The bridge permits at most 128 message routes and a configured sum of 64 service concurrency slots.

It also permits 64 active service operations / 1 MiB of request data and metadata. Response parsing and generated ROS objects use additional memory.

A local service must be ready when dispatched. An unavailable service fails locally without inventing a response; incoming requests and outgoing responses receive full field/type validation, including nested types.

The executor never blocks waiting on asyncio. Native ROS `call_async` completion callbacks settle asyncio futures, and outgoing async ROS service callbacks await native `rclpy` futures completed by the SDK worker. A narrow adapter around public `Service.send_response` consumes local failure markers and delegates valid responses to the native method.

### Service failures

> **Note:** Invalid payloads, no responders, timeouts or disconnects produce local errors and **no ROS response**. An arbitrary typed ROS service has no generic error result, so ROS clients must set their own bounded response timeout.

Failed backend calls do not terminate the executor or return the service's default response. Later requests can still succeed, and valid application `{success: false, ...}` values remain ordinary typed responses.

Timeout or cancellation does not retract a remote action already started.

### Headers and route isolation

Headers are internal message metadata while an operation is pending. Fixed output names are normalized lowercase, and duplicate values remain ordered within one key.

> **Note:** Headers do not map automatically to ROS fields. Topic/service names and types come only from YAML, never from remote payload fields.

Duplicate ROS topic routes (including state/control/event combinations), duplicate service endpoints and opposite-direction overlapping channels are rejected to prevent feedback loops. Same-direction event fan-in is permitted.

### Startup and reconnect

Startup does not require an available broker. Missing inbound subscriptions retry from the worker loop at most once per second; successful subscriptions use the SDK reconnect path.

Offline startup and shutdown remain responsive. Events received while offline are discarded.

### Shutdown and reports

On shutdown, the bridge stops new work and drains accepted message callbacks, service operations, event queues and SDK state under one five-second budget while continuing to spin ROS.

Expiry forces local cleanup and reports failure. It cannot stop arbitrary application code or a remote device action.

`_bridge.messaging` reports FIFO pending bytes/counts, high-water marks, drops, active services, operation bytes and aggregate counters. `_bridge.errors` contains at most 32 current entries; `errorCount` reports the total. Local counters do not infer DDS, broker or network loss.

The [SDK message peer](https://github.com/skyboooox/KinopioHub.ROS/blob/main/examples/messaging.py) demonstrates events and both service directions. Generic `request_many` remains a Python SDK operation and is not squeezed into one ROS service response; ROS Actions are unsupported.
