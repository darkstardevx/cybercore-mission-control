# Deployment readiness

Mission Control uses three explicit Wrangler environments:

| Environment | Purpose | Deployment posture |
| --- | --- | --- |
| `local` | Disposable D1/Worker development | Safe default; no Cloudflare credentials required |
| `staging` | Synthetic or non-production validation | Requires an explicit approval gate and staging bindings |
| `production` | Real operator data | Deliberately blocked until reviewed and explicitly acknowledged |

## Preflight

Run the read-only local check from a clean checkout:

```sh
npm ci
npm run preflight
npm run test:preflight
```

Staging and production preflight never prints secret values and requires all of the following in
the process environment:

- `CLOUDFLARE_ACCOUNT_ID`;
- `ADMIN_TOKEN`; and
- `CYBERCORE_DEPLOY_APPROVED=yes`.

Production additionally requires the explicit `--allow-production` flag:

```sh
node scripts/preflight.mjs --environment staging
node scripts/preflight.mjs --environment production --allow-production
```

The committed staging and production database IDs are intentional placeholders. Replace them only
in a private, reviewed deployment configuration or through the approved environment mechanism; do
not commit account IDs, tokens, `.dev.vars`, or `.env` files.

## Dry run

Validate the selected Worker bindings without deploying:

```sh
npx wrangler deploy --env=staging --dry-run
```

The dry run must show the `PROJECT_EVENTS` Durable Object, the selected D1 binding, assets, and the
matching `ENVIRONMENT` variable. A dry run is not evidence that migrations or secrets are safe to
apply; those remain explicit operator steps.

For a reviewed, non-mutating staging check, manually dispatch the `Staging dry run` workflow and
enter `STAGING_DRY_RUN`. The workflow is attached to the protected `staging` environment and only
performs the same preflight, protocol tests, and Wrangler binding dry run. It has no production
deployment step and never selects the `production` Wrangler environment.

## Disposable local smoke

The end-to-end smoke command creates a temporary local D1/Worker state directory, applies migrations,
starts a loopback Worker, verifies admin and agent authentication, registers an agent, accepts one
heartbeat, rejects its replayed nonce, confirms durable audit events, and shuts the Worker down.

```sh
npm run smoke:local
```

The smoke state is removed on exit and never contacts Cloudflare. Run it from a local operator
terminal or a dedicated integration runner; the cross-platform CI job intentionally stops at the
deterministic Wrangler binding dry run and does not own a long-lived local dev process.

The focused protocol suite can run without a Worker process:

```sh
npm run test:protocol
```

## Deployment boundary

This milestone does not deploy Cloudflare or create production credentials. Before a real staging
deployment, place the dashboard behind Cloudflare Access, apply migrations deliberately, set the
`ADMIN_TOKEN` as a Wrangler secret, run the end-to-end smoke checks, and record the exact release
and migration evidence. Keep Worker deployment separate from connector release publication.

## Recovery

If validation fails, do not retry with relaxed checks. Preserve the logs, fix the identified
configuration or migration issue, and rerun at the same source revision. For an incident, revoke
the affected admin or agent credential, disable dashboard access, restore the prior verified
connector artifact, and retain the durable audit evidence for review.
