#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER_CONFIG = resolve(ROOT, "wrangler.jsonc");
const PLACEHOLDER_DATABASE_ID = /^(0{8}-0{4}-0{4}-0{4}-0{12}|REPLACE_WITH_[A-Z0-9_]+)$/;

function usage() {
  console.log(`Usage: node scripts/preflight.mjs [options]

Options:
  --environment <local|staging|production>  target environment (default: local)
  --allow-production                       acknowledge production preflight explicitly
  --help                                   show this message

The preflight is read-only. It never deploys, changes D1, or prints secret values.`);
}

function fail(message) {
  console.error(`preflight failed: ${message}`);
  process.exitCode = 1;
}

export function parseJsonc(source) {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments.replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(withoutLineComments.replace(/,\s*([}\]])/g, "$1"));
}

function args(argv) {
  const options = { environment: "local", allowProduction: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help") {
      usage();
      process.exit(0);
    }
    if (value === "--allow-production") {
      options.allowProduction = true;
      continue;
    }
    if (value === "--environment") {
      options.environment = argv[++index] ?? "";
      continue;
    }
    throw new Error(`unknown option: ${value}`);
  }
  return options;
}

function requiredEnvironmentVariable(name, environment, environmentValues) {
  if (!environmentValues[name]?.trim()) {
    throw new Error(`${name} is required for ${environment} preflight (value is never displayed)`);
  }
}

export function validatePreflight(config, options, environmentValues = process.env) {
  const allowed = new Set(["local", "staging", "production"]);
  if (!allowed.has(options.environment)) throw new Error(`unsupported environment: ${options.environment}`);

  const selected = options.environment === "local" ? config : config.env?.[options.environment];
  if (!selected) throw new Error(`wrangler configuration is missing environment: ${options.environment}`);
  if (selected.vars?.ENVIRONMENT !== options.environment) {
    throw new Error(`ENVIRONMENT must equal ${options.environment}`);
  }

  const database = selected.d1_databases?.find((entry) => entry.binding === "MISSION_CONTROL_DB");
  if (!database) throw new Error("MISSION_CONTROL_DB binding is missing");
  if (!database.database_name || !database.migrations_dir) {
    throw new Error("MISSION_CONTROL_DB must declare database_name and migrations_dir");
  }

  if (options.environment === "local") {
    if (!PLACEHOLDER_DATABASE_ID.test(database.database_id)) {
      throw new Error("local database_id must remain a documented placeholder");
    }
    return "local configuration is disposable and uses no deployment credentials";
  }

  if (PLACEHOLDER_DATABASE_ID.test(database.database_id)) {
    throw new Error(`${options.environment} database_id is still a placeholder`);
  }
  requiredEnvironmentVariable("CLOUDFLARE_ACCOUNT_ID", options.environment, environmentValues);
  requiredEnvironmentVariable("ADMIN_TOKEN", options.environment, environmentValues);
  if (environmentValues.CYBERCORE_DEPLOY_APPROVED !== "yes") {
    throw new Error("CYBERCORE_DEPLOY_APPROVED=yes is required for an explicit deployment approval");
  }
  if (options.environment === "production" && !options.allowProduction) {
    throw new Error("production requires --allow-production in addition to explicit approval");
  }

  return `${options.environment} configuration is complete; deployment remains a separate operator action`;
}

async function main() {
  const options = args(process.argv.slice(2));
  const config = parseJsonc(await readFile(WRANGLER_CONFIG, "utf8"));
  const result = validatePreflight(config, options);
  console.log(options.environment === "local"
    ? "preflight ok: local configuration is disposable and uses no deployment credentials"
    : `preflight ok: ${result}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
