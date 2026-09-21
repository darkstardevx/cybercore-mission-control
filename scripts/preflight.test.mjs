import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc, validatePreflight } from "./preflight.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const config = parseJsonc(await readFile(resolve(root, "wrangler.jsonc"), "utf8"));
const local = validatePreflight(config, { environment: "local", allowProduction: false });
assert.match(local, /disposable/);

assert.throws(
  () => validatePreflight(config, { environment: "preview", allowProduction: false }),
  /unsupported environment/,
);

assert.throws(
  () => validatePreflight(config, { environment: "staging", allowProduction: false }),
  /database_id is still a placeholder/,
);

const configured = structuredClone(config);
configured.env.staging.d1_databases[0].database_id = "11111111-1111-1111-1111-111111111111";
configured.env.production.d1_databases[0].database_id = "22222222-2222-2222-2222-222222222222";
const deploymentEnvironment = {
  CLOUDFLARE_ACCOUNT_ID: "account-id-is-not-printed",
  ADMIN_TOKEN: "secret-is-not-printed",
  CYBERCORE_DEPLOY_APPROVED: "yes",
};
assert.match(validatePreflight(configured, { environment: "staging", allowProduction: false }, deploymentEnvironment), /staging configuration is complete/);
assert.throws(
  () => validatePreflight(configured, { environment: "production", allowProduction: false }, deploymentEnvironment),
  /requires --allow-production/,
);
assert.match(validatePreflight(configured, { environment: "production", allowProduction: true }, deploymentEnvironment), /production configuration is complete/);

console.log("preflight tests passed");
