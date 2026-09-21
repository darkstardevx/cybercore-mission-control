# Mission Control architecture

## Request path

```text
Dashboard -> Worker API -> D1
                         \-> Durable Object event channel
Local connector -> authenticated Worker API -> D1 audit/state
```

D1 is the durable source of truth. A successful write records its audit event before publishing a
best-effort live notification through the project-scoped Durable Object. A disconnected dashboard
does not lose state.

## Current boundary

P3-M001 implements project creation, agent registration, heartbeat ingestion, project/agent
listing, audit retrieval, and a project event-channel interface. R2 artifact storage and the Rust
connector are follow-on milestones.

Cloudflare Access protects the initial private dashboard. Application-level multi-user roles and
public authentication are intentionally deferred.

## Data ownership

- `projects` owns operator-visible project identity.
- `machines` owns a machine's latest observation state.
- `agents` owns connector identity, scopes, and a one-way credential hash.
- `heartbeats` owns replay-protected observations.
- `audit_events` owns the durable history of accepted mutations.
- Durable Objects only coordinate live subscribers; they do not replace D1.

## Failure behavior

Invalid credentials, unknown resources, stale/future observations, oversized payloads, and replayed
nonces fail closed. Live event delivery can fail without invalidating a committed D1 write.
