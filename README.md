# Cybercore Mission Control

Private observation plane for the Cybercore ecosystem.

Mission Control records projects, machines, agents, heartbeats, runs, and audit events while keeping
execution authority local. It is a Cloudflare Workers application with a D1 durable state layer,
a Durable Object live-event channel, and a static dashboard.

## Status

P3-M001 foundation — alpha, local/demo ready. This is not a production control plane yet.

## Local development

Requirements: Node.js 20+, npm, and Wrangler.

```sh
npm install
npm run db:migrations:local
npm run dev
```

Open the URL Wrangler prints. The dashboard intentionally starts in demo mode. To use the API
locally, set an admin token in `.dev.vars`:

```text
ADMIN_TOKEN=replace-with-a-local-token
```

Use that value as the `x-mission-control-admin` header. Never commit `.dev.vars`.

## API foundation

```text
GET  /api/health
POST /api/projects
GET  /api/projects
GET  /api/projects/:id
POST /api/agents/register
GET  /api/projects/:id/agents
GET  /api/projects/:id/audit
POST /api/agents/:id/heartbeat
GET  /api/projects/:id/events
```

Admin routes require `x-mission-control-admin`. Agent heartbeats require the scoped Bearer
credential returned once by agent registration. See [the connector protocol](docs/CONNECTOR_PROTOCOL.md).

## Cloudflare setup

Create a D1 database, update the production database ID in `wrangler.jsonc`, and set the
`ADMIN_TOKEN` secret before deployment:

```sh
npx wrangler d1 create cybercore-mission-control
npx wrangler secret put ADMIN_TOKEN
npm run db:migrations:remote
npm run deploy
```

The initial dashboard should remain private behind Cloudflare Access. No production account IDs,
credentials, or private reports belong in this repository.

## Boundaries

Mission Control is an observation plane. It does not execute shell commands, open inbound ports on
operator machines, or replace AgentForge's local task/audit authority. Accepted heartbeats and audit
events are durable; live event delivery is a convenience view.

- [Architecture](docs/ARCHITECTURE.md)
- [Security boundary](docs/SECURITY.md)
- [Connector protocol](docs/CONNECTOR_PROTOCOL.md)
- [Changelog](CHANGELOG.md)

## License

MIT
