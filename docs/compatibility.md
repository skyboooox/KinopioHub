# Compatibility policy

Each repository versions and releases independently. Compatibility is expressed as tested release ranges rather than a single repository-wide version.

`KinopioHub.JS` is the historical reference implementation for the other language variants. Cross-language parity should be measured against an explicit JavaScript version or commit until a standalone protocol specification defines the behavior instead.

## Server behavior profiles

Compatibility results must distinguish two profiles:

- **Upstream NATS profile:** behavior tested against an unmodified `nats-io/nats-server` release.
- **Kinopio server profile:** behavior tested against `Kinopio-server`, including its modified wildcard subscription logic.

Passing against one profile does not establish compatibility with the other. Any feature that requires the modified wildcard behavior must be labeled as a Kinopio server extension.

## Matrix

| Component | Compatible server/profile | Protocol profile | Status |
| --- | --- | --- | --- |
| KinopioHub.JS | To be established by integration tests | Core scoped messaging | Active |
| KinopioHub.py | To be established by integration tests | Core scoped messaging | Active |
| KinopioHub.ROS | To be established by integration tests | ROS bridge envelopes | Active |
| KinopioHub.web | Follows KinopioHub.JS compatibility | Browser debugger | Active |
| KinopioHub.ino | To be established by integration tests | JSON/NATS Core | Active |
| KinopioHub.cpp | To be established by integration tests | Core scoped messaging | Active |
| Kinopio-server | Track upstream base plus downstream commit | Server runtime with wildcard subscription changes | Active fork |

Do not replace “to be established” with assumptions. Add a range only after the combination has passed a repeatable integration test, and record the exact component versions or commit hashes used.

## Change classification

- Patch: implementation fix without protocol-visible behavior changes.
- Minor: backward-compatible capability or optional envelope field.
- Major: incompatible subject, payload, discovery, authentication, or request/reply behavior.

A change to `Kinopio-server` wildcard matching is protocol-visible and must include upstream-versus-fork regression coverage, even when the public client API does not change.

Cross-language behavior changes must be documented here before all affected implementations are described as compatible.
