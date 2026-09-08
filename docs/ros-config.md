# ROS YAML and control reference

[简体中文](ros-config.zh.md) · [Getting started](ros.md) · [Home](wiki-home.en.md)

Version 3.0.0, currently unpublished. One YAML file selects outbound topics, reverse publishers and connection settings. The bridge uses the matching Python SDK. Its configured Docker matrix covers Humble, Jazzy, Kilted, Lyrical and Rolling; see [Development](development.md#ros-docker) for execution and verification boundaries.

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
| `robot` | `robot01` | SDK scope for this bridge's variables |
| `hub` | Python SDK defaults | Connection options |
| `topics` | Empty list | Outbound ROS-to-variable allowlist, at most 256 routes |
| `controls` | Empty list | Variable/live-to-ROS allowlist, at most 256 routes including at most 32 live routes |
| `health_variable` | `_bridge` | Bridge report variable in the robot scope |

Unknown configuration keys are rejected. Topics must be absolute ROS names, without substitutions or wildcards. Cloud names follow the SDK's UTF-8 length/control-character rules. All route topics and cloud variable names must be unique, including across directions; variables cannot collide with the bridge-health variable.

<a id="chapter-2"></a>
## 2. NATS connection fields

`hub` accepts `namespace`, `name`, `servers`, `tls`, `token`, `user`, `password`, `mesh`, `discovery`. `mesh` and `discovery` are booleans here, not the full Python mesh dictionaries.

```yaml
robot: robot01
hub:
  namespace: robots
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
| `variable` | Topic name, including leading slash | Cloud variable within `robot` scope |
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

The example writes a number into `hub.scope("robot01").var("temperature")`. Without `field`, it writes the complete message object. Renaming `variable` does not rename the ROS topic. Rate limiting retains the latest pending sample rather than every intermediate message.

YAML only configures routing. Data comes from ROS messages and becomes JSON: `std_msgs/msg/String` maps to `{"data":"hello"}`, not the string `"hello"` unless `field: data` selects it. Nested messages and arrays follow their message structure. Binary/image streams can exceed the 64 KiB payload boundary; this bridge is not a bulk media transport.

<a id="controls"></a>
<a id="chapter-4"></a>
## 4. Reverse control fields

| Field | Required / default | Meaning |
| --- | --- | --- |
| `topic` | Required | ROS topic to publish |
| `type` | Required | Complete ROS message type |
| `variable` | `control` plus topic | Cloud state name, or part of the live channel name |
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

By default, send the cloud value as `{"session":"...","value":{"data":"manual"}}` to `control/target_mode` in the robot scope. Obtain the session from the bridge report's `control_session`. The [getting-started example](ros.md#controls) shows the Python call.

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

Send with the connected Python SDK: `await hub.live("robot01/control/command").send({"data": "step"})`. Use the bridge's namespace. The sender timeout is a transport wait; the route's `timeout_ms` is the receiver lease lifetime. They are different settings.

Live commands reject stale sessions, expired leases, duplicates and reordering. They are not replayed after reconnection. The bridge keeps at most 32 queued live commands and drops older work under overload; this is not a reliable work queue. Deploy one receiver per channel. Configure volatile durability to prevent DDS replay.

For motion that must stop when commands disappear, implement the stop/watchdog in the local robot controller. Neither a transport timeout nor an expired bridge command automatically publishes a stop message.

<a id="chapter-7"></a>
## 7. QoS and observability

`qos.depth` accepts 1–10,000. Default depth is 1 for outbound subscriptions and 10 for controls. Reliability accepts `best_effort` or `reliable`; controls default to reliable, while outbound selection adapts to observed publishers and accommodates best-effort sensors. Durability accepts `volatile` or `transient_local`, with volatile as the default.

When explicitly selecting QoS, verify compatibility with the actual publisher/subscriber. Discovery and configuration validity do not prove DDS delivery. Late publishers and message type discovery are handled while the bridge runs, but missing packages must still be installed locally.

The `_bridge` variable reports route counts/counters, errors and `control_session`. SDK instance health separately reports the underlying SDK connection. Neither confirms actuator execution; publish application feedback on an outbound topic. ROS 1, Service/Action forwarding, config hot reload and WSS are not part of this bridge.
