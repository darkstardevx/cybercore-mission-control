# Cybercore Mission Control

Private observation plane for the Cybercore ecosystem.

Mission Control records projects, machines, agents, heartbeats, runs, and audit events while keeping
execution authority local. It is a Cloudflare Workers application with a D1 durable state layer,
a Durable Object live-event channel, and a static dashboard.

## Status

P3-M003 release candidate hardening — alpha observation plane. The connector is packaged and
checksummed for supported platforms, but this is still not a production control plane.

## Local development

Requirements: Node.js 20+, npm, and Wrangler.

```sh
npm install
npm run db:migrations:local
npm run dev
```

Open the URL Wrangler prints. The dashboard starts with a safe demo snapshot until an operator
connects a token. Use the **operator token** field to load live projects, agent status, heartbeat
counts, and durable audit events; the token is kept in browser local storage for that browser and
can be cleared with **Disconnect**. To use the API locally, set an admin token in `.dev.vars`:

```text
ADMIN_TOKEN=replace-with-a-local-token
```

Use that value as the `x-mission-control-admin` header. Never commit `.dev.vars`.

The deployed staging dashboard is protected by Cloudflare Access and still requires the Mission
Control `ADMIN_TOKEN` to read operator data. Access authenticates the human; the application token
authorizes the dashboard API. No token is bundled into the static assets.

After connecting, the dashboard exposes a small operator bootstrap form when the database has no
projects. Create the first project there; agent registration and heartbeat traffic then populate
the live agent and audit panels through the connector API. Selecting an agent opens its recent
heartbeat history. The dashboard marks agents stale after 90 seconds without a heartbeat; this is a
derived view state and does not change durable machine state.

## Experimental Rust connector

The outbound-only `cybercore-agent` connector sends one bounded heartbeat at a time. It cannot
receive commands, open a listener, edit local files, or change AgentForge state. Build and test it
with:

```sh
cargo test --locked
cargo run --locked -p cybercore-agent -- --config connector/example-config.json once
```

Before running it, copy the example configuration, set a real Mission Control endpoint and agent
ID, and provide the one-time credential through either an environment variable or an owner-only
credential file. Non-loopback endpoints must use HTTPS. The periodic `run` mode has bounded
timeouts/retries and can be stopped with the normal process interrupt; no cloud response is treated
as an instruction. See [connector setup](connector/README.md) and [the connector protocol](docs/CONNECTOR_PROTOCOL.md).

## API foundation

```text
GET  /api/health
POST /api/projects
GET  /api/projects
GET  /api/projects/:id
POST /api/agents/register
GET  /api/projects/:id/agents
GET  /api/projects/:id/agents/:agent_id/heartbeats
GET  /api/projects/:id/audit
POST /api/agents/:id/heartbeat
GET  /api/projects/:id/events
```

Admin routes require `x-mission-control-admin`. Agent heartbeats require the scoped Bearer
credential returned once by agent registration. Project event streams publish `agent.registered`,
`agent.heartbeat`, and `agent.status_changed` notifications. See [the connector protocol](docs/CONNECTOR_PROTOCOL.md).

## Cloudflare setup

Create a D1 database, update the production database ID in `wrangler.jsonc`, and set the
`ADMIN_TOKEN` secret before deployment:

```sh
npx wrangler d1 create cybercore-mission-control
npx wrangler secret put ADMIN_TOKEN
npm run db:migrations:remote
npm run deploy
```

Before any non-local operation, run the read-only environment preflight and staging dry run:

```sh
npm run preflight
npm run test:preflight
npm run test:protocol
npx wrangler deploy --env=staging --dry-run
npm run smoke:local
```

The staging and production Wrangler environments intentionally contain database-ID placeholders.
Production also requires explicit `--allow-production` acknowledgement. The full deployment
boundary, required secret names, rollback procedure, and Cloudflare Access requirement are in
[deployment readiness](docs/DEPLOYMENT.md). No production account IDs, credentials, or private
reports belong in this repository.

After the GitHub `staging` environment is configured and protected, pushes to `main` deploy the
staging Worker automatically after the full CI matrix passes and an environment approval is granted.
The deployment does not apply D1 migrations; those remain a deliberate operator step.

## Boundaries

Mission Control is an observation plane. It does not execute shell commands, open inbound ports on
operator machines, or replace AgentForge's local task/audit authority. Accepted heartbeats and audit
events are durable; live event delivery is a convenience view.

- [Architecture](docs/ARCHITECTURE.md)
- [Security boundary](docs/SECURITY.md)
- [Connector protocol](docs/CONNECTOR_PROTOCOL.md)
- [Release policy](docs/RELEASE.md)
- [Deployment readiness](docs/DEPLOYMENT.md)
- [Changelog](CHANGELOG.md)

## License

MIT
