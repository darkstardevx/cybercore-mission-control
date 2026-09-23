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
listing, heartbeat history, audit retrieval, and a project event-channel interface. Registration and
status transitions are published after their durable write. The dashboard derives a stale state from
the last observed heartbeat after 90 seconds without mutating D1. R2 artifact storage and the Rust
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

The authenticated heartbeat-history route is project-scoped. A live `agent.registered` event carries
enough metadata for connected dashboards to add the agent without refresh; `agent.status_changed`
events carry the previous and current machine status. The event channel remains observation-only.

Agent registration is available only from the authenticated operator dashboard. The returned
connector credential is rendered once in the current page and is not written to local storage,
application state persistence, or server-side logs.

## Failure behavior

Invalid credentials, unknown resources, stale/future observations, oversized payloads, and replayed
nonces fail closed. Live event delivery can fail without invalidating a committed D1 write.
