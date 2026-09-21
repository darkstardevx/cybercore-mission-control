# Changelog

## Unreleased

### Release candidate hardening

- Version/build provenance output and cooperative Ctrl-C shutdown for periodic mode.
- MIT license, release policy, package metadata, multi-platform CI, and tag-gated checksum artifacts.

### Added

- P3-M001 Mission Control foundation scaffold.
- P3-M002 Rust `cybercore-agent` connector with one-shot and bounded periodic
  heartbeat publishing.
- Locked connector configuration, credential-source, HTTPS, payload, nonce, timestamp, and retry
  validation with loopback protocol fixtures.
- Rust connector and Worker type-check jobs in GitHub Actions.
- D1 schema for projects, machines, agents, heartbeats, runs, and audit events.
- Authenticated project, registration, heartbeat, listing, and audit API boundaries.
- Project-scoped Durable Object live-event interface.
- Demo dashboard shell and local development documentation.

### Security

- Bounded JSON bodies and heartbeat payloads.
- Stale/future timestamp rejection.
- Per-agent credential hashing and nonce replay rejection.
- Observation-only boundary; no remote command execution.
- Connector credentials are redacted, owner-permission checked on Unix, and never forwarded across
  redirects; no inbound listener or command channel is present.
