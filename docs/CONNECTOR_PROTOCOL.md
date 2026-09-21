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
