# Connector protocol v1

The future Rust connector sends an authenticated HTTPS request to Mission Control. The connector
does not receive execution authority.

## Registration

An operator creates an agent through `POST /api/agents/register` using the admin boundary. The
response returns a credential exactly once. The connector stores it locally and sends it as:

```http
Authorization: Bearer mc_<scoped-credential>
Content-Type: application/json
```

The server stores only the SHA-256 credential hash.

## Heartbeat

```json
{
  "nonce": "connector-unique-value",
  "observed_at": "2026-09-21T12:00:00.000Z",
  "status": "online",
  "payload": {
    "platform": "linux",
    "tool_versions": {
      "agentforge": "0.0.1"
    }
  }
}
```

The current boundary accepts a heartbeat that is no more than five minutes old and no more than
thirty seconds in the future. The nonce is unique per agent and cannot be reused. The payload is
bounded to 16 KiB. Future protocol versions must add a version field and preserve unknown-field
tolerance.

Raw command output, credentials, filesystem contents, and full hardware telemetry must not be sent
unless a future explicitly scoped report capability permits it.

## Rust connector behavior

The experimental `cybercore-agent` package implements this contract as an outbound-only client:

- `once` publishes exactly one heartbeat; `run` repeats at the configured bounded interval.
- The connector generates a 128-bit OS-random nonce and a UTC millisecond timestamp for every
  request. It never reuses a caller-provided nonce.
- Payloads, timeouts, retry count, retry delay, and configuration strings are bounded locally
  before any request is sent. Only transient transport failures and HTTP 408/425/429/5xx responses
  are retried; authentication and protocol failures fail closed.
- HTTPS is required except for loopback HTTP test fixtures. Redirects are disabled so credentials
  cannot be forwarded to another origin.
- Credentials are loaded from an explicit environment variable or owner-only file and are never
  printed. The connector does not open an inbound socket or interpret response bodies as commands.

The connector is experimental and does not imply production support, automatic enrollment, or
release compatibility. Register an agent through the admin API first; the returned credential is
shown once and must be stored locally with restricted permissions.
