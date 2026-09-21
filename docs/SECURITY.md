# Security boundary

Mission Control starts as a private, single-operator observation service.

## Explicit constraints

- Agents connect outbound over HTTPS; Mission Control never opens a port on the operator's machine.
- No endpoint launches commands, edits files, manages worktrees, or changes local task state.
- Agent credentials are scoped and stored only as SHA-256 hashes.
- Heartbeats are versioned by the connector contract, bounded in size, and rejected when stale,
  too far in the future, or replayed by nonce.
- Sensitive system values are opt-in and should be redacted before upload.
- The dashboard should be placed behind Cloudflare Access before any real data is used.
- Production secrets are Wrangler secrets, never repository variables or committed files.
- The experimental Rust connector accepts credentials only from an explicit environment variable
  or owner-only credential file; it rejects unsafe Unix file permissions and never logs the value.
- Connector redirects are disabled, non-loopback HTTP is rejected, and retry behavior is bounded.

## Deployment readiness

P3-M004 adds fail-closed local/staging/production configuration preflight and a staging binding
dry-run. The preflight never prints secret values and requires explicit approval markers before a
non-local deployment path can proceed. A real deployment still requires Cloudflare Access, deliberate
migration review, Wrangler-managed secrets, rate limiting for heartbeat and admin routes, and an
operator-recorded smoke check. See
[deployment readiness](DEPLOYMENT.md).

The protocol suite and disposable smoke harness cover malformed JSON, bounded fields and payloads,
invalid heartbeat status, stale/future timestamps, missing or mismatched credentials, and nonce
replay. These checks remain observation-only; they do not create a command or control channel.
The live project event channel requires the same admin token through the `mc-admin.<token>`
WebSocket subprotocol and never accepts client-to-server commands.

## Current limitations

P3-M003 does not yet implement key rotation, multi-user roles, rate limits, report uploads, or
automated anomaly detection. Those require separate threat-modelled milestones. The connector
release candidate is still not a production control plane and should use synthetic/local
credentials until deployment hardening is complete.
