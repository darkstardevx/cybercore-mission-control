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
