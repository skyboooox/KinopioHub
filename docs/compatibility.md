# Compatibility policy

Each repository versions and releases independently. Compatibility is expressed as tested release ranges rather than a single repository-wide version.

## Matrix

| Component | Compatible NATS Server | Protocol profile | Status |
| --- | --- | --- | --- |
| KinopioHub.JS | To be established by integration tests | Core scoped messaging | Active |
| KinopioHub.py | To be established by integration tests | Core scoped messaging | Active |
| KinopioHub.ROS | To be established by integration tests | ROS bridge envelopes | Active |
| KinopioHub.web | Follows KinopioHub.JS compatibility | Browser debugger | Active |
| KinopioHub.ino | To be established by integration tests | JSON/NATS Core | Active |
| KinopioHub.cpp | To be established by integration tests | Core scoped messaging | Active |
| Kinopio-server | Downstream of NATS Server; track by tag and commit | Server runtime | Active fork |

Do not replace “to be established” with assumptions. Add a range only after the combination has passed a repeatable integration test, and record the exact component versions or commit hashes used.

## Change classification

- Patch: implementation fix without protocol-visible behavior changes.
- Minor: backward-compatible capability or optional envelope field.
- Major: incompatible subject, payload, discovery, authentication, or request/reply behavior.

Cross-language behavior changes must be documented here before all affected implementations are described as compatible.
