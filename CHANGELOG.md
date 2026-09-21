# Changelog

## Unreleased

### Added

- P3-M001 Mission Control foundation scaffold.
- D1 schema for projects, machines, agents, heartbeats, runs, and audit events.
- Authenticated project, registration, heartbeat, listing, and audit API boundaries.
- Project-scoped Durable Object live-event interface.
- Demo dashboard shell and local development documentation.

### Security

- Bounded JSON bodies and heartbeat payloads.
- Stale/future timestamp rejection.
- Per-agent credential hashing and nonce replay rejection.
- Observation-only boundary; no remote command execution.
