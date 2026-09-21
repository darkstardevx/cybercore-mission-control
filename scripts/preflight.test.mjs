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

console.log("preflight tests passed");
