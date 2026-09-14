# ROS 2

Manual: [Installation and quick start](ros.md) · [API and configuration](ros-config.md) · [Variables](variables.md) · [Networking and status](networking.md) · [Troubleshooting](troubleshooting.md)

[简体中文](ros.zh.md) · [Home](wiki-home.en.md) · [Source](https://github.com/skyboooox/KinopioHub.ROS)

Select ROS topics in one YAML file and share their current messages through the Python SDK. Reverse controls are explicitly configured.

The bridge requires Python 3.10+ and ROS 2. Its container configuration covers Humble, Jazzy, Kilted, Lyrical and Rolling on `linux/arm64` and `linux/amd64`; the standalone Dockerfile defaults to Humble.

> **Note:** Omitting a distribution in `docker/check.mjs build` or `test` selects the whole set. ROS distributions follow the [official lifecycle](https://docs.ros.org/en/kilted/The-ROS2-Project/Release-Schedule.html); deploy only a distribution supported on the intended platform.

In this chapter

- [Install and run](#chapter-1)
- [Select outbound topics](#chapter-2)
- [Connect to TLS NATS](#chapter-3)
- [Controls](#chapter-4)

<a id="chapter-1"></a>
## Install and run

Keep `KinopioHub.py` and `KinopioHub.ROS` as sibling checkouts. Source your ROS installation and any custom message workspace, then run in `KinopioHub.ROS`:

```sh
python3 -m venv --system-site-packages .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e ../KinopioHub.py -e .
cp config.example.yaml config.yaml
# Edit config.yaml before starting.
kinopio-hub-ros --config config.yaml --check-config
kinopio-hub-ros --config config.yaml
```

ROS supplies `rclpy`, `rosidl_runtime_py` and message packages. YAML is loaded at startup; restart after changing it. ROS 1, Action forwarding and WS/WSS are not supported.

<a id="chapter-2"></a>
## Select outbound topics

```yaml
hub:
  namespace: robot01
topics:
  - /battery
  - topic: /odom
    type: nav_msgs/msg/Odometry
    max_hz: 10
```

Set `hub.namespace` to the namespace used by the controller. Omission generates a UUID, exposed in SDK status. `/battery` becomes `hub.var("/battery")`. The bridge discovers omitted message types from ROS, including publishers that appear later. Only listed topics are synchronized.

| Optional route field | Meaning |
| --- | --- |
| `type` | Explicit `package/msg/Message` type |
| `variable` | Override the cloud-variable name |
| `field` | Select one field or a dotted nested path |
| `max_hz` | Keep the latest sample within each rate interval; omitted means no extra cap |
| `qos` | `depth`, `reliability` (`best_effort` / `reliable`), `durability` (`volatile` / `transient_local`) |

Default subscriptions accommodate best-effort sensor publishers. Each route retains the latest pending sample instead of accumulating an unbounded queue.

> **Note:** YAML configures the bridge; it is not the data source. ROS messages are converted to JSON values. For example, `std_msgs/msg/String` becomes `{"data":"hello"}`. Reverse JSON controls become new ROS messages, not edits to messages already published.

<a id="chapter-3"></a>
## Connect to TLS NATS

Add this to the same YAML:

```yaml
hub:
  namespace: robot01
  servers: [tls://nats.example.com:4222]
  tls:
    ca_file: ./certs/ca.pem
    handshake_first: true
```

Use a real trusted CA file; relative paths resolve from the YAML directory. Set `handshake_first: false` for INFO-then-TLS servers. Mutual TLS uses `cert_file` / `key_file`; authentication uses `token` or `user` / `password`.

Explicit servers default to client-only operation. Omit `hub` to inherit Python's automatic LAN node behavior. Trusted-local `nats://` is supported, and boolean `hub.mesh` / `hub.discovery` can override selection defaults. Controllers must use the same namespace and a connected NATS topology.

<a id="chapter-4"></a>
## Controls

```yaml
controls:
  - topic: /target_mode
    type: std_msgs/msg/String
    mode: state
  - topic: /command
    type: std_msgs/msg/String
    mode: live
    timeout_ms: 300
```

Controls require an explicit message type and a complete JSON message. The bridge creates publishers only for these configured topics, including a topic that did not previously exist. A remote SDK cannot invent an unconfigured topic or change a topic's type. Existing ROS publishers remain independent and may publish into the same topic.

State represents a desired value. From a connected Python Hub:

```python
status = hub.var("_bridge")
await status.ready()
if not isinstance(status.value, dict) or "control_session" not in status.value:
    raise RuntimeError("Bridge status is not available")
await hub.var("control/target_mode").set({
    "session": status.value["control_session"],
    "value": {"data": "manual"},
})
await hub.flush()
```

> **Note:** The bridge rotates `control_session` on connection changes. Old-session state is rejected by default; the newest current-session value waits for a matching ROS subscriber. State has no 300 ms expiry and does not accept `timeout_ms`. Set `apply_existing: true` only for desired state safe to restore: it permits existing values and bypasses the session check. A stale status report can yield a rejected write; fresh reports and application feedback determine whether to try again.

Live is a separate ephemeral channel: `await hub.live("control/command").send({"data": "step"}, timeout=3)`. Each call is independent, even with equal values.

> **Note:** Leases reject old-connection, duplicate, reordered and expired commands; nothing is buffered for offline replay. Use one receiver per channel. `timeout_ms` defaults to 300, and live routes require volatile durability.

The bridge supports at most 32 live routes and a 32-command queue; overload drops older work. Payloads are limited to 64 KiB. Custom/nested messages require their ROS packages; unknown/missing fields, invalid ranges and nonfinite or unsafe integer-valued numbers are rejected.

> **Note:** `_bridge` reports route counters, errors and the control session; SDK instance health is separate. `send()` / `flush()` confirm transport, not robot execution. A robot that must stop on lost commands needs a local controller watchdog and explicit result reporting.

The repository's [configuration](https://github.com/skyboooox/KinopioHub.ROS/blob/main/config.example.yaml) and [controller](https://github.com/skyboooox/KinopioHub.ROS/blob/main/examples/controller.py) demonstrate matching routes. Docker verification commands are in [Development](development.md#ros-docker).

## Events and typed services

Use `events` for FIFO messages and `services` for complete typed ROS request/response forwarding. Outbound event direction defaults to `ros_to_nats` and can discover one ROS message type; inbound event types, service types and service directions remain explicit. Events never replace state/live controls or replay offline. See [the complete YAML schema and failure boundaries](ros-config.md#events-and-services) and [message semantics](messaging.md).

```yaml
events:
  - ros_topic: /diagnostics_event
    channel: robot.diagnostics
services:
  - ros_service: /enable_sensor
    type: std_srvs/srv/SetBool
    channel: robot.sensor.enable
    direction: nats_to_ros
```

An SDK peer subscribes with `await hub.var("robot.diagnostics").sub(callback)` and calls the service with `await hub.var("robot.sensor.enable").req({"data": True})`. ROS service clients must bound their waits: backend failures produce no fabricated typed response. Native futures keep the executor and asyncio worker independent while messages and accepted service work remain bounded.

For local Docker checks, `node KinopioHub.ROS/docker/check.mjs test jazzy --source` mounts current ROS/Python source read-only over a cached ROS runtime and reports `codeMode: source-overlay`. Omit `--source` after building the image to verify its installed packages. Source overlays preserve the image's compiled custom message interfaces; interface changes require a rebuild.
